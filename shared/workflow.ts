export interface GuideStep { id:string; title:string; detail:string; done:boolean; href:string }
export function nextGuideStep(steps:GuideStep[]){return steps.find(s=>!s.done)??null;}
export function buildActivityGuide(input:{hasClass?:boolean;hasStatement:boolean;hasSolution:boolean;hasRubric:boolean;test:boolean;keyConfirmed:boolean;submissions:{id:number;status:string}[];confirmedIds:number[]}):GuideStep[]{
  const all=input.submissions, missing=all.find(s=>!input.confirmedIds.includes(s.id));
  const unfinished=all.find(s=>!['reviewed','approved','exported'].includes(s.status));
  const unapproved=all.find(s=>!['approved','exported'].includes(s.status));
  return [
    ...(input.hasClass!==undefined?[{id:'class',title:'Asignar la clase y preparar los alumnos',detail:'Selecciona y guarda la clase de esta actividad. Si aún no existe, créala primero en Clases y alumnos.',done:input.hasClass,href:'#activity-meta'}]:[]),
    {id:'documents',title:'Subir el enunciado',detail:'Carga el examen completo y la documentación que deba consultar la IA.',done:input.hasStatement,href:'#activity-documents'},
    {id:'solution',title:'Generar o incorporar la solución',detail:'Genera las respuestas con IA o carga una solución. Revisa el contenido y la versión del examen antes de continuar.',done:input.hasSolution,href:'#activity-documents'},
    {id:'rubric',title:'Revisar y guardar la rúbrica',detail:'Define los apartados y su puntuación. Una propuesta sin guardar no completa este paso.',done:input.hasRubric,href:'#activity-rubric'},
    ...(input.test?[{id:'template',title:'Guardar plantilla, puntuación y clave confirmada',detail:'Calibra la hoja, extrae la clave desde la solución y coteja todas las opciones antes de confirmarla y guardarla.',done:input.keyConfirmed,href:'#activity-omr'}]:[]),
    {id:'submissions',title:'Subir las entregas',detail:'Selecciona al alumno y carga su examen. Puedes añadir más alumnos después.',done:all.length>0,href:'#activity-submissions'},
    ...(input.test?[{id:'detection',title:'Detectar y confirmar las respuestas',detail:'Abre cada entrega, detecta las burbujas, resuelve las dudas y confirma. El LLM no recibe la foto del alumno.',done:all.length>0&&!missing,href:missing?`/submissions/${missing.id}`:'#activity-submissions'}]:[]),
    {id:'correction',title:'Lanzar la corrección',detail:input.test?'Selecciona las entregas confirmadas y lanza la corrección. Se comparará la lista del detector con las soluciones de referencia.':'Selecciona las entregas y lanza la corrección; espera a que termine.',done:all.length>0&&!unfinished,href:'#activity-submissions'},
    {id:'approval',title:'Revisar y aprobar cada nota',detail:'Compara la propuesta con la evidencia y guarda o modifica los comentarios antes de aprobar. Después podrás exportar.',done:all.length>0&&!unapproved,href:unapproved?`/submissions/${unapproved.id}`:'#activity-submissions'},
  ];
}
