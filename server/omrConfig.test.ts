import {describe,it,expect} from 'vitest';
import {configSchema,defaultConfig,scoreAnswers,templateSchema} from '../shared/omr';

function fixture(){
  const c=structuredClone(defaultConfig);
  c.template.blocks=[{first:1,rows:3,x:.1,y:.1,dx:.1,dy:.1}];
  c.key={'1':'A','2':'B','3':'C'};c.keyConfirmed=true;
  c.scoring={correct:2,wrong:-.5,blank:0,scale:10,floorAtZero:true};
  return c;
}
describe('OMR configuration and scoring',()=>{
  it('calculates configured raw and scaled points without LLM involvement',()=>{
    expect(scoreAnswers([{question:1,answer:'A'},{question:2,answer:'D'},{question:3,answer:null}],fixture())).toEqual({correct:1,wrong:1,blank:1,raw:1.5,total:2.5,scale:10});
  });
  it('applies the optional zero floor only to the final grade',()=>{
    const c=fixture(),answers=[1,2,3].map(question=>({question,answer:'D'}));
    expect(scoreAnswers(answers,c).total).toBe(0);
    c.scoring.floorAtZero=false;expect(scoreAnswers(answers,c).total).toBe(-2.5);
  });
  it('rejects incomplete or unconfirmed keys',()=>{
    const c=fixture();delete c.key['2'];expect(configSchema.safeParse(c).success).toBe(false);
    c.keyConfirmed=false;expect(()=>scoreAnswers([],c)).toThrow();
  });
  it('rejects duplicate answers, invalid options and missing questions',()=>{
    const c=fixture();
    expect(()=>scoreAnswers([{question:1,answer:'A'},{question:1,answer:'B'},{question:3,answer:null}],c)).toThrow();
    expect(()=>scoreAnswers([{question:1,answer:'H'},{question:2,answer:'B'},{question:3,answer:null}],c)).toThrow();
    expect(()=>scoreAnswers([],c)).toThrow();
  });
  it('rejects overlapping numbering and grids outside registration marks',()=>{
    const c=fixture();c.template.blocks.push({...c.template.blocks[0]});
    expect(templateSchema.safeParse(c.template).success).toBe(false);
    const t=fixture().template;t.blocks[0].dx=.5;
    expect(templateSchema.safeParse(t).success).toBe(false);
  });
});
