import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { EvaluationRow, SubmissionDetail } from '../../../shared/types';
import { apiGet, apiSend, errorMessage, fileUrl } from '../api';

interface ItemForm {
  points: number;
  comment: string;
}

interface FormState {
  items: Record<number, ItemForm>;
  overall: string;
}

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

  const load = async () => {
    const data = await apiGet<SubmissionDetail>(`/api/submissions/${submissionId}`);
    setDetail(data);
    return data;
  };

  useEffect(() => {
    setDetail(null);
    setForm(null);
    setZoom(1);
    setPage(0);
    setError('');
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
          <a className="btn" href={`/api/submissions/${submissionId}/report.pdf`} target="_blank" rel="noreferrer">
            Descargar PDF
          </a>
        </div>
      </div>

      {error && (
        <div className="notice" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}
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
              <h2>Propuesta de corrección por apartado</h2>
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
                    </span>
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

      {notice && <div className="toast">{notice}</div>}
    </>
  );
}
