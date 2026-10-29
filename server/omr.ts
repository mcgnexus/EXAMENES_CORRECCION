import sharp from 'sharp';
import {createRequire} from 'node:module';
const cvModule=createRequire(import.meta.url)('@techstark/opencv-js') as Promise<typeof import('@techstark/opencv-js')>;
import {defaultTemplate,templateSchema,type OmrTemplate} from '../shared/omr';

export interface BubbleDetection {
  question:number;answer:string|null;confidence:number;
  state:'marked'|'blank'|'ambiguous';scores:number[];reason?:string;
  circles?:{x:number;y:number;radius:number;located:boolean}[];
}
interface Rendered{data:Buffer;info:{width:number;height:number}}
const preheat=async(buffer:Buffer,enhance:boolean):Promise<Rendered>=>
  enhance
    ? sharp(buffer).rotate().normalise().sharpen({sigma:1}).resize({width:1800,withoutEnlargement:true}).removeAlpha().greyscale().raw().toBuffer({resolveWithObject:true})
    : sharp(buffer).rotate().resize({width:1800,withoutEnlargement:true}).removeAlpha().greyscale().raw().toBuffer({resolveWithObject:true});
/** OpenCV WASM runs server-side; student images are never sent to an LLM. */
export async function detectAnswerSheet(buffer:Buffer,template:OmrTemplate=defaultTemplate):Promise<BubbleDetection[]>{
  template=templateSchema.parse(template);
  const cv=await cvModule;
  const base=await preheat(buffer,false);
  const w=base.info.width,h=base.info.height;
  if(w<700||h<700)throw new Error('Resolución insuficiente: fotografía la hoja completa con mayor nitidez.');
  const allocated:{delete:()=>void}[]=[];
  const keep=<T extends {delete:()=>void}>(v:T):T=>{allocated.push(v);return v;};
  try{
    // Primera pasada sin realce (las fotos correctas no deben cambiar); si no
    // hay exactamente cuatro referencias, se reintenta con realce automático.
    const findMarkers=(image:Rendered)=>{
      const src=keep(cv.matFromArray(h,w,cv.CV_8UC1,image.data));
      const binary=keep(new cv.Mat()),contours=keep(new cv.MatVector()),hierarchy=keep(new cv.Mat());
      cv.threshold(src,binary,0,255,cv.THRESH_BINARY_INV|cv.THRESH_OTSU);
      cv.findContours(binary,contours,hierarchy,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);
      const markers:{x:number;y:number}[]=[];
      for(let i=0;i<contours.size();i++){
        const c=contours.get(i);
        try{const r=cv.boundingRect(c),area=cv.contourArea(c),polygon=new cv.Mat();
          try{cv.approxPolyDP(c,polygon,cv.arcLength(c,true)*.035,true);
          if(polygon.rows===4&&r.width>w*.008&&r.width<w*.03&&r.height>h*.004&&r.height<h*.025&&r.width/r.height>.65&&r.width/r.height<1.5&&area/(r.width*r.height)>.70)markers.push({x:r.x+r.width/2,y:r.y+r.height/2});
          }finally{polygon.delete();}
        }finally{c.delete();}
      }
      return {src,markers};
    };
    const first=findMarkers(base);
    let src=first.src,markers=first.markers;
    // Cuadrilátero de área máxima: con ruido ocasional (una 5ª mancha cuadrada),
    // las cuatro referencias reales forman el mayor rectángulo convexo posible.
    const selectQuad=(points:{x:number;y:number}[])=>{
      if(points.length<4)return null;
      let best:null|{x:number;y:number}[]=null,bestArea=0;
      for(let a=0;a<points.length-3;a++)for(let b=a+1;b<points.length-2;b++)for(let c=b+1;c<points.length-1;c++)for(let d=c+1;d<points.length;d++){
        const quad=[points[a],points[b],points[c],points[d]];
        const cx=quad.reduce((s,p)=>s+p.x,0)/4,cy=quad.reduce((s,p)=>s+p.y,0)/4;
        const ordered=[...quad].sort((p,q)=>Math.atan2(p.y-cy,p.x-cx)-Math.atan2(q.y-cy,q.x-cx));
        let area=0;
        for(let i=0;i<4;i++){const p=ordered[i],q=ordered[(i+1)%4];area+=p.x*q.y-q.x*p.y;}
        area=Math.abs(area)/2;
        if(area>bestArea){bestArea=area;best=ordered;}
      }
      return best;
    };
    const laidOut=(quad:ReturnType<typeof selectQuad>)=>{
      if(!quad)return false;
      const sorted=[...quad].sort((a,b)=>a.y-b.y);
      const [tl,tr]=sorted.slice(0,2).sort((a,b)=>a.x-b.x),[bl,br]=sorted.slice(2).sort((a,b)=>a.x-b.x);
      return tr.x-tl.x>w*.4&&bl.y-tl.y>h*.2&&[tl,tr,bl,br].every(Boolean);
    };
    let quad=laidOut(selectQuad(markers))?selectQuad(markers):null;
    if(!quad){
      const second=findMarkers(await preheat(buffer,true));
      const secondQuad=selectQuad(second.markers);
      if(laidOut(secondQuad)){src=second.src;quad=secondQuad;}
      else throw new Error(`Plantilla no reconocida: ${markers.length} referencias localizadas en lugar de cuatro. Repite la foto o revisa la plantilla.`);
    }
    markers=quad!;
    markers.sort((a,b)=>a.y-b.y);
    const [tl,tr]=markers.slice(0,2).sort((a,b)=>a.x-b.x),[bl,br]=markers.slice(2).sort((a,b)=>a.x-b.x);
    if(tr.x-tl.x<w*.4||bl.y-tl.y<h*.2)throw new Error('Disposición de referencias inválida.');
    const from=keep(cv.matFromArray(4,1,cv.CV_32FC2,[tl.x,tl.y,tr.x,tr.y,bl.x,bl.y,br.x,br.y]));
    const to=keep(cv.matFromArray(4,1,cv.CV_32FC2,[0,0,1000,0,0,1000,1000,1000]));
    const transform=keep(cv.getPerspectiveTransform(from,to)),inverse=keep(cv.getPerspectiveTransform(to,from));
    const rectified=keep(new cv.Mat());
    cv.warpPerspective(src,rectified,transform,new cv.Size(1000,1000),cv.INTER_LINEAR,cv.BORDER_CONSTANT,new cv.Scalar(255));
    const laplacian=keep(new cv.Mat()),mean=keep(new cv.Mat()),deviation=keep(new cv.Mat());
    cv.Laplacian(rectified,laplacian,cv.CV_64F);
    cv.meanStdDev(laplacian,mean,deviation);
    if(deviation.data64F[0]**2<5)throw new Error('La zona de respuestas está desenfocada: repite la fotografía.');
    const adaptive=keep(new cv.Mat()),global=keep(new cv.Mat());
    cv.adaptiveThreshold(rectified,adaptive,255,cv.ADAPTIVE_THRESH_GAUSSIAN_C,cv.THRESH_BINARY_INV,81,7);
    cv.threshold(rectified,global,0,255,cv.THRESH_BINARY_INV|cv.THRESH_OTSU);
    const rings=keep(new cv.MatVector()),rh=keep(new cv.Mat());
    cv.findContours(global,rings,rh,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);
    const candidates:{x:number;y:number;r:number}[]=[];
    for(let i=0;i<rings.size();i++){
      const c=rings.get(i);
      try{
        const b=cv.boundingRect(c),area=cv.contourArea(c),perimeter=cv.arcLength(c,true);
        if(b.width>=10&&b.width<=45&&b.height>=10&&b.height<=45&&b.width/b.height>.6&&b.width/b.height<1.65&&perimeter>0&&4*Math.PI*area/(perimeter*perimeter)>.55)candidates.push({x:b.x+b.width/2,y:b.y+b.height/2,r:Math.min(b.width,b.height)/2});
      }finally{c.delete();}
    }
    const fill=(image:typeof global,x:number,y:number,r:number)=>{
      let n=0,ink=0;
      for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++)if(dx*dx+dy*dy<=r*r){
        const xx=Math.round(x+dx),yy=Math.round(y+dy);
        if(xx<0||xx>=1000||yy<0||yy>=1000)throw new Error('Burbuja fuera de la zona rectificada.');
        n++;if(image.data[yy*1000+xx])ink++;
      }
      return ink/n;
    };
    const back=(x:number,y:number)=>{const m=inverse.data64F,d=m[6]*x+m[7]*y+m[8];return {x:(m[0]*x+m[1]*y+m[2])/d/w,y:(m[3]*x+m[4]*y+m[5])/d/h};};
    const used=new Set<number>();
    return template.blocks.flatMap(b=>Array.from({length:b.rows},(_,row)=>{
      let missing=false,disagreement=false;
      const circles=[...template.options].map((_,col)=>{
        const x=(b.x+col*b.dx)*1000,y=(b.y+row*b.dy)*1000;
        const nearest=candidates.map((c,index)=>({...c,index,d:Math.hypot(c.x-x,c.y-y)})).filter(c=>c.d<12).sort((a,b)=>a.d-b.d)[0];
        const located=!!nearest&&!used.has(nearest.index);
        if(!located)missing=true;else used.add(nearest.index);
        const c=nearest??{x,y,r:template.radius*3000};
        const radius=Math.max(2,Math.floor(Math.min(c.r*.5,template.radius*1000)));
        const score=located?fill(adaptive,c.x,c.y,radius):0;
        const other=located?fill(global,c.x,c.y,radius):0;
        if((score<.15)!==(other<.15)||(score>.5)!==(other>.5))disagreement=true;
        return {...back(c.x,c.y),radius:c.r/1000*(tr.x-tl.x)/w,located,score};
      });
      const scores=circles.map(c=>c.score),sorted=[...scores].sort((a,b)=>b-a);
      const state:BubbleDetection['state']=missing||disagreement?'ambiguous':sorted[0]<.15?'blank':sorted[0]>.5&&sorted[1]<.15?'marked':'ambiguous';
      return {question:b.first+row,answer:state==='marked'?template.options[scores.indexOf(sorted[0])]:null,state,scores,confidence:state==='ambiguous'?0:Math.max(0,sorted[0]-sorted[1]),circles,reason:missing?'Fallo de localización de círculos: recalibra o repite la foto.':state==='ambiguous'?'Marca múltiple, tenue o mediciones contradictorias.':undefined};
    }));
  }finally{for(const m of allocated.reverse())m.delete();}
}
