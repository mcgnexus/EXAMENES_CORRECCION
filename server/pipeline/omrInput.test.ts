import {beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultConfig} from '../../shared/omr';
import type {AppSettings} from '../../shared/types';
const mocks=vi.hoisted(()=>({confirmed:vi.fn(),read:vi.fn()}));
vi.mock('../routes/omr',()=>({confirmedOmrAnswers:mocks.confirmed}));
vi.mock('../storage',()=>({readFileBase64:mocks.read}));
vi.mock('../mappers',()=>({listRubric:async()=>[{id:1,title:'Test',description:'',maxPoints:50}]}));
vi.mock('../db',()=>({db:{prepare:(sql:string)=>({
  get:async()=>sql.includes('FROM submissions')?{id:1,activity_id:2}:{id:2,title:'Test',subject:'biologia',description:''},
  all:async(ownerType:string)=>sql.includes('activity_documents')?[{id:3,kind:'solucion',text:'Solución generada: 1 B'}]:[{stored_path:ownerType==='submission'?'PRIVATE-STUDENT-PHOTO':'REFERENCE-SOLUTION',mime:'image/jpeg',page_no:1}],
})},getSettings:vi.fn(),nowIso:vi.fn()}));
import {buildGradingInput} from './correct';
import {buildSystemPrompt,buildUserPrompt,normalizeModelOutput} from '../llm/prompts';
const settings:AppSettings={primary:{provider:'test',model:'test'},independent:[],divergenceThreshold:1,concurrency:1,includeImages:true,maxPagesPerEvaluation:6};
describe('OMR exclusive answer source',()=>{
  beforeEach(()=>{vi.resetAllMocks();mocks.read.mockResolvedValue('base64');});
  it('never loads or attaches student photos and passes only the confirmed list',async()=>{
    mocks.confirmed.mockResolvedValue({answers:[{question:1,answer:'B'},{question:2,answer:null}],config:defaultConfig});
    const input=await buildGradingInput(1,settings);
    expect(mocks.read).not.toHaveBeenCalledWith('PRIVATE-STUDENT-PHOTO');
    expect(mocks.read).toHaveBeenCalledWith('REFERENCE-SOLUTION');
    expect(input.images.every(i=>!i.label.includes('RESPUESTA DEL ALUMNO'))).toBe(true);
    expect(input.detectedAnswers).toEqual([{question:1,answer:'B'},{question:2,answer:null}]);
    expect(buildUserPrompt(input)).toContain('DETECTOR DE BURBUJAS CONFIRMADO');
    expect(buildSystemPrompt(input)).toContain('NUNCA las interpretes como respuestas del alumno');
    const output=normalizeModelOutput({reading:'El modelo inventa otra lectura',items:[],overallComment:''},input);
    expect(output.reading).toContain('2: [EN BLANCO]');
    expect(output.reading).not.toContain('inventa');
  });
  it('blocks before reading any image if detector confirmation is missing',async()=>{
    mocks.confirmed.mockRejectedValue(new Error('Confirma primero las respuestas'));
    await expect(buildGradingInput(1,settings)).rejects.toThrow('Confirma primero');
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
