import {describe,it,expect} from 'vitest';
import {buildActivityGuide,nextGuideStep} from '../shared/workflow';
const base={hasStatement:false,hasSolution:false,hasRubric:false,test:true,keyConfirmed:false,submissions:[] as {id:number;status:string}[],confirmedIds:[] as number[]};
describe('guided workflow order',()=>{
  it('starts with the statement, not detection or grading',()=>{
    expect(nextGuideStep(buildActivityGuide(base))?.id).toBe('documents');
  });
  it('requires the confirmed key before uploading and reviewing test submissions',()=>{
    expect(nextGuideStep(buildActivityGuide({...base,hasStatement:true,hasSolution:true,hasRubric:true}))?.id).toBe('template');
  });
  it('points to the next submission whose detector answers are not confirmed',()=>{
    const steps=buildActivityGuide({...base,hasStatement:true,hasSolution:true,hasRubric:true,keyConfirmed:true,submissions:[{id:1,status:'uploaded'},{id:2,status:'uploaded'}],confirmedIds:[1]});
    expect(nextGuideStep(steps)).toMatchObject({id:'detection',href:'/submissions/2'});
  });
  it('does not mark an error or a queued correction as complete',()=>{
    const steps=buildActivityGuide({...base,hasStatement:true,hasSolution:true,hasRubric:true,keyConfirmed:true,submissions:[{id:1,status:'error'}],confirmedIds:[1]});
    expect(nextGuideStep(steps)?.id).toBe('correction');
  });
  it('finishes only when all current submissions are approved or exported',()=>{
    expect(nextGuideStep(buildActivityGuide({...base,hasStatement:true,hasSolution:true,hasRubric:true,keyConfirmed:true,submissions:[{id:1,status:'approved'},{id:2,status:'exported'}],confirmedIds:[1,2]}))).toBeNull();
  });
  it('omits bubble-specific steps for non-test activities',()=>{
    const ids=buildActivityGuide({...base,test:false}).map(s=>s.id);
    expect(ids).not.toContain('template');expect(ids).not.toContain('detection');
  });
});
