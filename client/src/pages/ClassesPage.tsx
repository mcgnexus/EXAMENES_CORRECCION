import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClassRow, ScanResult, StudentRow, Subject } from '../../../shared/types';
import { apiGet, apiSend, apiUpload, errorMessage } from '../api';
import { expandPdfFiles } from '../pdf';

export default function ClassesPage() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState<Subject>('biologia');
  const [studentName, setStudentName] = useState('');
  const [importText, setImportText] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const listScanRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadClasses = useCallback(async () => {
    try {
      const rows = await apiGet<ClassRow[]>('/api/classes');
      setClasses(rows);
      setSelectedId((current) => current ?? rows[0]?.id ?? null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const loadStudents = useCallback(async (classId: number) => {
    try {
      setStudents(await apiGet<StudentRow[]>(`/api/classes/${classId}/students`));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadClasses();
  }, [loadClasses]);

  useEffect(() => {
    if (selectedId) void loadStudents(selectedId);
  }, [selectedId, loadStudents]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const createClass = () =>
    run(async () => {
      if (!name.trim()) return;
      const created = await apiSend<ClassRow>('/api/classes', 'POST', { name, subject });
      setName('');
      await loadClasses();
      if (created?.id) setSelectedId(created.id);
    });

  const removeClass = (classId: number) =>
    run(async () => {
      if (!confirm('¿Borrar la clase y todos sus alumnos?')) return;
      await apiSend(`/api/classes/${classId}`, 'DELETE');
      if (selectedId === classId) setSelectedId(null);
      await loadClasses();
    });

  const addStudent = () =>
    run(async () => {
      if (!selectedId || !studentName.trim()) return;
      await apiSend(`/api/classes/${selectedId}/students`, 'POST', { name: studentName });
      setStudentName('');
      await loadStudents(selectedId);
      await loadClasses();
    });

  const importStudents = () =>
    run(async () => {
      if (!selectedId || !importText.trim()) return;
      await apiSend(`/api/classes/${selectedId}/students/import`, 'POST', { text: importText });
      setImportText('');
      await loadStudents(selectedId);
      await loadClasses();
    });

  const scanStudentList = (file: File) =>
    run(async () => {
      if (!selectedId) return;
      setScanBusy(true);
      try {
        const form = new FormData();
        form.append('esperado', 'lista');
        const pages = await expandPdfFiles([file]);
        for (const page of pages) form.append('file', page);
        const result = await apiUpload<ScanResult>('/api/scan', form);
        const names = result.nombres.filter(Boolean);
        if (names.length === 0) {
          throw new Error(
            `No he detectado nombres legibles en la imagen.${result.observaciones ? ` ${result.observaciones}` : ''}`,
          );
        }
        setImportText(names.join('\n'));
      } finally {
        setScanBusy(false);
      }
    });

  const removeStudent = (studentId: number) =>
    run(async () => {
      if (!confirm('¿Borrar este alumno y sus entregas?')) return;
      await apiSend(`/api/students/${studentId}`, 'DELETE');
      if (selectedId) await loadStudents(selectedId);
      await loadClasses();
    });

  const selected = classes.find((row) => row.id === selectedId) ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Clases y alumnos</h1>
          <p className="sub">Organiza grupos de unos 30 alumnos para asociarles entregas.</p>
        </div>
      </div>

      {error && <div className="notice" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="grid two">
        <section className="card">
          <div className="card-head">
            <h2>Clases</h2>
            <span className="badge">{classes.length}</span>
          </div>

          <div className="stack" style={{ marginBottom: 14 }}>
            <label className="field">
              Nombre de la clase
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Bioquímica · Grupo A"
              />
            </label>
            <label className="field">
              Materia
              <select value={subject} onChange={(event) => setSubject(event.target.value as Subject)}>
                <option value="biologia">Biología</option>
                <option value="bioquimica">Bioquímica</option>
              </select>
            </label>
            <button className="btn primary" onClick={createClass} disabled={busy || !name.trim()}>
              Crear clase
            </button>
          </div>

          <div className="doc-list">
            {classes.map((row) => (
              <button
                key={row.id}
                className="doc-item"
                style={{
                  cursor: 'pointer',
                  textAlign: 'left',
                  borderColor: row.id === selectedId ? '#a5b4fc' : undefined,
                  background: row.id === selectedId ? '#f5f7ff' : undefined,
                }}
                onClick={() => setSelectedId(row.id)}
              >
                <span>
                  <strong>{row.name}</strong>
                  <br />
                  <span className="small muted">
                    {row.subject === 'bioquimica' ? 'Bioquímica' : 'Biología'} ·{' '}
                    {row.studentCount} alumnos
                  </span>
                </span>
                <span
                  className="btn ghost small"
                  onClick={(event) => {
                    event.stopPropagation();
                    void removeClass(row.id);
                  }}
                >
                  Borrar
                </span>
              </button>
            ))}
            {classes.length === 0 && <div className="empty">Todavía no hay clases.</div>}
          </div>
        </section>

        <section className="card">
          {selected ? (
            <>
              <div className="card-head">
                <div>
                  <h2>{selected.name}</h2>
                  <p className="small muted">{students.length} alumnos</p>
                </div>
              </div>

              <div className="grid two" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div className="stack">
                  <label className="field">
                    Añadir un alumno
                    <div className="row">
                      <input
                        value={studentName}
                        onChange={(event) => setStudentName(event.target.value)}
                        placeholder="Nombre y apellidos"
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void addStudent();
                        }}
                      />
                      <button className="btn" onClick={addStudent} disabled={busy || !studentName.trim()}>
                        Añadir
                      </button>
                    </div>
                  </label>
                </div>
                <div className="stack">
                  <label className="field">
                    Importar lista (un nombre por línea, o CSV)
                    <textarea
                      value={importText}
                      onChange={(event) => setImportText(event.target.value)}
                      placeholder={'Ana Pérez\nLuis Gómez\nMarta Ruiz'}
                      rows={4}
                    />
                  </label>
                  <div className="row">
                    <button className="btn" onClick={importStudents} disabled={busy || !importText.trim()}>
                      Importar alumnos
                    </button>
                    <button
                      className="btn ghost"
                      onClick={() => listScanRef.current?.click()}
                      disabled={busy || scanBusy}
                    >
                      {scanBusy ? '📷 Escaneando… (10-40 s)' : '📷 Escanear lista'}
                    </button>
                    <input
                      ref={listScanRef}
                      type="file"
                      accept="image/*,.pdf"
                      hidden
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file) void scanStudentList(file);
                      }}
                    />
                  </div>
                  <p className="small muted">
                    Sube una foto o escaneo de la lista de alumnos y el sistema leerá los nombres
                    automáticamente; revisa el resultado antes de importar.
                  </p>
                </div>
              </div>

              <div className="scroll-x" style={{ marginTop: 14 }}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Alumno</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {students.map((student, index) => (
                      <tr key={student.id}>
                        <td className="num muted">{index + 1}</td>
                        <td>{student.name}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn ghost small"
                            onClick={() => void removeStudent(student.id)}
                            disabled={busy}
                          >
                            Quitar
                          </button>
                        </td>
                      </tr>
                    ))}
                    {students.length === 0 && (
                      <tr>
                        <td colSpan={3}>
                          <div className="empty">Añade o importa alumnos para esta clase.</div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="empty">Selecciona o crea una clase.</div>
          )}
        </section>
      </div>
    </>
  );
}
