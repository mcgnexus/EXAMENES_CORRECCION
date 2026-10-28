import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  ActivityBundle,
  ClassRow,
  DocumentKind,
  JobRow,
  RubricItem,
  StudentRow,
  SolutionTemplateRow,
  Subject,
  SubmissionRow,
} from '../../../shared/types';
import { apiGet, apiSend, apiUpload, errorMessage, fileUrl } from '../api';
import { expandPdfFiles } from '../pdf';

interface RubricDraft {
  id?: number;
  title: string;
  description: string;
  maxPoints: number;
}

const DOC_KINDS: { value: DocumentKind; label: string }[] = [
  { value: 'enunciado', label: 'Enunciado' },
  { value: 'solucion', label: 'Solución' },
  { value: 'rubrica', label: 'Rúbrica (documento)' },
  { value: 'documentacion', label: 'Documentación' },
];

const STATUS_LABEL: Record<string, string> = {
  uploaded: 'Subida',
  queued: 'En cola',
  running: 'Corrigiendo',
  reviewed: 'Revisada',
  approved: 'Aprobada',
  exported: 'Exportada',
  error: 'Error',
};

function subjectLabel(subject: string): string {
  return subject === 'bioquimica' ? 'Bioquímica' : 'Biología';
}

function fromRubric(rubric: RubricItem[]): RubricDraft[] {
  return rubric.map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    maxPoints: item.maxPoints,
  }));
}

