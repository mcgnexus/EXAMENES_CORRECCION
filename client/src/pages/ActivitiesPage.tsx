import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ActivityRow, ClassRow, ScanResult, ScanRubricItem, Subject } from '../../../shared/types';
import { apiGet, apiSend, apiUpload, errorMessage } from '../api';

function subjectLabel(subject: string): string {
  return subject === 'bioquimica' ? 'Bioquímica' : 'Biología';
}

export default function ActivitiesPage() {
  const navigate = useNavigate();
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState<Subject>('biologia');
  const [classId, setClassId] = useState<string>('');
  const [description, setDescription] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [detectedRubric, setDetectedRubric] = useState<ScanRubricItem[] | null>(null);
  const examScanRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [activityRows, classRows] = await Promise.all([
        apiGet<ActivityRow[]>('/api/activities'),
        apiGet<ClassRow[]>('/api/classes'),
      ]);
      setActivities(activityRows);
      setClasses(classRows);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    setError('');
    try {
      const bundle = await apiSend<{ activity: ActivityRow }>('/api/activities', 'POST', {
        title,
        subject,
        classId: classId ? Number(classId) : null,
        description,
      });
      if (detectedRubric && detectedRubric.length > 0) {
        await apiSend(`/api/activities/${bundle.activity.id}/rubric`, 'PUT', {
          items: detectedRubric.map((item) => ({
            title: item.title,
            description: item.description,
            maxPoints: item.maxPoints,
          })),
        });
      }
      navigate(`/activities/${bundle.activity.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const scanExam = (file: File) => {
    setBusy(true);
    setError('');
    setScanBusy(true);
    (async () => {
      const form = new FormData();
      form.append('esperado', 'examen');
      form.append('file', file);
      const result = await apiUpload<ScanResult>('/api/scan', form);
      if (
        result.tipo === 'lista' &&
        result.nombres.length > 0 &&
        !result.titulo &&
        result.apartados.length === 0
      ) {
        throw new Error(
          'Esto parece una lista de alumnos, no un examen. Usa el botón «📷 Escanear lista» en la pantalla de Clases y alumnos.',
        );
      }
      if (result.titulo) setTitle(result.titulo);
      if (result.asignatura === 'biologia' || result.asignatura === 'bioquimica') {
        setSubject(result.asignatura);
      }
      if (result.enunciado) setDescription(result.enunciado);
      setDetectedRubric(result.apartados.length > 0 ? result.apartados : null);
    })()
      .catch((err) => setError(errorMessage(err)))
      .finally(() => {
        setBusy(false);
        setScanBusy(false);
      });
  };

  async function remove(activityId: number) {
    if (!confirm('¿Borrar la actividad y todas sus entregas?')) return;
    setBusy(true);
    try {
      await apiSend(`/api/activities/${activityId}`, 'DELETE');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Actividades</h1>
          <p className="sub">
            Crea exámenes o prácticas, define apartados y adjunta enunciado, solución y rúbrica.
          </p>
        </div>
      </div>

      {error && <div className="notice" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="grid two">
        <section className="card">
          <div className="card-head">
            <h2>Nueva actividad</h2>
          </div>
          <div className="stack">
            <div className="row">
              <button
                className="btn ghost"
                onClick={() => examScanRef.current?.click()}
                disabled={busy || scanBusy}
              >
                {scanBusy ? '📷 Escaneando… (10-40 s)' : '📷 Escanear examen'}
              </button>
              <span className="small muted">
                Sube una foto o PDF del examen y relleno título, materia, enunciado y apartados
              </span>
              <input
                ref={examScanRef}
                type="file"
                accept="image/*,.pdf"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) scanExam(file);
                }}
              />
            </div>
            {detectedRubric && (
              <div className="notice" style={{ marginBottom: 0 }}>
                <strong>
                  Se crearán {detectedRubric.length} apartados al crear la actividad:
                </strong>
                <br />
                {detectedRubric.map((item) => `${item.title} (${item.maxPoints})`).join(' · ')}
              </div>
            )}
            <label className="field">
              Título
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Examen de metabolismo · Unidad 3"
              />
            </label>
            <label className="field">
              Materia
              <select value={subject} onChange={(event) => setSubject(event.target.value as Subject)}>
                <option value="biologia">Biología</option>
                <option value="bioquimica">Bioquímica</option>
              </select>
            </label>
            <label className="field">
              Clase (para las entregas)
              <select value={classId} onChange={(event) => setClassId(event.target.value)}>
                <option value="">Sin clase asignada</option>
                {classes.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name} ({row.studentCount} alumnos)
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Descripción (opcional)
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                placeholder="Instrucciones generales de la actividad"
              />
            </label>
            <button className="btn primary" onClick={create} disabled={busy || !title.trim()}>
              Crear actividad
            </button>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Actividades existentes</h2>
            <span className="badge">{activities.length}</span>
          </div>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Actividad</th>
                  <th>Clase</th>
                  <th className="num">Apartados</th>
                  <th className="num">Máx.</th>
                  <th className="num">Entregas</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {activities.map((activity) => (
                  <tr key={activity.id}>
                    <td>
                      <Link to={`/activities/${activity.id}`}>
                        <strong>{activity.title}</strong>
                      </Link>
                      <br />
                      <span className="small muted">{subjectLabel(activity.subject)}</span>
                    </td>
                    <td className="small">{activity.className ?? '—'}</td>
                    <td className="num">{activity.rubricCount}</td>
                    <td className="num">{activity.maxPoints.toFixed(1)}</td>
                    <td className="num">{activity.submissionCount}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn ghost small"
                        onClick={() => void remove(activity.id)}
                        disabled={busy}
                      >
                        Borrar
                      </button>
                    </td>
                  </tr>
                ))}
                {activities.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty">Crea la primera actividad a la izquierda.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
