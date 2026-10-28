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
  it('extracts explicit key entries as an unconfirmed proposal and warns about omissions',async()=>{
    const app=Fastify();await registerOmrRoutes(app);
    mocks.get.mockResolvedValueOnce({id:9,text:'1: A, 2: B'}).mockResolvedValueOnce({config:defaultConfig});
    mocks.all.mockResolvedValue([]);mocks.read.mockResolvedValue({text:'{"answers":[{"question":1,"answer":"A"},{"question":2,"answer":"B"}],"warnings":[]}'});
    const r=await app.inject({method:'POST',url:'/api/activities/1/omr/extract-key',payload:{documentId:9}});
    expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({key:{'1':'A','2':'B'},keyConfirmed:false});
    expect(r.json().warnings[0]).toContain('48');expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.read.mock.calls[0][2].instructions).toContain('No resuelvas');
    await app.close();
  });
  it('rejects duplicate extracted question numbers instead of silently overwriting them',async()=>{
    const app=Fastify();await registerOmrRoutes(app);
    mocks.get.mockResolvedValueOnce({id:9,text:'key'}).mockResolvedValueOnce({config:defaultConfig});mocks.all.mockResolvedValue([]);
    mocks.read.mockResolvedValue({text:'{"answers":[{"question":1,"answer":"A"},{"question":1,"answer":"B"}]}'});
    const r=await app.inject({method:'POST',url:'/api/activities/1/omr/extract-key',payload:{documentId:9}});
    expect(r.statusCode).toBe(400);expect(mocks.run).not.toHaveBeenCalled();await app.close();
  });
  it('refuses a solution document not belonging to the activity',async()=>{
    const app=Fastify();await registerOmrRoutes(app);mocks.get.mockResolvedValue(undefined);
    const r=await app.inject({method:'POST',url:'/api/activities/1/omr/extract-key',payload:{documentId:9}});
    expect(r.statusCode).toBe(404);expect(mocks.read).not.toHaveBeenCalled();await app.close();
  });
});