export default function ActivityPage() {
  const { id } = useParams();
  const activityId = Number(id);
  const navigate = useNavigate();

  const [bundle, setBundle] = useState<ActivityBundle | null>(null);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [rubricDraft, setRubricDraft] = useState<RubricDraft[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [job, setJob] = useState<JobRow | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState({
    title: '',
    subject: 'biologia' as Subject,
    classId: '',
    description: '',
    status: 'draft' as 'draft' | 'active' | 'archived',
  });

  const [docKind, setDocKind] = useState<DocumentKind>('enunciado');
  const [docName, setDocName] = useState('');
  const [solveBusy, setSolveBusy] = useState(false);
  const [rubricBusy, setRubricBusy] = useState(false);
  const [solutionTemplates, setSolutionTemplates] = useState<SolutionTemplateRow[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templatesBusy, setTemplatesBusy] = useState(false);
  const docInput = useRef<HTMLInputElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = useState<StudentRow | null>(null);

  const refresh = useCallback(
    async (resetRubric = false) => {
      if (!Number.isFinite(activityId)) return;
      const data = await apiGet<ActivityBundle>(`/api/activities/${activityId}`);
      setBundle(data);
      setMeta({
        title: data.activity.title,
        subject: data.activity.subject,
        classId: data.activity.classId ? String(data.activity.classId) : '',
        description: data.activity.description,
        status: data.activity.status,
      });
      setRubricDraft((current) => (resetRubric || current === null ? fromRubric(data.rubric) : current));
    },
    [activityId],
  );

  useEffect(() => {
    setRubricDraft(null);
    setBundle(null);
    setSelected(new Set());
    setJob(null);
    setError('');
    void refresh(true).catch((err) => setError(errorMessage(err)));
    void apiGet<ClassRow[]>('/api/classes')
      .then(setClasses)
      .catch(() => setClasses([]));
    void apiGet<SolutionTemplateRow[]>(`/api/activities/${activityId}/solution-templates`)
      .then(setSolutionTemplates)
      .catch(() => setSolutionTemplates([]));
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
    const timer = setInterval(async () => {
      try {
        const updated = await apiGet<JobRow>(`/api/jobs/${job.id}`);
        setJob(updated);
        if (updated.status === 'done' || updated.status === 'error') {
          await refresh();
          if (updated.status === 'error') {
            setError(updated.error ?? 'El lote terminó con errores');
          } else {
            setNotice('Corrección del lote terminada. Revisa las entregas.');
          }
        }
      } catch {
        /* seguir intentando */
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [job, refresh]);

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

  const rubricTotal = useMemo(
    () => (rubricDraft ?? []).reduce((sum, item) => sum + (Number(item.maxPoints) || 0), 0),
    [rubricDraft],
  );

  if (!Number.isFinite(activityId)) {
    return <div className="empty">Actividad no válida.</div>;
  }

  const submissions = bundle?.submissions ?? [];
  const byStudent = new Map(submissions.map((submission) => [submission.studentId, submission]));
  const approvedCount = submissions.filter(
    (submission) => submission.status === 'approved' || submission.status === 'exported',
  ).length;

  function toggleSubmission(submissionId: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(submissionId)) {
        next.delete(submissionId);
      } else {
        if (next.size >= 10) {
          setNotice('Máximo 10 entregas por lote.');
          return current;
        }
        next.add(submissionId);
      }
      return next;
    });
  }

  function startUpload(student: StudentRow) {
    setUploadTarget(student);
    uploadInput.current?.click();
  }

  async function handleUploadFiles(files: FileList | null) {
    if (!files || files.length === 0 || !uploadTarget) {
      setUploadTarget(null);
      return;
    }
    const target = uploadTarget;
    setUploadTarget(null);
    await run(async () => {
      const form = new FormData();
      form.append('activityId', String(activityId));
      form.append('studentId', String(target.id));
      const pages = await expandPdfFiles(Array.from(files), (progress) =>
        setNotice(`${progress.file}: página ${progress.page} de ${progress.totalPages}`),
      );
      for (const file of pages) form.append('files', file);
      await apiUpload('/api/submissions', form);
      await refresh();
    }, `Entrega subida para ${target.name}`);
    if (uploadInput.current) uploadInput.current.value = '';
  }

  async function handleDocument(files: FileList | null, input: HTMLInputElement) {
    if (!files || files.length === 0) return;
    const file = files[0];
    await run(async () => {
      const form = new FormData();
      form.append('kind', docKind);
      if (docName.trim()) form.append('name', docName.trim());
      const pages = await expandPdfFiles([file], (progress) =>
        setNotice(`${progress.file}: página ${progress.page} de ${progress.totalPages}`),
      );
      for (const page of pages) form.append('files', page);
      await apiUpload(`/api/activities/${activityId}/documents`, form);
      setDocName('');
      await refresh();
    }, 'Documento subido');
    input.value = '';
  }

  const generateSolution = () =>
    run(async () => {
      const hasSolucion = bundle?.documents.some((document) => document.kind === 'solucion');
      if (
        hasSolucion &&
        !confirm('Ya existe un documento de solución. ¿Generar otra vez la plantilla con IA?')
      ) {
        return;
      }
      setSolveBusy(true);
      try {
        await apiSend(`/api/activities/${activityId}/generate-solution`, 'POST');
        await refresh();
      } finally {
        setSolveBusy(false);
      }
    }, 'Plantilla de respuestas generada por IA');

  const useSolutionTemplate = () =>
    run(async () => {
      if (!selectedTemplateId) throw new Error('Selecciona primero una plantilla');
      setTemplatesBusy(true);
      try {
        await apiSend(
          `/api/activities/${activityId}/solution-templates/${selectedTemplateId}`,
          'POST',
        );
        await refresh();
      } finally {
        setTemplatesBusy(false);
      }
    }, 'Plantilla añadida a esta actividad');

  const generateRubric = () =>
    run(async () => {
      if (
        (rubricDraft ?? []).length > 0 &&
        !confirm('Esto reemplazará los apartados actuales por la propuesta de la IA. ¿Continuar?')
      ) {
        return;
      }
      setRubricBusy(true);
      try {
        const proposal = await apiSend<{
          items: { title: string; description: string; maxPoints: number }[];
          observaciones?: string;
        }>(`/api/activities/${activityId}/generate-rubric`, 'POST');
        setRubricDraft(
          proposal.items.map((item, index) => ({
            id: (rubricDraft ?? [])[index]?.id,
            title: item.title,
            description: item.description,
            maxPoints: item.maxPoints,
          })),
        );
      } finally {
        setRubricBusy(false);
      }
    }, 'Rúbrica propuesta por la IA. Revísala y pulsa «Guardar rúbrica».');

  const saveRubric = () =>
    run(async () => {
      if (!rubricDraft || rubricDraft.length === 0) throw new Error('Añade al menos un apartado');
      for (const item of rubricDraft) {
        if (!item.title.trim()) throw new Error('Todos los apartados necesitan título');
        if (!(Number(item.maxPoints) > 0)) throw new Error('Los puntos máximos deben ser mayores que 0');
      }
      const updated = await apiSend<RubricItem[]>(`/api/activities/${activityId}/rubric`, 'PUT', {
        items: rubricDraft.map((item) => ({
          id: item.id,
          title: item.title,
          description: item.description,
          maxPoints: Number(item.maxPoints),
        })),
      });
      setRubricDraft(fromRubric(updated));
      await refresh();
    }, 'Rúbrica guardada');

  const saveMeta = () =>
    run(async () => {
      await apiSend(`/api/activities/${activityId}`, 'PATCH', {
        title: meta.title,
        subject: meta.subject,
        classId: meta.classId ? Number(meta.classId) : null,
        description: meta.description,
        status: meta.status,
      });
      await refresh();
    }, 'Datos de la actividad guardados');

  const launchBatch = () =>
    run(async () => {
      if (selected.size === 0) throw new Error('Selecciona al menos una entrega');
      const created = await apiSend<JobRow>('/api/jobs/correct', 'POST', {
        submissionIds: [...selected],
      });
      setJob(created);
      setNotice(`Lote lanzado con ${selected.size} entregas.`);
    });

  if (!bundle) {
    return error ? <div className="notice">{error}</div> : <div className="empty">Cargando…</div>;
  }

  const activity = bundle.activity;

  return (
    <>
      <div className="crumbs">
        <Link to="/activities">Actividades</Link> / {activity.title}
      </div>
      <div className="page-head">
        <div>
          <h1>{activity.title}</h1>
          <p className="sub">
            {subjectLabel(activity.subject)} · {activity.className ?? 'sin clase'} ·{' '}
            {STATUS_LABEL[activity.status] ?? activity.status}
          </p>
        </div>
        <div className="actions">
          <a className="btn" href={`/api/activities/${activity.id}/export.csv`}>
            Exportar CSV
          </a>
          <button
            className="btn danger"
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (!confirm('¿Borrar la actividad y todas sus entregas?')) return;
                await apiSend(`/api/activities/${activity.id}`, 'DELETE');
                navigate('/activities');
              })
            }
          >
            Borrar actividad
          </button>
        </div>
      </div>

      {error && (
        <div className="notice" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      <div className="grid three" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <span className="small muted">Apartados</span>
          <span className="value">{bundle.rubric.length}</span>
          <span className="small muted">Total {rubricTotal.toFixed(1)} puntos</span>
        </div>
        <div className="card stat">
          <span className="small muted">Entregas</span>
          <span className="value">{submissions.length}</span>
          <span className="small muted">{approvedCount} aprobadas</span>
        </div>
        <div className="card stat">
          <span className="small muted">Documentos</span>
          <span className="value">{bundle.documents.length}</span>
          <span className="small muted">Enunciado, solución, rúbrica…</span>
        </div>
      </div>

      <section className="card">
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Datos de la actividad</summary>
          <div className="grid three" style={{ marginTop: 14 }}>
            <label className="field">
              Título
              <input value={meta.title} onChange={(event) => setMeta({ ...meta, title: event.target.value })} />
            </label>
            <label className="field">
              Materia
              <select
                value={meta.subject}
                onChange={(event) => setMeta({ ...meta, subject: event.target.value as Subject })}
              >
                <option value="biologia">Biología</option>
                <option value="bioquimica">Bioquímica</option>
              </select>
            </label>
            <label className="field">
              Clase
              <select
                value={meta.classId}
                onChange={(event) => setMeta({ ...meta, classId: event.target.value })}
              >
                <option value="">Sin clase</option>
                {classes.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name} ({row.studentCount})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Estado
              <select
                value={meta.status}
                onChange={(event) =>
                  setMeta({ ...meta, status: event.target.value as typeof meta.status })
                }
              >
                <option value="draft">Borrador</option>
                <option value="active">Activa</option>
                <option value="archived">Archivada</option>
              </select>
            </label>
            <label className="field" style={{ gridColumn: 'span 2' }}>
              Descripción
              <textarea
                value={meta.description}
                rows={2}
                onChange={(event) => setMeta({ ...meta, description: event.target.value })}
              />
            </label>
          </div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={saveMeta} disabled={busy}>
              Guardar datos
            </button>
          </div>
        </details>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Enunciado, solución y documentación</h2>
          <span className="badge">{bundle.documents.length}</span>
        </div>

        <div className="row" style={{ marginBottom: 10, alignItems: 'center' }}>
          <button className="btn" disabled={busy || solveBusy} onClick={generateSolution}>
            {solveBusy ? '🤖 Generando plantilla… (10-60 s)' : '🤖 Generar plantilla de respuestas (IA)'}
          </button>
          <span className="small muted">
            La IA responde el enunciado y guarda el resultado como documento «Solución» para corregir con referencia.
          </span>
        </div>

        <div className="template-picker">
          <div>
            <strong>Reutilizar una solución</strong>
            <div className="small muted">
              Plantillas guardadas en otras actividades de {subjectLabel(bundle.activity.subject)}.
            </div>
          </div>
          <div className="row template-picker-controls">
            <select
              aria-label="Plantilla de solución de la misma asignatura"
              value={selectedTemplateId}
              onChange={(event) => setSelectedTemplateId(event.target.value)}
              disabled={solutionTemplates.length === 0}
            >
              <option value="">
                {solutionTemplates.length ? 'Selecciona una plantilla…' : 'Aún no hay plantillas disponibles'}
              </option>
              {solutionTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.activityTitle} — {template.name}
                </option>
              ))}
            </select>
            <button
              className="btn ghost"
              disabled={!selectedTemplateId || busy || templatesBusy}
              onClick={useSolutionTemplate}
            >
              {templatesBusy ? 'Añadiendo…' : 'Usar plantilla'}
            </button>
          </div>
        </div>

        <div className="doc-list" style={{ marginBottom: 14 }}>
          {bundle.documents.map((document) => (
            <div className="doc-item" key={document.id}>
              <span>
                <span className="kind-tag">{document.kind}</span>{' '}
                <strong>{document.name}</strong>
                <br />
                <span className="small muted">
                  {document.originalName} · {document.pageCount} página(s)
                  {document.text ? ' · texto extraído' : ''}
                </span>
              </span>
              <span className="row">
                {document.originalFileId && (
                  <a className="btn ghost small" href={fileUrl(document.originalFileId)} target="_blank" rel="noreferrer">
                    Ver
                  </a>
                )}
                <button
                  className="btn ghost small"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await apiSend(`/api/documents/${document.id}`, 'DELETE');
                      await refresh();
                    }, 'Documento eliminado')
                  }
                >
                  Quitar
                </button>
              </span>
              {document.text && (
                <details className="markdown-document">
                  <summary className="btn ghost small">
                    {document.kind === 'solucion' ? 'Ver solución' : 'Ver texto'}
                  </summary>
                  {document.kind === 'solucion' && (
                    <span className="row markdown-downloads">
                      <a className="btn ghost small" href={`/api/activities/${activityId}/documents/${document.id}/download?format=md`} download>
                        Descargar Markdown
                      </a>
                      <a className="btn ghost small" href={`/api/activities/${activityId}/documents/${document.id}/download?format=pdf`} download>
                        Descargar PDF
                      </a>
                    </span>
                  )}
                  <article className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{document.text}</ReactMarkdown>
                  </article>
                </details>
              )}
            </div>
          ))}
          {bundle.documents.length === 0 && (
            <div className="empty">Sube el enunciado, la solución y la rúbrica de la actividad.</div>
          )}
        </div>

        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ maxWidth: 190 }}>
            Tipo
            <select value={docKind} onChange={(event) => setDocKind(event.target.value as DocumentKind)}>
              {DOC_KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: 1, minWidth: 180 }}>
            Nombre (opcional)
            <input
              value={docName}
              onChange={(event) => setDocName(event.target.value)}
              placeholder="Título del documento"
            />
          </label>
          <input
            ref={docInput}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.md,.txt"
            style={{ display: 'none' }}
            onChange={(event) => {
              if (docInput.current) void handleDocument(event.target.files, docInput.current);
            }}
          />
          <button className="btn primary" disabled={busy} onClick={() => docInput.current?.click()}>
            Subir documento
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Rúbrica por apartados</h2>
          <span className="badge">{rubricTotal.toFixed(1)} puntos</span>
        </div>

        <div className="stack">
          {(rubricDraft ?? []).map((item, index) => (
            <div className="rubric-row" key={item.id ?? `new-${index}`}>
              <div className="stack" style={{ gap: 6 }}>
                <input
                  value={item.title}
                  placeholder={`Apartado ${index + 1}: título`}
                  onChange={(event) => {
                    const next = [...(rubricDraft ?? [])];
                    next[index] = { ...item, title: event.target.value };
                    setRubricDraft(next);
                  }}
                />
                <input
                  value={item.description}
                  placeholder="Criterio de corrección (qué debe demostrar el alumno)"
                  onChange={(event) => {
                    const next = [...(rubricDraft ?? [])];
                    next[index] = { ...item, description: event.target.value };
                    setRubricDraft(next);
                  }}
                />
              </div>
              <label className="field">
                Puntos máx.
                <input
                  type="number"
                  min={0.1}
                  step={0.5}
                  value={item.maxPoints}
                  onChange={(event) => {
                    const next = [...(rubricDraft ?? [])];
                    next[index] = { ...item, maxPoints: Number(event.target.value) };
                    setRubricDraft(next);
                  }}
                />
              </label>
              <button
                className="btn danger"
                title="Quitar apartado"
                onClick={() =>
                  setRubricDraft((rubricDraft ?? []).filter((_, position) => position !== index))
                }
              >
                ×
              </button>
            </div>
          ))}
          {(rubricDraft ?? []).length === 0 && (
            <div className="empty">Añade los apartados que se corregirán por separado.</div>
          )}
        </div>

        <div className="actions" style={{ marginTop: 12 }}>
          <button
            className="btn"
            onClick={generateRubric}
            disabled={busy || rubricBusy}
            title="Usa el enunciado, la plantilla y los documentos de la actividad"
          >
            {rubricBusy ? 'Generando rúbrica…' : 'Generar rúbrica con IA'}
          </button>
          <button
            className="btn"
            onClick={() =>
              setRubricDraft((current) => [
                ...(current ?? []),
                { title: '', description: '', maxPoints: 2.5 },
              ])
            }
          >
            Añadir apartado
          </button>
          <button className="btn primary" onClick={saveRubric} disabled={busy}>
            Guardar rúbrica
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Entregas de alumnos</h2>
          <span className="badge">
            {submissions.length} / {bundle.students.length}
          </span>
        </div>

        {!activity.classId && (
          <div className="notice" style={{ marginBottom: 12 }}>
            Asigna una clase a la actividad (en «Datos de la actividad») para poder subir entregas.
          </div>
        )}

        <input
          ref={uploadInput}
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.webp"
          style={{ display: 'none' }}
          onChange={(event) => void handleUploadFiles(event.target.files)}
        />

        {activity.classId && (
          <div className="scroll-x" style={{ marginBottom: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>Alumno</th>
                  <th>Estado</th>
                  <th className="num">Páginas</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bundle.students.map((student) => {
                  const submission = byStudent.get(student.id);
                  return (
                    <tr key={student.id}>
                      <td>{student.name}</td>
                      <td>
                        {submission ? (
                          <span className={`badge ${submission.status}`}>
                            {STATUS_LABEL[submission.status] ?? submission.status}
                          </span>
                        ) : (
                          <span className="small muted">sin entrega</span>
                        )}
                      </td>
                      <td className="num">{submission ? submission.fileCount : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="row" style={{ justifyContent: 'flex-end' }}>
                          <button
                            className="btn small"
                            disabled={busy}
                            onClick={() => startUpload(student)}
                          >
                            {submission ? 'Añadir páginas' : 'Subir fotos/PDF'}
                          </button>
                          {submission && (
                            <Link className="btn small primary" to={`/submissions/${submission.id}`}>
                              Revisar
                            </Link>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {bundle.students.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <div className="empty">
                        La clase no tiene alumnos. <Link to="/classes">Añádelos aquí</Link>.
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <div className="card-head" style={{ marginTop: 8 }}>
          <h3>Lote de corrección</h3>
          <span className="small muted">Selecciona hasta 10 entregas</span>
        </div>

        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th style={{ width: 34 }} />
                <th>Alumno</th>
                <th>Estado</th>
                <th className="num">Páginas</th>
                <th>Error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {submissions.map((submission) => (
                <tr key={submission.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(submission.id)}
                      onChange={() => toggleSubmission(submission.id)}
                      disabled={submission.status === 'running' || submission.status === 'queued'}
                    />
                  </td>
                  <td>{submission.studentName}</td>
                  <td>
                    <span className={`badge ${submission.status}`}>
                      {STATUS_LABEL[submission.status] ?? submission.status}
                    </span>
                  </td>
                  <td className="num">{submission.fileCount}</td>
                  <td className="small" style={{ maxWidth: 260, color: '#b91c1c' }}>
                    {submission.error ?? ''}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="row" style={{ justifyContent: 'flex-end' }}>
                      <Link className="btn ghost small" to={`/submissions/${submission.id}`}>
                        Abrir
                      </Link>
                      <button
                        className="btn ghost small"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            if (!confirm(`¿Borrar la entrega de ${submission.studentName}?`)) return;
                            await apiSend(`/api/submissions/${submission.id}`, 'DELETE');
                            setSelected((current) => {
                              const next = new Set(current);
                              next.delete(submission.id);
                              return next;
                            });
                            await refresh();
                          }, 'Entrega eliminada')
                        }
                      >
                        Borrar
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
              {submissions.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">Sube la primera entrega desde la tabla de alumnos.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="actions" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={launchBatch} disabled={busy || selected.size === 0}>
            Lanzar corrección ({selected.size})
          </button>
          <span className="small muted">
            Se genera la propuesta del modelo primario y las evaluaciones independientes configuradas.
          </span>
        </div>

        {job && (
          <div style={{ marginTop: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small">
                Lote #{job.id} · {job.done}/{job.total} ·{' '}
                <strong>{job.status === 'done' ? 'terminado' : job.status}</strong>
              </span>
              {job.status === 'error' && <span className="small" style={{ color: '#b91c1c' }}>Con errores</span>}
            </div>
            <div className="progress" style={{ marginTop: 6 }}>
              <span style={{ width: `${job.total ? Math.round((job.done / job.total) * 100) : 0}%` }} />
            </div>
            {job.error && <p className="small" style={{ color: '#b91c1c', marginTop: 6 }}>{job.error}</p>}
          </div>
        )}
      </section>

      {notice && <div className="toast">{notice}</div>}
    </>
  );
}
