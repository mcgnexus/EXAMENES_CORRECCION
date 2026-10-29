import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db,getSettings,nowIso } from '../db';
import { badRequest,notFound } from '../errors';
import { configSchema,defaultConfig,questionCount,scoreAnswers,type OmrConfig } from '../../shared/omr';
import { runProviderRead,runWithModelFailover } from '../llm/providers';
import { buildSolveKeySystemPrompt,buildSolveKeyUserPrompt,extractJsonObject } from '../llm/prompts';

export async function getOmrConfig(activityId:number):Promise<OmrConfig>{
  const row=await db.prepare('SELECT config FROM activity_omr_config WHERE activity_id=$1').get<{config:unknown}>(activityId);
  return configSchema.parse(row?.config ?? structuredClone(defaultConfig));
}
export async function confirmedOmrAnswers(submissionId:number,activityId:number){
  const enabled=await db.prepare('SELECT activity_id FROM activity_omr_config WHERE activity_id=$1').get(activityId);
  if(!enabled)return null;
  const config=await getOmrConfig(activityId);
  const row=await db.prepare('SELECT answers,config,overrides FROM submission_omr_answers WHERE submission_id=$1').get<{answers:{question:number;answer:string|null}[];config:unknown;overrides:Record<string,'correct'|'wrong'>|null}>(submissionId);
  if(!row)throw badRequest('Confirma primero las respuestas del detector de burbujas en la entrega. No se enviará la foto al LLM.');
  if(JSON.stringify(configSchema.parse(row.config))!==JSON.stringify(config))throw badRequest('La plantilla, clave o puntuación ha cambiado. Repite la detección y confirma las respuestas.');
  const overrides=row.overrides??{};
  scoreAnswers(row.answers,config,overrides);
  return {answers:row.answers,config,overrides};
}
export async function registerOmrRoutes(app:FastifyInstance){
  app.get('/api/activities/:id/workflow',async req=>{
    const id=Number((req.params as {id:string}).id);
    if(!await db.prepare('SELECT id FROM activities WHERE id=$1').get(id))throw notFound('Actividad no encontrada');
    const stored=await db.prepare('SELECT config FROM activity_omr_config WHERE activity_id=$1').get<{config:unknown}>(id);
    const rows=await db.prepare('SELECT a.submission_id FROM submission_omr_answers a JOIN submissions s ON s.id=a.submission_id JOIN activity_omr_config c ON c.activity_id=s.activity_id WHERE s.activity_id=$1 AND a.config=c.config').all<{submission_id:number}>(id);
    return {test:!!stored,keyConfirmed:stored?configSchema.parse(stored.config).keyConfirmed:false,confirmedIds:rows.map(r=>r.submission_id)};
  });
  app.get('/api/activities/:id/omr',async req=>{
    const id=Number((req.params as {id:string}).id);
    if(!await db.prepare('SELECT id FROM activities WHERE id=$1').get(id)) throw notFound('Actividad no encontrada');
    return getOmrConfig(id);
  });
  app.put('/api/activities/:id/omr',async req=>{
    const id=Number((req.params as {id:string}).id), config=configSchema.parse(req.body);
    if(!await db.prepare('SELECT id FROM activities WHERE id=$1').get(id)) throw notFound('Actividad no encontrada');
    await db.prepare('INSERT INTO activity_omr_config(activity_id,config,updated_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(activity_id) DO UPDATE SET config=EXCLUDED.config,updated_at=EXCLUDED.updated_at').run(id,JSON.stringify(config),nowIso());
    return config;
  });
  // La clave del test la genera el LLM RESPONDIENDO el examen desde el texto
  // del enunciado: nunca lee imágenes (las respuestas marcadas se detectan
  // solo con OMR en OpenCV) y el resultado es una propuesta sin confirmar.
  app.post('/api/activities/:id/omr/solve-key',async req=>{
    const id=Number((req.params as {id:string}).id);
    const activity=await db.prepare('SELECT id,subject FROM activities WHERE id=$1').get<{id:number;subject:string}>(id);
    if(!activity) throw notFound('Actividad no encontrada');
    const {documentId}=z.object({documentId:z.number().int().positive().optional()}).parse(req.body??{});
    const config=await getOmrConfig(id), settings=await getSettings(), count=questionCount(config.template);
    const docs=await db.prepare('SELECT id,kind,text FROM activity_documents WHERE activity_id=$1 ORDER BY id ASC').all<{id:number;kind:string;text:string|null}>(id);
    const enunciado=docs.filter(d=>d.kind==='enunciado').map(d=>d.text??'').filter(Boolean).join('\n\n');
    if(!enunciado.trim())throw badRequest('La actividad no tiene enunciado en texto: escanea el enunciado para extraer su texto o introduce la clave a mano. La clave generada por IA no lee imágenes.');
    let solucion='';
    if(documentId){
      const doc=docs.find(d=>d.id===documentId&&d.kind==='solucion');
      if(!doc) throw notFound('Selecciona un documento de solución de esta actividad');
      solucion=doc.text??'';
    }
    const result=await runWithModelFailover(settings.primary,settings.independent,(provider,model)=>runProviderRead(provider,model,{
      subject:activity.subject as 'biologia'|'bioquimica',
      images:[],
      instructions:buildSolveKeySystemPrompt(activity.subject,count,config.template.options),
      context:buildSolveKeyUserPrompt(enunciado,solucion,count,config.template.options),
    }));
    const parsed=z.object({answers:z.array(z.object({question:z.number().int().min(1).max(count),answer:z.string().length(1).refine(v=>config.template.options.includes(v))})).max(count),warnings:z.array(z.string()).default([])}).parse(extractJsonObject(result.text));
    if(new Set(parsed.answers.map(a=>a.question)).size!==parsed.answers.length) throw badRequest('El modelo devolvió preguntas duplicadas; revisa el enunciado y repite la generación');
    const missing=count-parsed.answers.length;
    return {key:Object.fromEntries(parsed.answers.map(a=>[a.question,a.answer])),warnings:[...parsed.warnings,...(missing?[`Faltan ${missing} respuestas: complétalas a mano antes de confirmar la clave.`]:[])],keyConfirmed:false};
  });
}
