import { z } from 'zod';

const coord = z.number().finite().min(0).max(1);
const blockSchema = z.object({first:z.number().int().min(1).max(200), rows:z.number().int().min(2).max(200), x:coord, y:coord, dx:z.number().positive().max(1), dy:z.number().positive().max(1)});
export const templateSchema = z.object({name:z.string().trim().min(1).max(120), options:z.string().regex(/^[A-H]{2,8}$/).refine(s=>new Set(s).size===s.length), blocks:z.array(blockSchema).min(1).max(10), radius:z.number().min(.002).max(.015)}).superRefine((t,ctx)=>{
  const numbers=t.blocks.flatMap(b=>Array.from({length:b.rows},(_,i)=>b.first+i));
  if(numbers.length>200 || new Set(numbers).size!==numbers.length || [...numbers].sort((a,b)=>a-b).some((n,i)=>n!==i+1)) ctx.addIssue({code:'custom',message:'Las preguntas deben ser consecutivas desde 1, sin duplicados (máximo 200).'});
  if(t.blocks.some(b=>b.x+(t.options.length-1)*b.dx>1 || b.y+(b.rows-1)*b.dy>1)) ctx.addIssue({code:'custom',message:'Hay burbujas fuera de las referencias.'});
});
export type OmrTemplate=z.infer<typeof templateSchema>;
export const defaultTemplate:OmrTemplate={name:'UAX 50',options:'ABCD',radius:.004,blocks:[{first:1,rows:25,x:.111,y:.070,dx:.102,dy:.0373},{first:26,rows:25,x:.648,y:.070,dx:.102,dy:.0373}]};
export const scoringSchema=z.object({correct:z.number().finite().positive().max(1000),wrong:z.number().finite().min(-1000).max(0),blank:z.number().finite().min(-1000).max(0),scale:z.number().finite().positive().max(1000),floorAtZero:z.boolean()});
export const configSchema=z.object({template:templateSchema,scoring:scoringSchema,key:z.record(z.string(),z.string().regex(/^[A-H]$/)),keyConfirmed:z.boolean()}).superRefine((c,ctx)=>{
  const count=questionCount(c.template);
  if(Object.entries(c.key).some(([q,a])=>!/^\d+$/.test(q)||String(+q)!==q||+q<1||+q>count||!c.template.options.includes(a))) ctx.addIssue({code:'custom',message:'La clave contiene preguntas u opciones no válidas.'});
  if(c.keyConfirmed && Array.from({length:count},(_,i)=>String(i+1)).some(q=>!c.key[q])) ctx.addIssue({code:'custom',message:'Confirma una clave completa antes de guardar.'});
});
export type OmrConfig=z.infer<typeof configSchema>;
export const defaultConfig:OmrConfig={template:defaultTemplate,scoring:{correct:1,wrong:-.33,blank:0,scale:50,floorAtZero:false},key:{},keyConfirmed:false};
export function questionCount(t:OmrTemplate){return t.blocks.reduce((n,b)=>n+b.rows,0);}
export function scoreAnswers(answers:{question:number;answer:string|null}[],config:OmrConfig,overrides?:Record<string,'correct'|'wrong'>){
  const c=configSchema.parse(config), count=questionCount(c.template);
  if(!c.keyConfirmed || answers.length!==count || new Set(answers.map(a=>a.question)).size!==count || answers.some(a=>!Number.isInteger(a.question)||a.question<1||a.question>count||(a.answer!==null&&(a.answer.length!==1||!c.template.options.includes(a.answer))))) throw new Error('Confirma una clave completa y revisa todas las preguntas únicas.');
  let correct=0,wrong=0,blank=0;
  for(const a of answers){
    const override=overrides?.[String(a.question)];
    const isCorrect = a.answer !== null && a.answer === c.key[String(a.question)];
    const verdict = override ?? (isCorrect ? 'correct' : (a.answer === null ? 'blank' : 'wrong'));
    if(verdict==='correct')correct++; else if(verdict==='wrong')wrong++; else blank++;
  }
  const raw=correct*c.scoring.correct+wrong*c.scoring.wrong+blank*c.scoring.blank;
  const scaled=raw/(count*c.scoring.correct)*c.scoring.scale;
  return {correct,wrong,blank,raw:Math.round(raw*100)/100,total:Math.round((c.scoring.floorAtZero?Math.max(0,scaled):scaled)*100)/100,scale:c.scoring.scale};
}
