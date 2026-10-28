import sharp from 'sharp';
import { defaultTemplate, templateSchema, type OmrTemplate } from '../shared/omr';

export interface BubbleDetection {
  question: number;
  answer: string | null;
  confidence: number;
  state: 'marked' | 'blank' | 'ambiguous';
  scores: number[];
}
type Point = { x: number; y: number };

/** Regular grids anchored to four solid registration squares; fail closed if ambiguous. */
export async function detectAnswerSheet(buffer: Buffer, template:OmrTemplate=defaultTemplate): Promise<BubbleDetection[]> {
  template=templateSchema.parse(template);
  const { data, info } = await sharp(buffer).rotate().resize({ width: 1600, withoutEnlargement: true }).greyscale().normalize().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const visited = new Uint8Array(w * h);
  const squares: Point[] = [];
  for (let y = Math.floor(h * .01); y < h * .99; y++) for (let x = Math.floor(w * .01); x < w * .99; x++) {
    const start = y * w + x;
    if (visited[start] || data[start] > 65) continue;
    const stack = [start]; visited[start] = 1;
    let count = 0, minX = x, maxX = x, minY = y, maxY = y;
    while (stack.length) {
      const p = stack.pop()!; const yy = Math.floor(p / w), xx = p % w;
      count++; minX = Math.min(minX, xx); maxX = Math.max(maxX, xx); minY = Math.min(minY, yy); maxY = Math.max(maxY, yy);
      for (const n of [xx > 0 ? p - 1 : -1, xx < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (n < 0 || n >= data.length || visited[n] || data[n] > 65) continue;
        visited[n] = 1; stack.push(n);
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw > w * .008 && bw < w * .025 && bh > h * .004 && bh < h * .02 && bw / bh > .65 && bw / bh < 1.5 && count / (bw * bh) > .90) {
      squares.push({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
    }
  }
  if (squares.length !== 4) throw new Error(`Plantilla no reconocida: se localizaron ${squares.length} marcas de referencia, se necesitan exactamente cuatro. Usa una foto completa y nítida.`);
  squares.sort((a,b) => a.y - b.y);
  const [tl,tr] = squares.slice(0,2).sort((a,b) => a.x-b.x);
  const [bl,br] = squares.slice(2).sort((a,b) => a.x-b.x);
  if (tr.x - tl.x < w * .4 || bl.y - tl.y < h * .2) throw new Error('Las marcas no forman una hoja válida.');
  const at = (u:number,v:number):Point => ({
    x:(1-v)*((1-u)*tl.x+u*tr.x)+v*((1-u)*bl.x+u*br.x),
    y:(1-v)*((1-u)*tl.y+u*tr.y)+v*((1-u)*bl.y+u*br.y),
  });
  const radius = Math.max(2, Math.round((tr.x-tl.x)*template.radius));
  const fill = (p:Point) => {
    let dark=0,total=0;
    for(let dy=-radius;dy<=radius;dy++) for(let dx=-radius;dx<=radius;dx++) {
      if(dx*dx+dy*dy>radius*radius) continue;
      const x=Math.round(p.x)+dx,y=Math.round(p.y)+dy;
      if(x<0||x>=w||y<0||y>=h) throw new Error('Burbujas fuera de la imagen.');
      total++; if(data[y*w+x]<110) dark++;
    }
    return dark/total;
  };
  return template.blocks.flatMap(block=>Array.from({length:block.rows},(_,row) => {
    const scores=[...template.options].map((_,col) => fill(at(block.x+col*block.dx, block.y+row*block.dy)));
    const sorted=[...scores].sort((a,b)=>b-a), max=sorted[0];
    const state:BubbleDetection['state']=max<.15?'blank':max>=.45&&sorted[1]<.15?'marked':'ambiguous';
    return { question:block.first+row, answer:state==='marked'?template.options[scores.indexOf(max)]:null, state, scores, confidence:state==='ambiguous'?0:state==='blank'?1-max:max-sorted[1] };
  }));
}
