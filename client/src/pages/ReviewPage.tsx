import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { EvaluationRow, SubmissionDetail, RubricItem } from '../../../shared/types';
import { apiGet, apiSend, errorMessage, fileUrl } from '../api';
import { questionCount,type OmrConfig } from '../../../shared/omr';
import { CALIBRATION_LABELS,orderedCorners,project,type Point } from '../omrCalib';
import GuidePanel from '../GuidePanel';

interface ItemForm {
  points: number;
  comment: string;
}

interface FormState {
  items: Record<number, ItemForm>;
  overall: string;
}

interface ReadingCheck {
  text: string;
  pages: number;
  totalPages: number;
  provider: string;
  model: string;
}

interface BubbleResult { question: number; answer: string | null; confidence: number; state: 'marked' | 'blank' | 'ambiguous';reason?:string;circles?:{x:number;y:number;radius:number;located:boolean}[] }

const EVAL_STATUS: Record<string, string> = {
  pending: 'Pendiente',
  running: 'Evaluando',
  done: 'Completada',
  error: 'Error',
};

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: 'Borrador',
    approved: 'Aprobada',
    exported: 'Exportada',
  };
  return labels[status] ?? status;
}

export default function ReviewPage() {
  const { id } = useParams();
  const submissionId = Number(id);
  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [readingBusy, setReadingBusy] = useState(false);
  const [readingCheck, setReadingCheck] = useState<ReadingCheck | null>(null);
  const [bubbleBusy, setBubbleBusy] = useState(false);
  const [bubbleAnswers, setBubbleAnswers] = useState<BubbleResult[] | null>(null);
  const [evidenceQuestion,setEvidenceQuestion]=useState<number|null>(null);
  const [answerKey, setAnswerKey] = useState<Record<number, string>>({});
  const [omrConfig,setOmrConfig]=useState<OmrConfig|null>(null);
  const [testWorkflow,setTestWorkflow]=useState<{test:boolean;keyConfirmed:boolean;confirmed:boolean}|null>(null);
  const [bubblesConfirmed, setBubblesConfirmed] = useState(false);
  const [overrides, setOverrides] = useState<Record<number,'correct'|'wrong'>>({});
  const [bubbleGrade, setBubbleGrade] = useState<{correct:number;wrong:number;blank:number;total:number;raw:number;scale:number}|null>(null);
  const [brush, setBrush] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [manualPoints, setManualPoints] = useState<Point[]>([]);
  const [manualSuggest, setManualSuggest] = useState(false);
  const [validationItem, setValidationItem] = useState<RubricItem | null>(null);
  const [validationModel, setValidationModel] = useState<'primary' | 'independent'>('primary');
  const [validationComment, setValidationComment] = useState('');
  const [validationPoints, setValidationPoints] = useState(0);
  const [validated, setValidated] = useState<Set<number>>(new Set());

  const load = async () => {
    const data = await apiGet<SubmissionDetail>(`/api/submissions/${submissionId}`);
    setDetail(data);
    try{
      const progress=await apiGet<{test:boolean;keyConfirmed:boolean;confirmedIds:number[]}>(`/api/activities/${data.activity.id}/workflow`);
      setTestWorkflow({test:progress.test,keyConfirmed:progress.keyConfirmed,confirmed:progress.confirmedIds.includes(submissionId)});
    }catch{setTestWorkflow(null);}
    return data;
  };

  useEffect(() => {
    setDetail(null);
    setForm(null);
    setZoom(1);
    setPage(0);
    setError('');
    setBubblesConfirmed(false);
    setBubbleGrade(null);
    setBubbleAnswers(null);
    setAnswerKey({});
    setOmrConfig(null);
    setTestWorkflow(null);
    setBrush('');
    setManualMode(false);
    setManualPoints([]);
    setManualSuggest(false);
    void load().catch((err) => setError(errorMessage(err)));
  }, [submissionId]);

  useEffect(() => {
    if (!detail) return;
    const items: Record<number, ItemForm> = {};
    const primary = detail.evaluations.find((evaluation) => evaluation.role === 'primary' && evaluation.status === 'done');
    for (const rubricItem of detail.rubric) {
      const graded = detail.grade?.items.find((item) => item.rubricItemId === rubricItem.id);
      const proposed = primary?.items.find((item) => item.rubricItemId === rubricItem.id);
      items[rubricItem.id] = {
        points: graded?.points ?? proposed?.points ?? 0,
        comment: graded?.comment ?? proposed?.comment ?? '',
      };
    }
    setForm({ items, overall: detail.grade?.overallComment ?? primary?.overallComment ?? '' });
  }, [detail?.submission.id, detail?.grade?.updatedAt, detail?.rubric.length]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  async function run(action: () => Promise<void>, message?: string) {
    setBusy(true);
    setError('');
    try {
      await action();
      if (message) setNotice(message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function checkReading() {
    if (readingBusy) return;
    setReadingBusy(true);
    setError('');
    try {
      const result = await apiSend<ReadingCheck>(
        `/api/submissions/${submissionId}/reading-check`,
        'POST',
      );
      setReadingCheck(result);
      setNotice('Lectura del modelo completada. Compárala con las páginas del examen.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReadingBusy(false);
    }
  }

  async function detectBubbles() {
    setBubbleBusy(true);
    setError('');
    setManualSuggest(false);
    try {
      const result = await apiSend<{answers: BubbleResult[];config:OmrConfig}>(`/api/submissions/${submissionId}/detect-bubbles`, 'POST');
      setBubbleAnswers(result.answers);
      setOmrConfig(result.config);
      setAnswerKey(result.config.key);
      setBubblesConfirmed(false);
      setBubbleGrade(null);
      setOverrides({});
      setTestWorkflow(prev=>prev?{...prev,confirmed:false}:prev);
      setNotice('Detección lista. Revisa y corrige cada fila antes de calificar.');
    } catch (err) {
      const message = errorMessage(err);
      if (/Plantilla no reconocida|Disposición de referencias/.test(message)) setManualSuggest(true);
      setError(message);
    }
    finally { setBubbleBusy(false); }
  }

  const invalidateConfirmation = () => {
    setBubblesConfirmed(false);
    setBubbleGrade(null);
    setTestWorkflow(prev => prev ? { ...prev, confirmed: false } : prev);
  };

  function setBubbleAnswer(question: number, value: string | null) {
    invalidateConfirmation();
    setBubbleAnswers(prev => prev?.map(x => x.question === question
      ? { ...x, answer: value, state: value ? 'marked' as const : 'blank' as const }
      : x) ?? null);
  }

  const applyBrush = (question: number) => setBubbleAnswer(question, brush === '' ? null : brush);

  async function startManual() {
    setError('');
    setManualSuggest(false);
    setManualPoints([]);
    try {
      if (!omrConfig) {
        const config = await apiGet<OmrConfig>(`/api/activities/${detail!.activity.id}/omr`);
        setOmrConfig(config);
        setAnswerKey(config.key);
      }
      setBubbleAnswers(null);
      invalidateConfirmation();
      setManualMode(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function manualClick(p: Point) {
    if (!omrConfig || manualPoints.length >= 4) return;
    const next = [...manualPoints, p];
    setManualPoints(next);
    if (next.length < 4) return;
    try {
      const corners = orderedCorners(next);
      const template = omrConfig.template;
      const rows: BubbleResult[] = [];
      for (const block of template.blocks) {
        for (let row = 0; row < block.rows; row++) {
          const circles = [...template.options].map((_, col) => {
            const point = project({ x: block.x + col * block.dx, y: block.y + row * block.dy }, corners);
            return { x: point.x, y: point.y, radius: template.radius, located: true };
          });
          rows.push({ question: block.first + row, answer: null, confidence: 0, state: 'blank', circles });
        }
      }
      setBubbleAnswers(rows);
      invalidateConfirmation();
      setManualMode(false);
      setNotice(`Rejilla manual generada para ${rows.length} preguntas: marca cada respuesta pulsando sobre la foto con el pincel.`);
    } catch (err) {
      setManualPoints([]);
      setError(errorMessage(err));
    }
  }

  async function calculateBubbleGrade() {
    if (!bubbleAnswers || !omrConfig?.keyConfirmed || !bubblesConfirmed || bubbleAnswers.some(x=>x.state==='ambiguous')) return;
    const result = await apiSend<{correct:number; wrong:number; blank:number; total:number;raw:number;scale:number}>(
      `/api/submissions/${submissionId}/grade-bubbles`, 'POST',
      { answers: bubbleAnswers.map(x => ({question:x.question, answer:x.answer})), config:omrConfig, confirmed:true, overrides },
    );
    setBubbleGrade(result);
    setTestWorkflow({test:true,keyConfirmed:true,confirmed:true});
    window.dispatchEvent(new Event('app-workflow-updated'));
  }

  const total = useMemo(() => {
    if (!detail || !form) return 0;
    return Object.values(form.items).reduce((sum, item) => sum + (Number(item.points) || 0), 0);
  }, [detail, form]);

  if (!Number.isFinite(submissionId)) return <div className="empty">Entrega no válida.</div>;
  if (!detail || !form) {
    return error ? <div className="notice">{error}</div> : <div className="empty">Cargando corrección…</div>;
  }

  const bundle = detail;
  const maxTotal = detail.rubric.reduce((sum, item) => sum + item.maxPoints, 0);
  const gradeStatus = detail.grade?.status ?? 'draft';
  const isApproved = gradeStatus === 'approved' || gradeStatus === 'exported';
  const pages = detail.pages;
  const currentPage = pages[page];

  const saveDraft = async () => {
    await apiSend(`/api/submissions/${submissionId}/grade`, 'PUT', {
      items: detail.rubric.map((rubricItem) => ({
        rubricItemId: rubricItem.id,
        points: Number(form.items[rubricItem.id]?.points) || 0,
        comment: form.items[rubricItem.id]?.comment ?? '',
      })),
      overallComment: form.overall,
    });
    await load();
  };

  function modelSpread(rubricItemId: number, maxPoints: number): { values: number[]; divergent: boolean } {
    const evaluations = bundle.evaluations.filter((evaluation) => evaluation.status === 'done');
    const values = evaluations
      .map((evaluation) => evaluation.items.find((item) => item.rubricItemId === rubricItemId)?.points)
      .filter((value): value is number => typeof value === 'number');
    if (values.length < 2) return { values, divergent: false };
    const spread = Math.max(...values) - Math.min(...values);
    const threshold = Math.min(bundle.divergenceThreshold, Math.max(0.2, maxPoints * 0.2));
    return { values, divergent: spread > threshold + 1e-9 };
  }

  return (
    <>
      <div className="crumbs">
        <Link to="/activities">Actividades</Link> /{' '}
        <Link to={`/activities/${detail.activity.id}`}>{detail.activity.title}</Link> /{' '}
        {detail.student.name}
      </div>

      <div className="page-head">
        <div>
          <h1>{detail.student.name}</h1>
          <p className="sub">
            {detail.activity.title} · {detail.rubric.length} apartados ·{' '}
            <span className={`badge ${gradeStatus}`}>{statusLabel(gradeStatus)}</span>
          </p>
        </div>
        <div className="actions">
          <span className="badge" style={{ fontSize: 13, padding: '6px 12px' }}>
            {total.toFixed(1)} / {maxTotal.toFixed(1)}
          </span>
          <button className="btn" onClick={() => void checkReading()} disabled={busy || readingBusy}>
            {readingBusy ? 'Comprobando lectura…' : 'Comprobar lectura IA'}
          </button>
          <a className="btn" href={`/api/submissions/${submissionId}/report.pdf`} target="_blank" rel="noreferrer">
            Descargar PDF
          </a>
        </div>
      </div>

      {testWorkflow&&<GuidePanel steps={[
        ...(testWorkflow.test?[
          {id:'key',title:'Confirmar la clave de la actividad',detail:'Extrae la clave de la solución generada, revísala y guárdala confirmada antes de corregir.',done:testWorkflow.keyConfirmed,href:`/activities/${detail.activity.id}#activity-omr`},
          {id:'detect',title:'Detectar y confirmar las respuestas',detail:'Pulsa Detectar burbujas, coteja la lista con la imagen y resuelve las dudas. Marca la casilla de revisión y pulsa Confirmar respuestas. Solo esa lista se enviará al LLM.',done:testWorkflow.confirmed,href:'#submission-detection'},
        ]:[]),
        {id:'evaluate',title:'Lanzar la corrección desde la actividad',detail:'Selecciona esta entrega y lanza la corrección. Espera a que los modelos terminen.',done:['reviewed','approved','exported'].includes(detail.submission.status)&&detail.evaluations.some(e=>e.role==='primary'&&e.status==='done'),href:`/activities/${detail.activity.id}#activity-submissions`},
        {id:'approve',title:'Revisar, guardar y aprobar la nota',detail:'Compara los comentarios con las respuestas y la solución. Ajusta la propuesta y aprueba únicamente cuando hayas terminado de revisarla.',done:isApproved,href:'#submission-grade'},
      ]}/>}
      {error && (
        <div className="notice" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}
      <section className="card" id="submission-detection" style={{marginBottom:16}}>
        <div className="card-head"><h2>Corrección de test · {omrConfig?.template.name??'plantilla de la actividad'} (primera página)</h2>
          <span className="row" style={{gap:8}}>
            <button className="btn" disabled={bubbleBusy||manualMode} onClick={() => void detectBubbles()}>{bubbleBusy ? 'Detectando…' : 'Detectar burbujas'}</button>
            <button className="btn" disabled={bubbleBusy||manualMode} onClick={() => void startManual()}>Modo manual</button>
          </span>
        </div>
        <p className="small muted">Hojas con cuatro cuadrados de referencia y bloques regulares. La detección es una propuesta: revisa todas las respuestas en la imagen antes de calcular. <Link to={`/activities/${detail.activity.id}`}>Configurar plantilla, clave y puntuación en la actividad</Link>.</p>
        {manualSuggest&&!bubbleAnswers&&<div className="notice">La detección automática no ha encontrado las cuatro referencias. Puedes repetir la foto o usar el <strong>Modo manual</strong>: pulsa el botón, marca las cuatro referencias sobre esta foto y rellena la rejilla a mano.</div>}
        {manualMode&&pages[0]&&(
          <div style={{marginTop:12}}>
            <p>{manualPoints.length<4?`Modo manual · pulsa el centro de ${CALIBRATION_LABELS[manualPoints.length]} sobre la foto.`:'Generando la rejilla…'}</p>
            <div style={{position:'relative'}}>
              <img src={pages[0].url} alt="Foto de la entrega del alumno" style={{width:'100%',display:'block'}}/>
              <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Pulsa las cuatro referencias sobre la foto" onClick={e=>{const r=e.currentTarget.getBoundingClientRect();manualClick({x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height});}} style={{position:'absolute',inset:0,width:'100%',height:'100%',cursor:'crosshair'}}>
                {manualPoints.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r=".005" fill="#ef4444"/>)}
                {manualPoints.length===4&&omrConfig&&omrConfig.template.blocks.flatMap((b,bi)=>Array.from({length:Math.min(200,b.rows)},(_,row)=>[...omrConfig.template.options].map((_,col)=>{const p=project({x:b.x+col*b.dx,y:b.y+row*b.dy},manualPoints);return <circle key={`${bi}-${row}-${col}`} cx={p.x} cy={p.y} r=".003" fill="#16a34a"/>;})))}
              </svg>
            </div>
            <button className="btn" style={{marginTop:8}} onClick={()=>{setManualMode(false);setManualPoints([]);}}>Cancelar modo manual</button>
          </div>
        )}
        {bubbleAnswers && <>
          {pages[0]&&<details><summary>Ver evidencia: círculos localizados sobre la foto (pulsa una burbuja con el pincel activo para asignar la respuesta)</summary>
            <div className="row" style={{margin:'8px 0'}}>
              <span className="small muted">Pincel:</span>
              {[...(omrConfig?.template.options??'ABCD')].map(v=><button key={v} className={`btn small${brush===v?' primary':''}`} onClick={()=>setBrush(v)}>{v}</button>)}
              <button className={`btn small${brush===''?' primary':''}`} onClick={()=>setBrush('')}>En blanco</button>
              <span className="small muted">{brush===''?'un clic deja la pregunta en blanco':`un clic marca la opción ${brush}`}</span>
            </div>
            <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" style={{width:'100%',height:600}} role="img" aria-label="Detecciones sobre la foto original">
              <image href={pages[0].url} width="1000" height="1000" preserveAspectRatio="none"/>
              {bubbleAnswers.flatMap(row=>row.circles?.map((c,i)=><g key={`${row.question}-${i}`} onClick={()=>applyBrush(row.question)} style={{cursor:'pointer'}}><circle cx={c.x*1000} cy={c.y*1000} r={c.radius*1000} fill="none" stroke={c.located?'#16a34a':'#ef4444'} strokeWidth="1.5"/><circle cx={c.x*1000} cy={c.y*1000} r={Math.max(c.radius*1000,10)} fill="transparent"/></g>)??[])}
            </svg>
          </details>}
          {evidenceQuestion&&pages[0]&&(()=>{const row=bubbleAnswers.find(r=>r.question===evidenceQuestion),cs=row?.circles;if(!cs?.length)return null;const x=Math.max(0,Math.min(...cs.map(c=>c.x))-.04),y=Math.max(0,Math.min(...cs.map(c=>c.y))-.035),width=Math.min(1-x,Math.max(...cs.map(c=>c.x))-x+.04);return <div><p>Pregunta {evidenceQuestion}: {row?.reason??'Coteja la marca con la opción detectada.'}</p><svg viewBox={`${x*1000} ${y*1000} ${width*1000} 70`} style={{width:'100%',height:150}} role="img" aria-label={`Recorte pregunta ${evidenceQuestion}`}><image href={pages[0].url} width="1000" height="1000" preserveAspectRatio="none"/></svg></div>;})()}
          <div className="scroll-x"><table><thead><tr><th>Pregunta</th><th>Detectada (editable)</th><th>Clave correcta</th></tr></thead><tbody>
            {bubbleAnswers.map(row => <tr key={row.question}>
              <td><button className="btn small" onClick={()=>setEvidenceQuestion(row.question)}>Ver {row.question}</button>{row.state==='ambiguous' ? ' · REVISAR' : ''}{row.reason&&<p className="small">{row.reason}</p>}</td>
              <td><select aria-label={`Respuesta pregunta ${row.question}`} value={row.state==='ambiguous' ? '?' : row.answer ?? ''} onChange={e => setBubbleAnswer(row.question, e.target.value || null)}>{row.state==='ambiguous'&&<option value="?">Dudosa: selecciona una opción</option>}<option value="">En blanco</option>{[...(omrConfig?.template.options??'ABCD')].map(v=><option key={v}>{v}</option>)}</select></td>
              <td>{answerKey[row.question]??'Sin clave confirmada'}</td>
            </tr>)}
          </tbody></table></div>
          {!omrConfig?.keyConfirmed&&<p className="notice">Confirma y guarda la clave en la actividad antes de calcular.</p>}
          {omrConfig?.keyConfirmed&&<details open style={{marginTop:12}}>
            <summary><strong>Comparación: clave correcta (izquierda) vs respuesta del alumno (derecha)</strong></summary>
            <p className="small muted">Pulsa ✓ para forzar "correcta" o ✗ para forzar "errónea" en una pregunta (override manual). Si no tocas nada, el resultado es el automático. Los overrides recalculan la nota.</p>
            <div className="scroll-x"><table><thead><tr><th>Pregunta</th><th>Clave (correcta)</th><th>Alumno</th><th>Resultado</th><th>Override</th></tr></thead><tbody>
              {bubbleAnswers.map(row=>{
                const key=answerKey[row.question];
                const automatic = row.answer!==null && row.answer===key ? 'correct' : (row.answer===null?'blank':'wrong');
                const verdict = overrides[row.question] ?? automatic;
                const badge = verdict==='correct'?'✓':verdict==='wrong'?'✗':'·';
                return <tr key={`cmp-${row.question}`}>
                  <td>{row.question}</td>
                  <td>{key??'—'}</td>
                  <td>{row.answer??'en blanco'}</td>
                  <td>{badge} {verdict}</td>
                  <td><button className="btn small" onClick={()=>setOverrides(prev=>{const n={...prev}; if(n[row.question]) delete n[row.question]; else n[row.question]='correct'; setBubblesConfirmed(false);setBubbleGrade(null); return n;})}>✓</button>{' '}<button className="btn small" onClick={()=>setOverrides(prev=>{const n={...prev}; n[row.question]='wrong'; setBubblesConfirmed(false);setBubbleGrade(null); return n;})}>✗</button>{overrides[row.question]&&<button className="btn small" onClick={()=>setOverrides(prev=>{const n={...prev}; delete n[row.question]; setBubblesConfirmed(false);setBubbleGrade(null); return n;})}>limpiar</button>}</td>
                </tr>;
              })}
            </tbody></table></div>
          </details>}
          <label style={{display:'block',marginTop:12}}><input type="checkbox" checked={bubblesConfirmed} onChange={e=>{setBubblesConfirmed(e.target.checked);setBubbleGrade(null);}} /> He cotejado las {omrConfig?questionCount(omrConfig.template):bubbleAnswers.length} respuestas y la clave con los documentos originales.</label>
          <button className="btn primary" style={{marginTop:12}} disabled={busy || !omrConfig?.keyConfirmed || !bubblesConfirmed || bubbleAnswers.some(x=>x.state==='ambiguous')} onClick={() => void run(calculateBubbleGrade)}>Confirmar respuestas y previsualizar puntuación</button>
          {omrConfig&&<p className="small muted">Acierto {omrConfig.scoring.correct}; error {omrConfig.scoring.wrong}; blanco {omrConfig.scoring.blank}; escala {omrConfig.scoring.scale}.</p>}
          {bubbleGrade && <p role="status">Respuestas confirmadas guardadas: el LLM usará esta lista, no la foto del alumno. {bubbleGrade.correct} aciertos · {bubbleGrade.wrong} errores · {bubbleGrade.blank} en blanco · Bruto: {bubbleGrade.raw.toFixed(2)} · Nota: {bubbleGrade.total.toFixed(2)} / {bubbleGrade.scale}. La corrección aplicará exactamente esta nota (cálculo determinista); el LLM solo añadirá comentarios. Ya puedes lanzar la corrección desde la actividad.</p>}
        </>}
      </section>
      {detail.submission.error && (
        <div className="notice" style={{ marginBottom: 14 }}>
          Último error de corrección: {detail.submission.error}
        </div>
      )}
      {detail.evaluations.length === 0 && (
        <div className="notice" style={{ marginBottom: 14 }}>
          Esta entrega aún no tiene evaluaciones. Lánzala desde{' '}
          <Link to={`/activities/${detail.activity.id}`}>la actividad</Link>.
        </div>
      )}

      {readingCheck && (
        <details className="reading" open style={{ marginBottom: 16 }}>
          <summary>
            Lectura del examen por IA · {readingCheck.provider} ({readingCheck.model}) ·{' '}
            {readingCheck.pages} de {readingCheck.totalPages} páginas
          </summary>
          <pre>{readingCheck.text}</pre>
          {readingCheck.pages < readingCheck.totalPages && (
            <p className="small" style={{ marginTop: 8, color: '#b45309' }}>
              Solo se enviaron {readingCheck.pages} de {readingCheck.totalPages} páginas. Aumenta
              «Máx. páginas por documento» en Ajustes si faltan preguntas.
            </p>
          )}
        </details>
      )}

      <div className="grid review">
        <div className="viewer">
          <div className="viewer-toolbar">
            <span>
              Página {pages.length ? page + 1 : 0} de {pages.length}
            </span>
            <span className="row" style={{ gap: 4 }}>
              {pages.length > 1 && (
                <>
                  <button className="btn small" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                    ‹
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setPage((p) => Math.min(pages.length - 1, p + 1))}
                    disabled={page >= pages.length - 1}
                  >
                    ›
                  </button>
                </>
              )}
              <button className="btn small" onClick={() => setZoom((z) => Math.min(3, z + 1))}>
                +
              </button>
              <button className="btn small" onClick={() => setZoom(1)}>
                1×
              </button>
              <button className="btn small" onClick={() => setZoom((z) => Math.max(1, z - 1))}>
                −
              </button>
            </span>
          </div>
          {currentPage ? (
            <img
              className={zoom > 1 ? `zoom-${zoom}` : undefined}
              src={currentPage.url}
              alt={`Página ${page + 1}`}
            />
          ) : (
            <div className="empty" style={{ background: '#fff' }}>
              No hay páginas de imagen. Revisa los archivos originales:
              <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
                {detail.originals.map((file) => (
                  <a key={file.id} className="btn small" href={fileUrl(file.id)} target="_blank" rel="noreferrer">
                    {file.originalName}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>

        <div>
          <section className="card">
            <div className="card-head">
              <h2>Evaluaciones de los modelos</h2>
              <span className="small muted">Seudónimos: no se envían nombres a la API</span>
            </div>
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Rol</th>
                    <th>Proveedor · modelo</th>
                    <th>Estado</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.evaluations.map((evaluation) => (
                    <tr key={evaluation.id}>
                      <td>
                        <span className={`badge ${evaluation.role === 'primary' ? 'reviewed' : 'pending'}`}>
                          {evaluation.role === 'primary' ? 'Primario' : 'Independiente'}
                        </span>
                      </td>
                      <td className="small">
                        {evaluation.provider} · <span className="mono">{evaluation.model}</span>
                      </td>
                      <td>
                        <span className={`badge ${evaluation.status}`}>
                          {EVAL_STATUS[evaluation.status] ?? evaluation.status}
                        </span>
                        {evaluation.error && (
                          <div className="small" style={{ color: '#b91c1c' }}>
                            {evaluation.error}
                          </div>
                        )}
                      </td>
                      <td className="num">
                        {evaluation.status === 'done' ? (evaluation.totalPoints ?? 0).toFixed(1) : '—'}
                      </td>
                    </tr>
                  ))}
                  {detail.evaluations.length === 0 && (
                    <tr>
                      <td colSpan={4}>
                        <div className="empty">Sin evaluaciones todavía.</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {detail.evaluations
              .filter((evaluation) => evaluation.reading)
              .map((evaluation) => (
                <details className="reading" key={`reading-${evaluation.id}`}>
                  <summary>
                    Lectura del examen · {evaluation.provider} ({evaluation.model})
                  </summary>
                  <pre>{evaluation.reading}</pre>
                  {evaluation.overallComment && (
                    <p className="small muted" style={{ marginTop: 8 }}>
                      <strong>Comentario global:</strong> {evaluation.overallComment}
                    </p>
                  )}
                </details>
              ))}
          </section>

          <section className="card">
            <div className="card-head">
              <h2 id="submission-grade">Propuesta de corrección por apartado</h2>
              <span className="small muted">
                Las divergencias se marcan en rojo (umbral {detail.divergenceThreshold} pt)
              </span>
            </div>

            {detail.rubric.map((rubricItem, index) => {
              const { values, divergent } = modelSpread(rubricItem.id, rubricItem.maxPoints);
              return (
                <div
                  className={`apartado corrected ${divergent ? 'divergent' : ''}`}
                  key={rubricItem.id}
                >
                  <div className="apartado-head">
                    <div>
                      <h3>
                        {index + 1}. {rubricItem.title}
                      </h3>
                      {rubricItem.description && (
                        <p className="small muted" style={{ marginTop: 3 }}>
                          {rubricItem.description}
                        </p>
                      )}
                    </div>
                    <span className="badge">
                      máx. {rubricItem.maxPoints}
                      {divergent ? ' · divergencia' : ''}
                      {validated.has(rubricItem.id) ? ' · validado' : ''}
                    </span>
                    <button
                      className="btn small"
                      disabled={detail.evaluations.length === 0}
                      onClick={() => {
                        const primary = detail.evaluations.find((e) => e.role === 'primary' && e.status === 'done');
                        const indep = detail.evaluations.find((e) => e.role === 'independent' && e.status === 'done');
                        const chosen = primary ?? indep;
                        const score = chosen?.items.find((i) => i.rubricItemId === rubricItem.id);
                        setValidationModel(primary ? 'primary' : 'independent');
                        setValidationComment(score?.comment ?? '');
                        setValidationPoints(score?.points ?? 0);
                        setValidationItem(rubricItem);
                      }}
                    >
                      Validar visualmente
                    </button>
                  </div>

                  <div className="model-grid">
                    {detail.evaluations.map((evaluation) => {
                      const score = evaluation.items.find((item) => item.rubricItemId === rubricItem.id);
                      return (
                        <div
                          className={`model-cell ${evaluation.role === 'primary' ? 'primary' : ''}`}
                          key={evaluation.id}
                        >
                          <div className="tiny muted">
                            {evaluation.role === 'primary' ? 'Primario' : 'Indep.'} · {evaluation.model}
                          </div>
                          <div className="score">
                            {evaluation.status === 'done' ? (score?.points ?? 0).toFixed(1) : '—'}
                          </div>
                          <div className="tiny muted">
                            {evaluation.status === 'done'
                              ? score?.comment || 'sin comentario'
                              : EVAL_STATUS[evaluation.status]}
                          </div>
                        </div>
                      );
                    })}
                    {values.length > 1 && (
                      <div className="model-cell">
                        <div className="tiny muted">Rango</div>
                        <div className="score">
                          {(Math.max(...values) - Math.min(...values)).toFixed(1)}
                        </div>
                        <div className="tiny muted">puntos de diferencia</div>
                      </div>
                    )}
                  </div>

                  <div className="grade-fields">
                    <label className="field">
                      Puntos
                      <input
                        type="number"
                        min={0}
                        max={rubricItem.maxPoints}
                        step={0.1}
                        value={form.items[rubricItem.id]?.points ?? 0}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            items: {
                              ...form.items,
                              [rubricItem.id]: {
                                ...form.items[rubricItem.id],
                                points: Number(event.target.value),
                              },
                            },
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      Comentario para el alumno
                      <textarea
                        rows={2}
                        value={form.items[rubricItem.id]?.comment ?? ''}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            items: {
                              ...form.items,
                              [rubricItem.id]: {
                                ...form.items[rubricItem.id],
                                comment: event.target.value,
                              },
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                </div>
              );
            })}

            <div className="stack" style={{ marginTop: 14 }}>
              <label className="field">
                Comentario general del examen
                <textarea
                  rows={3}
                  value={form.overall}
                  onChange={(event) => setForm({ ...form, overall: event.target.value })}
                />
              </label>
            </div>

            <div className="actions" style={{ marginTop: 14 }}>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await saveDraft();
                  }, 'Borrador guardado')
                }
              >
                Guardar borrador
              </button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await saveDraft();
                    await apiSend(`/api/submissions/${submissionId}/approve`, 'POST');
                    await load();
                  }, 'Corrección aprobada')
                }
              >
                Aprobar corrección
              </button>
              {isApproved && (
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await apiSend(`/api/submissions/${submissionId}/unapprove`, 'POST');
                      await load();
                    }, 'Corrección reabierta')
                  }
                >
                  Reabrir
                </button>
              )}
              <span className="small muted">
                Aprobar deja la entrega lista para exportar el acta y su PDF.
              </span>
            </div>
          </section>
        </div>
      </div>

      {validationItem && (() => {
        const primary = detail.evaluations.find((e) => e.role === 'primary' && e.status === 'done');
        const indep = detail.evaluations.find((e) => e.role === 'independent' && e.status === 'done');
        const chosen = validationModel === 'primary' ? (primary ?? indep) : (indep ?? primary);
        const score = chosen?.items.find((i) => i.rubricItemId === validationItem.id);
        const reading = chosen?.reading ?? null;
        const hasPrimary = !!primary;
        const hasIndep = !!indep;
        return (
          <div
            role="dialog"
            aria-modal="true"
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
            onClick={() => setValidationItem(null)}
          >
            <div
              className="card"
              style={{ width: '90%', maxWidth: 900, maxHeight: '90vh', overflow: 'auto', background: '#fff' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="card-head">
                <h2>Validación visual · {validationItem.title}</h2>
                <button className="btn small" onClick={() => setValidationItem(null)}>Cerrar</button>
              </div>
              <div className="row" style={{ gap: 8, marginBottom: 12 }}>
                <span className="small muted">Modelo:</span>
                <button
                  className={`btn small${validationModel === 'primary' ? ' primary' : ''}`}
                  disabled={!hasPrimary}
                  onClick={() => {
                    setValidationModel('primary');
                    const s = primary?.items.find((i) => i.rubricItemId === validationItem.id);
                    setValidationComment(s?.comment ?? '');
                    setValidationPoints(s?.points ?? 0);
                  }}
                >
                  Primario
                </button>
                <button
                  className={`btn small${validationModel === 'independent' ? ' primary' : ''}`}
                  disabled={!hasIndep}
                  onClick={() => {
                    setValidationModel('independent');
                    const s = indep?.items.find((i) => i.rubricItemId === validationItem.id);
                    setValidationComment(s?.comment ?? '');
                    setValidationPoints(s?.points ?? 0);
                  }}
                >
                  Independiente
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <h3 className="small">Respuesta del alumno (transcripción del LLM)</h3>
                  <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto', background: '#f5f5f5', padding: 8, borderRadius: 4 }}>
                    {reading ?? 'Sin transcripción disponible para este modelo.'}
                  </pre>
                </div>
                <div>
                  <h3 className="small">Respuesta redactada por el LLM</h3>
                  <p className="small muted">Puntos (editable):</p>
                  <input type="number" step="0.1" min={0} value={validationPoints} onChange={(e) => setValidationPoints(Number(e.target.value))} style={{ width: '100%', marginBottom: 8 }} />
                  <textarea
                    rows={8}
                    style={{ width: '100%' }}
                    value={validationComment}
                    onChange={(e) => setValidationComment(e.target.value)}
                  />
                </div>
              </div>
              <div className="actions" style={{ marginTop: 12 }}>
                <button
                  className="btn primary"
                  onClick={() => {
                    setForm((prev) => prev ? {
                      ...prev,
                      items: {
                        ...prev.items,
                        [validationItem.id]: { points: validationPoints, comment: validationComment },
                      },
                    } : prev);
                    setValidated((prev) => new Set(prev).add(validationItem.id));
                    setValidationItem(null);
                    setNotice('Propuesta aceptada en el borrador. Guarda el borrador para persistir.');
                  }}
                >
                  Aceptar propuesta
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setForm((prev) => prev ? {
                      ...prev,
                      items: {
                        ...prev.items,
                        [validationItem.id]: { points: validationPoints, comment: validationComment },
                      },
                    } : prev);
                    setValidationItem(null);
                    setNotice('Comentario editado en el borrador. Guarda el borrador para persistir.');
                  }}
                >
                  Guardar comentario editado
                </button>
                <button className="btn" onClick={() => setValidationItem(null)}>Cerrar sin cambios</button>
              </div>
            </div>
          </div>
        );
      })()}
      {notice && <div className="toast">{notice}</div>}
    </>
  );
}
