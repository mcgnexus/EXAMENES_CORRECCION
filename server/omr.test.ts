import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectAnswerSheet } from './omr';
import type { OmrTemplate } from '../shared/omr';

const expected = '- - - C B A D - - - A C B - A - B - - - - B C A D B C A D B D - B D C A D B A - - B A C - - - C D -'.split(' ').map(x => x === '-' ? null : x);
describe('UAX answer sheet detection', () => {
  it('does not classify a missing circle as an unanswered question',async()=>{
    const photo=await readFile(new URL('./fixtures/answer-sheet-anonymized.png',import.meta.url));
    const meta=await sharp(photo).metadata();
    const mask=Buffer.from(`<svg width="${meta.width}" height="${meta.height}"><rect x="${meta.width!*.21}" y="${meta.height!*.462}" width="${meta.width!*.035}" height="${meta.height!*.026}" fill="white"/></svg>`);
    const image=await sharp(photo).composite([{input:mask}]).png().toBuffer();
    const result=await detectAnswerSheet(image);
    expect(result[0].state).toBe('ambiguous');
    expect(result[0].reason).toContain('localización');
  });
  it('rejects low-resolution images before classification',async()=>{
    const image=await sharp({create:{width:300,height:400,channels:3,background:'#fff'}}).png().toBuffer();
    await expect(detectAnswerSheet(image)).rejects.toThrow('Resolución insuficiente');
  });
  it('reads a custom five-option template independently of the UAX coordinates',async()=>{
    const template:OmrTemplate={name:'Custom 3 x 5',options:'ABCDE',radius:.004,blocks:[{first:1,rows:3,x:.1,y:.1,dx:.15,dy:.2}]};
    const circles=Array.from({length:3},(_,row)=>Array.from({length:5},(_,col)=>`<circle cx="${100+(.1+col*.15)*1000}" cy="${150+(.1+row*.2)*1300}" r="10" stroke="black" stroke-width="2" fill="${(row===0&&col===4)||(row===2&&col===1)?'black':'white'}"/>`).join('')).join('');
    const svg=`<svg width="1200" height="1600"><rect width="1200" height="1600" fill="white"/>${[[100,150],[1100,150],[100,1450],[1100,1450]].map(([x,y])=>`<rect x="${x-9}" y="${y-9}" width="18" height="18" fill="black"/>`).join('')}${circles}</svg>`;
    // References must be in the detector's supported search area (below the header).
    const image=await sharp(Buffer.from(svg)).extend({top:600,bottom:0,left:0,right:0,background:'white'}).png().toBuffer();
    expect((await detectAnswerSheet(image,template)).map(x=>x.answer)).toEqual(['E',null,'B']);
  });
  it('matches all 50 visually verified answers in the example photograph', async () => {
    const photo = await readFile(new URL('./fixtures/answer-sheet-anonymized.png', import.meta.url));
    const result = await detectAnswerSheet(photo);
    expect(result.map(x => x.answer)).toEqual(expected);
    expect(result.filter(x => x.state === 'ambiguous')).toHaveLength(0);
    expect(result.filter(x => x.state === 'marked')).toHaveLength(31);
    expect(result.filter(x => x.state === 'blank')).toHaveLength(19);
  });
  it('keeps the same answers after proportional resizing', async () => {
    const photo = await readFile(new URL('./fixtures/answer-sheet-anonymized.png', import.meta.url));
    const resized = await sharp(photo).resize({width:1200}).toBuffer();
    expect((await detectAnswerSheet(resized)).map(x => x.answer)).toEqual(expected);
  });
  it('rejects images without the four registration marks', async () => {
    const image = await sharp({create:{width:800,height:1000,channels:3,background:'#fff'}}).png().toBuffer();
    await expect(detectAnswerSheet(image)).rejects.toThrow('Plantilla no reconocida');
  });
  it('does not turn a double mark into a selected answer', async () => {
    const photo = await readFile(new URL('./fixtures/answer-sheet-anonymized.png', import.meta.url));
    const meta = await sharp(photo).metadata();
    const x = Math.round(meta.width! * .297), y = Math.round(meta.height! * .524);
    const overlay = Buffer.from(`<svg width="${meta.width}" height="${meta.height}"><circle cx="${x}" cy="${y}" r="17" fill="black"/></svg>`);
    const changed = await sharp(photo).composite([{input:overlay}]).png().toBuffer();
    const result = await detectAnswerSheet(changed);
    expect(result[3].state).toBe('ambiguous');
    expect(result[3].answer).toBeNull();
  });
});
