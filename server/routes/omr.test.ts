import Fastify from 'fastify';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultConfig} from '../../shared/omr';

const mocks=vi.hoisted(()=>({get:vi.fn(),all:vi.fn(),run:vi.fn(),read:vi.fn(),stored:vi.fn()}));
vi.mock('../db',()=>({db:{prepare:()=>({get:mocks.get,all:mocks.all,run:mocks.run})},nowIso:()=>new Date().toISOString(),getSettings:async()=>({primary:{provider:'test',model:'test'},independent:[],maxPagesPerEvaluation:10})}));
vi.mock('../storage',()=>({readFileBase64:mocks.stored}));
vi.mock('../llm/providers',()=>({runProviderRead:mocks.read,runWithModelFailover:async(_p:unknown,_a:unknown,fn:(p:string,m:string)=>Promise<unknown>)=>fn('test','test')}));
import {registerOmrRoutes} from './omr';

describe('OMR settings and proposed answer key API',()=>{
  beforeEach(()=>vi.resetAllMocks());
  it('saves validated configuration associated with an existing activity',async()=>{
    const app=Fastify();await registerOmrRoutes(app);mocks.get.mockResolvedValue({id:1});
    const r=await app.inject({method:'PUT',url:'/api/activities/1/omr',payload:defaultConfig});
    expect(r.statusCode).toBe(200);
    expect(mocks.run.mock.calls[0][0]).toBe(1);
    expect(JSON.parse(mocks.run.mock.calls[0][1])).toEqual(defaultConfig);
    await app.close();
  });
  it('generates the key by having the LLM answer the exam from text only, as an unconfirmed proposal',async()=>{
    const app=Fastify();await registerOmrRoutes(app);
    mocks.get.mockResolvedValueOnce({id:1,subject:'biologia'}).mockResolvedValueOnce({config:defaultConfig});
    mocks.all.mockResolvedValue([{id:3,kind:'enunciado',text:'1. La mitocondria…'},{id:4,kind:'solucion',text:'Referencia 1: A'}]);
    mocks.read.mockResolvedValue({text:'{"answers":[{"question":1,"answer":"A"}],"warnings":["Duda en la 2."]}'});
    const r=await app.inject({method:'POST',url:'/api/activities/1/omr/solve-key',payload:{documentId:4}});
    expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({key:{'1':'A'},keyConfirmed:false});
    expect(r.json().warnings.join(' ')).toContain('Duda en la 2.');
    expect(r.json().warnings.join(' ')).toContain('Faltan 49 respuestas');
    const call=mocks.read.mock.calls[0][2];
    expect(call.images).toEqual([]);
    expect(call.instructions).toContain('clave propuesta');
    expect(call.instructions).toContain('No adivines');
    expect(call.context).toContain('mitocondria');
    expect(call.context).toContain('Referencia 1: A');
    expect(mocks.stored).not.toHaveBeenCalled();
    await app.close();
  });
  it('rejects duplicate answered question numbers instead of silently overwriting them',async()=>{
    const app=Fastify();await registerOmrRoutes(app);
    mocks.get.mockResolvedValueOnce({id:1,subject:'biologia'}).mockResolvedValueOnce({config:defaultConfig});
    mocks.all.mockResolvedValue([{id:3,kind:'enunciado',text:'enunciado'}]);
    mocks.read.mockResolvedValue({text:'{"answers":[{"question":1,"answer":"A"},{"question":1,"answer":"B"}]}'});
    const r=await app.inject({method:'POST',url:'/api/activities/1/omr/solve-key',payload:{}});
    expect(r.statusCode).toBe(400);expect(mocks.run).not.toHaveBeenCalled();await app.close();
  });
  it('refuses to generate a key when the activity has no enunciado text (never reads images)',async()=>{
    const app=Fastify();await registerOmrRoutes(app);
    mocks.get.mockResolvedValueOnce({id:1,subject:'biologia'}).mockResolvedValueOnce({config:defaultConfig});
    mocks.all.mockResolvedValue([{id:3,kind:'enunciado',text:null}]);
    const r=await app.inject({method:'POST',url:'/api/activities/1/omr/solve-key',payload:{}});
    expect(r.statusCode).toBe(400);expect(r.json().message).toContain('no lee imágenes');expect(mocks.read).not.toHaveBeenCalled();await app.close();
  });
  it('refuses an optional solution document not belonging to the activity',async()=>{
    const app=Fastify();await registerOmrRoutes(app);
    mocks.get.mockResolvedValueOnce({id:1,subject:'biologia'}).mockResolvedValueOnce({config:defaultConfig});
    mocks.all.mockResolvedValue([{id:3,kind:'enunciado',text:'enunciado'}]);
    const r=await app.inject({method:'POST',url:'/api/activities/1/omr/solve-key',payload:{documentId:9}});
    expect(r.statusCode).toBe(404);expect(mocks.read).not.toHaveBeenCalled();await app.close();
  });
  it('returns 404 for an unknown activity',async()=>{
    const app=Fastify();await registerOmrRoutes(app);mocks.get.mockResolvedValue(undefined);
    const r=await app.inject({method:'POST',url:'/api/activities/1/omr/solve-key',payload:{}});
    expect(r.statusCode).toBe(404);expect(mocks.read).not.toHaveBeenCalled();await app.close();
  });
});
