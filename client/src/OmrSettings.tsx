import { useEffect,useState } from 'react';
import type { DocumentRow } from '../../shared/types';
import { defaultConfig,configSchema,questionCount,type OmrConfig } from '../../shared/omr';
import { apiGet,apiSend,errorMessage } from './api';

type Point={x:number;y:number};
function project(p:Point,c:Point[]){
  const [tl,tr,bl,br]=c;
  return {x:(1-p.y)*((1-p.x)*tl.x+p.x*tr.x)+p.y*((1-p.x)*bl.x+p.x*br.x),y:(1-p.y)*((1-p.x)*tl.y+p.x*tr.y)+p.y*((1-p.x)*bl.y+p.x*br.y)};
}
function unproject(target:Point,c:Point[]):Point{
  let p={x:.5,y:.5};
  for(let i=0;i<20;i++){
    const v=project(p,c),a=project({x:p.x+.0001,y:p.y},c),b=project({x:p.x,y:p.y+.0001},c);
    const ax=(a.x-v.x)/.0001,ay=(a.y-v.y)/.0001,bx=(b.x-v.x)/.0001,by=(b.y-v.y)/.0001,det=ax*by-ay*bx;
    if(Math.abs(det)<1e-8) throw new Error('Referencias inválidas: vuelve a seleccionar las cuatro esquinas.');
    const dx=target.x-v.x,dy=target.y-v.y;
    p={x:p.x+(dx*by-dy*bx)/det,y:p.y+(dy*ax-dx*ay)/det};
  }
  return p;
}
export default function OmrSettings({activityId,documents}:{activityId:number;documents:DocumentRow[]}){
  const [config,setConfig]=useState<OmrConfig>(structuredClone(defaultConfig));
  const [busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[message,setMessage]=useState('');
  const [documentId,setDocumentId]=useState(''),[sample,setSample]=useState(''),[points,setPoints]=useState<Point[]>([]);
  const [block,setBlock]=useState(0),[calibrating,setCalibrating]=useState(false);
  useEffect(()=>{setLoaded(false);void apiGet<OmrConfig>(`/api/activities/${activityId}/omr`).then(c=>{setConfig(c);setLoaded(true);}).catch(e=>setMessage(errorMessage(e)));},[activityId]);
  useEffect(()=>()=>{if(sample) URL.revokeObjectURL(sample);},[sample]);
  const change=(c:OmrConfig)=>{setConfig(c);setMessage('Cambios sin guardar.');};
  const updateTemplate=(template:OmrConfig['template'])=>change({...config,template,key:{},keyConfirmed:false});
  async function save(){
    setBusy(true);setMessage('');
    try{const c=configSchema.parse(config);await apiSend(`/api/activities/${activityId}/omr`,'PUT',c);setMessage('Plantilla, clave y puntuación guardadas para esta actividad.');}
    catch(e){setMessage(errorMessage(e));}finally{setBusy(false);}
  }
  async function extract(){
    setBusy(true);setMessage('');
    try{
      // Extraction uses exactly the template visible in the editor.
      await apiSend(`/api/activities/${activityId}/omr`,'PUT',configSchema.parse({...config,keyConfirmed:false}));
      const r=await apiSend<{key:Record<string,string>;warnings:string[]}>(`/api/activities/${activityId}/omr/extract-key`,'POST',{documentId:Number(documentId)});
      setConfig(c=>({...c,key:r.key,keyConfirmed:false}));
      setMessage(`Propuesta extraída, aún sin confirmar ni guardar. ${r.warnings.join(' ')}`);
    }catch(e){setMessage(errorMessage(e));}finally{setBusy(false);}
  }
  const labels=['cuadrado superior izquierdo','cuadrado superior derecho','cuadrado inferior izquierdo','cuadrado inferior derecho','primera opción de la primera fila del bloque','última opción de la primera fila del bloque','primera opción de la última fila del bloque'];
  function clickImage(p:Point){
    if(!calibrating||busy)return;
    const next=[...points,p];setPoints(next);
    if(next.length===7){
      try{
        if(!(next[0].x<next[1].x&&next[2].x<next[3].x&&next[0].y<next[2].y&&next[1].y<next[3].y)) throw new Error('Orden de referencias inválido.');
        const a=unproject(next[4],next),b=unproject(next[5],next),c=unproject(next[6],next),old=config.template.blocks[block];
        const blocks=config.template.blocks.map((v,i)=>i===block?{...v,x:a.x,y:a.y,dx:(b.x-a.x)/(config.template.options.length-1),dy:(c.y-a.y)/(old.rows-1)}:v);
        const candidate={...config,template:{...config.template,blocks},key:{},keyConfirmed:false};
        configSchema.parse(candidate);change(candidate);setCalibrating(false);setMessage('Bloque calibrado. Comprueba que todos los puntos verdes están dentro de las burbujas antes de guardar.');
      }catch(e){setMessage(errorMessage(e));setPoints([]);}
    }
  }
  if(!loaded)return <section className="card"><p>{message||'Cargando configuración de test…'}</p></section>;
  return <section className="card">
    <h2>Plantilla y corrección de test</h2>
    <p className="small muted">Hojas con cuatro cuadrados negros de referencia. Configura bloques regulares; comprueba cada nueva plantilla sobre una entrega antes de usarla. La nota sigue siendo una previsualización, no una aprobación.</p>
    {message&&<p role="status" className="notice">{message}</p>}
    <fieldset disabled={busy} style={{border:0,padding:0}}>
      <div className="row">
        <label className="field">Nombre de plantilla<input value={config.template.name} onChange={e=>updateTemplate({...config.template,name:e.target.value})}/></label>
        <label className="field">Opciones (p. ej. ABCD)<input value={config.template.options} maxLength={8} onChange={e=>updateTemplate({...config.template,options:e.target.value.toUpperCase()})}/></label>
        <label className="field">Radio interior (fracción entre referencias)<input type="number" min="0.002" max="0.015" step="0.001" value={config.template.radius} onChange={e=>updateTemplate({...config.template,radius:Number(e.target.value)})}/></label>
      </div>
      {config.template.blocks.map((b,i)=><div className="row" key={i}>
        <span>Bloque {i+1} · comienza en {b.first}</span>
        <label className="field">Filas<input type="number" min={2} max={200} value={b.rows} onChange={e=>{
          let first=1;const blocks=config.template.blocks.map((v,j)=>{const rows=j===i?Number(e.target.value):v.rows;const out={...v,rows,first};first+=rows;return out;});updateTemplate({...config.template,blocks});
        }}/></label>
        <button className="btn" disabled={!sample} onClick={()=>{setBlock(i);setPoints([]);setCalibrating(true);}}>Calibrar bloque {i+1}</button>
        {config.template.blocks.length>1&&<button className="btn" onClick={()=>{let first=1;const blocks=config.template.blocks.filter((_,j)=>j!==i).map(v=>{const out={...v,first};first+=v.rows;return out;});updateTemplate({...config.template,blocks});}}>Quitar bloque</button>}
      </div>)}
      <button className="btn" onClick={()=>updateTemplate({...config.template,blocks:[...config.template.blocks,{first:questionCount(config.template)+1,rows:10,x:.1,y:.1,dx:.1,dy:.05}]})}>Añadir bloque</button>
      <label className="field" style={{marginTop:12}}>Foto de ejemplo para calibración (solo local, no se sube)<input type="file" accept="image/*" onChange={e=>{const f=e.target.files?.[0];if(f){setSample(URL.createObjectURL(f));setPoints([]);setCalibrating(false);}}}/></label>
      {sample&&<>
        <p>{calibrating?`Bloque ${block+1}: pulsa el centro de ${labels[points.length]}.`:'Pulsa «Calibrar bloque» para seleccionar referencias y burbujas.'}</p>
        <div style={{position:'relative',maxWidth:900}}>
          <img src={sample} alt="Plantilla de calibración" style={{width:'100%',display:'block'}}/>
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Editor visual: pulsa sobre las referencias indicadas" onClick={e=>{const r=e.currentTarget.getBoundingClientRect();clickImage({x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height});}} style={{position:'absolute',inset:0,width:'100%',height:'100%',cursor:calibrating?'crosshair':'default'}}>
            {points.map((p,i)=><circle key={`p${i}`} cx={p.x} cy={p.y} r=".005" fill="#ef4444"/>)}
            {points.length>=4&&config.template.blocks.flatMap((b,i)=>Array.from({length:Math.min(200,b.rows)},(_,row)=>[...config.template.options].map((_,col)=>{const p=project({x:b.x+col*b.dx,y:b.y+row*b.dy},points);return <circle key={`${i}-${row}-${col}`} cx={p.x} cy={p.y} r=".003" fill="#16a34a"/>;})))}
          </svg>
        </div>
      </>}
      <h3 style={{marginTop:18}}>Puntuación de esta actividad</h3>
      <div className="row">{(['correct','wrong','blank','scale'] as const).map((field,i)=><label className="field" key={field}>{['Acierto','Error (negativo o cero)','En blanco','Escala final'][i]}<input type="number" step="0.01" value={config.scoring[field]} onChange={e=>change({...config,scoring:{...config.scoring,[field]:Number(e.target.value)}})}/></label>)}</div>
      <label><input type="checkbox" checked={config.scoring.floorAtZero} onChange={e=>change({...config,scoring:{...config.scoring,floorAtZero:e.target.checked}})}/> No permitir nota final negativa</label>
      <h3 style={{marginTop:18}}>Clave desde documento de soluciones</h3>
      <select aria-label="Documento de soluciones" value={documentId} onChange={e=>setDocumentId(e.target.value)}><option value="">Selecciona documento</option>{documents.filter(d=>d.kind==='solucion').map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select>
      <button className="btn" disabled={!documentId} onClick={()=>void extract()}>Extraer propuesta con IA</button>
      <p className="small muted">La IA solo extrae soluciones explícitas: no resuelve ni completa preguntas. Revisa la versión del examen y corrige la propuesta.</p>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(95px,1fr))',gap:8}}>
        {Array.from({length:Math.min(200,questionCount(config.template))},(_,i)=>i+1).map(q=><label className="field" key={q}>{q}<select value={config.key[q]??''} onChange={e=>{const key={...config.key};if(e.target.value)key[q]=e.target.value;else delete key[q];change({...config,key,keyConfirmed:false});}}><option value="">Sin clave</option>{[...config.template.options].map(a=><option key={a}>{a}</option>)}</select></label>)}
      </div>
      <label style={{display:'block',marginTop:12}}><input type="checkbox" checked={config.keyConfirmed} onChange={e=>change({...config,keyConfirmed:e.target.checked})}/> He cotejado la clave completa con el documento original.</label>
      <button className="btn primary" style={{marginTop:12}} onClick={()=>void save()}>Guardar configuración de test</button>
    </fieldset>
  </section>;
}
