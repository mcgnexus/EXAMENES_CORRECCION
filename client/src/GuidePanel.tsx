import {useEffect,useState} from 'react';
import {Link,useLocation} from 'react-router-dom';
import {nextGuideStep,type GuideStep} from '../../shared/workflow';

export default function GuidePanel({steps,onNavigate}:{steps:GuideStep[];onNavigate?:(href:string)=>void}){
  const location=useLocation();
  useEffect(()=>{
    if(!location.hash)return;
    const frame=requestAnimationFrame(()=>{
      const el=document.getElementById(location.hash.slice(1));
      if(el instanceof HTMLDetailsElement)el.open=true;
      el?.scrollIntoView({block:'start'});
    });
    return()=>cancelAnimationFrame(frame);
  },[location.pathname,location.hash]);
  const [enabled,setEnabled]=useState(()=>{try{return localStorage.getItem('examenes:guided')!=='off';}catch{return true;}});
  const next=nextGuideStep(steps);
  return <section className="card" aria-label="Asistente de uso" style={{marginBottom:16}}>
    <label><input type="checkbox" checked={enabled} onChange={e=>{setEnabled(e.target.checked);try{localStorage.setItem('examenes:guided',e.target.checked?'on':'off');}catch{/* preferences are optional */}}}/> Modo guiado</label>
    {enabled&&<>
      <h2 style={{marginTop:10}}>{next?`Siguiente paso: ${next.title}`:'Recorrido completado'}</h2>
      <p>{next?.detail??'Todas las entregas actuales están aprobadas o exportadas. Si añades nuevas entregas, aparecerán los pasos pendientes.'}</p>
      {next&&(next.href.startsWith('#')?<a className="btn primary" href={next.href} onClick={()=>onNavigate?.(next.href)}>Ir al siguiente paso</a>:<Link className="btn primary" to={next.href}>Ir al siguiente paso</Link>)}
      <ol style={{marginTop:14,paddingLeft:24}}>{steps.map(s=><li key={s.id} style={{marginBottom:6}} aria-current={s.id===next?.id?'step':undefined}>
        <span>{s.done?'✓ Completado':s.id===next?.id?'→ Ahora':'Pendiente'}: </span>
        {s.href.startsWith('#')?<a href={s.href} onClick={()=>onNavigate?.(s.href)}>{s.title}</a>:<Link to={s.href}>{s.title}</Link>}
      </li>)}</ol>
      <p className="small muted">La guía comprueba datos guardados; no garantiza que las soluciones sean correctas. Revisar y aprobar sigue siendo responsabilidad del docente.</p>
    </>}
  </section>;
}
