/**
 * Recorrido de aceptación completo, sin red ni claves:
 * actividad -> documentos -> rúbrica -> entregas -> lote -> comparación ->
 * revisión humana -> aprobación -> exportación CSV + PDF.
 *
 * Ejecuta: npm run acceptance
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'examenes-aceptacion-'));
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = 'silent';
// Esquema PostgreSQL dedicado: el recorrido no toca los datos reales y al
// final se elimina con DROP SCHEMA CASCADE.
process.env.PG_SCHEMA = `aceptacion_${crypto.randomBytes(6).toString('hex')}`;

const { buildServer } = await import('../server/index.ts');

let checks = 0;
function ok(condition: unknown, message: string): asserts condition {
  checks += 1;
  if (!condition) throw new Error(`Comprobación fallida: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makePdf(lines: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(12).fillColor('#111111');
    lines.forEach((line) => doc.text(line));
    doc.end();
  });
}

interface JsonResponse<T> {
  status: number;
  data: T;
}

async function json<T>(
  base: string,
  method: 'GET' | 'POST' | 'PUT',
  route: string,
  body?: unknown,
): Promise<JsonResponse<T>> {
  const response = await fetch(base + route, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data: data as T };
}

async function upload(
  base: string,
  route: string,
  fields: Record<string, string>,
  files: { name: string; type: string; buffer: Buffer }[],
): Promise<JsonResponse<unknown>> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const file of files) {
    form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.type }), file.name);
  }
  const response = await fetch(base + route, { method: 'POST', body: form });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

const app = await buildServer();
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const base = `http://127.0.0.1:${port}`;
console.log(`Servidor de aceptación en ${base} (datos en ${dataDir})`);

try {
  // 1. Salud
  const health = await json<{ ok: boolean }>(base, 'GET', '/api/health');
  ok(health.status === 200 && health.data.ok, 'el servidor responde /api/health');

  // 2. Clase con 30 alumnos
  const createdClass = await json<{ id: number; name: string }>(base, 'POST', '/api/classes', {
    name: 'Bioquímica · Grupo A',
    subject: 'bioquimica',
  });
  ok(createdClass.status === 201 && createdClass.data.id > 0, 'se crea la clase');
  const classId = createdClass.data.id;

  const names = Array.from({ length: 30 }, (_, index) => `Alumno ${String(index + 1).padStart(2, '0')}`);
  const imported = await json<{ imported: number }>(
    base,
    'POST',
    `/api/classes/${classId}/students/import`,
    { text: names.join('\n') },
  );
  ok(imported.status === 200 && imported.data.imported === 30, 'se importan 30 alumnos');

  const studentRows = await json<{ id: number; name: string }[]>(
    base,
    'GET',
    `/api/classes/${classId}/students`,
  );
  ok(studentRows.data.length === 30, 'la clase tiene 30 alumnos');
  const [studentA, studentB] = studentRows.data;

  // 3. Actividad + rúbrica
  const createdActivity = await json<{ activity: { id: number } }>(base, 'POST', '/api/activities', {
    title: 'Examen de metabolismo · Unidad 3',
    subject: 'bioquimica',
    classId,
    description: 'Glucólisis, ciclo de Krebs y cadena respiratoria.',
  });
  ok(createdActivity.status === 201, 'se crea la actividad');
  const activityId = createdActivity.data.activity.id;

  const rubric = await json<{ id: number; maxPoints: number }[]>(
    base,
    'PUT',
    `/api/activities/${activityId}/rubric`,
    {
      items: [
        { title: 'Glucólisis', description: 'Etapas, enzimas y balance', maxPoints: 2.5 },
        { title: 'Ciclo de Krebs', description: 'Reacciones y balance energético', maxPoints: 2.5 },
        { title: 'Cadena respiratoria', description: 'Complejos y quimiosmosis', maxPoints: 2.5 },
        { title: 'Interpretación de gráfico', description: 'Comentario de la curva', maxPoints: 2.5 },
      ],
    },
  );
  ok(rubric.status === 200 && rubric.data.length === 4, 'la rúbrica tiene 4 apartados');
  ok(
    rubric.data.reduce((sum, item) => sum + item.maxPoints, 0) === 10,
    'la rúbrica suma 10 puntos',
  );

  // 4. Documentos (PDF + texto)
  const enunciado = await makePdf([
    'EXAMEN DE METABOLISMO',
    '1. Describe la glucólisis (2.5 puntos).',
    '2. Explica el ciclo de Krebs (2.5 puntos).',
    '3. Cadena respiratoria (2.5 puntos).',
    '4. Comenta el gráfico adjunto (2.5 puntos).',
  ]);
  const solucion = await makePdf(['SOLUCIÓN DE REFERENCIA', 'Glucólisis: 10 reacciones, 2 ATP netos y 2 NADH.']);
  const rubricaDoc = await makePdf(['RÚBRICA', 'Cada apartado se valora de 0 a 2.5 puntos.']);

  const doc1 = await upload(base, `/api/activities/${activityId}/documents`, { kind: 'enunciado', name: 'Enunciado' }, [
    { name: 'enunciado.pdf', type: 'application/pdf', buffer: enunciado },
  ]);
  const doc2 = await upload(base, `/api/activities/${activityId}/documents`, { kind: 'solucion', name: 'Solución' }, [
    { name: 'solucion.pdf', type: 'application/pdf', buffer: solucion },
  ]);
  const doc3 = await upload(base, `/api/activities/${activityId}/documents`, { kind: 'rubrica', name: 'Rúbrica' }, [
    { name: 'rubrica.pdf', type: 'application/pdf', buffer: rubricaDoc },
  ]);
  const doc4 = await upload(
    base,
    `/api/activities/${activityId}/documents`,
    { kind: 'documentacion', name: 'Notas de corrección' },
    [
      {
        name: 'notas.md',
        type: 'text/markdown',
        buffer: Buffer.from('# Criterios\nPenalizar errores de estequiometría solo una vez.', 'utf8'),
      },
    ],
  );
  ok(
    [doc1, doc2, doc3, doc4].every((response) => response.status === 201),
    'se suben los cuatro documentos',
  );

  const bundle = await json<{
    documents: { kind: string; pageCount: number; text: string | null }[];
  }>(base, 'GET', `/api/activities/${activityId}`);
  ok(bundle.data.documents.length === 4, 'la actividad guarda 4 documentos');
  ok(
    bundle.data.documents.filter((doc) => doc.kind !== 'documentacion').every((doc) => doc.pageCount >= 1),
    'los PDF se convierten en páginas',
  );
  ok(
    bundle.data.documents.some((doc) => doc.kind === 'documentacion' && (doc.text ?? '').includes('Criterios')),
    'el documento de texto conserva su contenido',
  );

  // 4b. Escáner (con proveedor simulado: solo se valida el recorrido y la estructura)
  const scanWithFile = await upload(
    base,
    '/api/scan',
    { esperado: 'examen' },
    [{ name: 'enunciado.pdf', type: 'application/pdf', buffer: enunciado }],
  );
  ok(scanWithFile.status === 200, 'el endpoint de escaneo responde con un PDF');
  ok(
    typeof (scanWithFile.data as { tipo?: string }).tipo === 'string',
    'el escaneo devuelve la estructura de resultados',
  );
  const scanWithoutFile = await upload(base, '/api/scan', { esperado: 'auto' }, []);
  ok(scanWithoutFile.status === 400, 'el escaneo sin fichero falla con 400');
  // 4c. Plantilla de respuestas generada por IA (proveedor simulado)
  const generated = await json<
    { id: number; kind: string; name: string; text: string | null }[]
  >(base, 'POST', `/api/activities/${activityId}/generate-solution`);
  ok(generated.status === 200, 'la generación de plantilla responde');
  const solucionGenerada = generated.data.find(
    (doc) => doc.kind === 'solucion' && doc.name === 'Solución generada por IA',
  );
  ok(
    Boolean(solucionGenerada && (solucionGenerada.text ?? '').length > 0),
    'la plantilla generada queda guardada como documento de solución con texto',
  );
  const regenerated = await json<{ id: number; kind: string; name: string }[]>(
    base,
    'POST',
    `/api/activities/${activityId}/generate-solution`,
  );
  ok(regenerated.status === 200, 'regenerar la plantilla responde');
  ok(
    regenerated.data.filter(
      (doc) => doc.kind === 'solucion' && doc.name === 'Solución generada por IA',
    ).length === 1,
    'regenerar la plantilla no la duplica (upsert)',
  );

  // 5. Entregas de dos alumnos (PDF con dos páginas)
  const examA = await makePdf([
    'RESPUESTA DEL ALUMNO A',
    '1. La glucólisis ocurre en el citosol y rinde 2 ATP netos...',
    '2. El ciclo de Krebs produce 3 NADH, 1 FADH2 y 1 GTP...',
  ]);
  const examA2 = await makePdf([
    'PÁGINA 2',
    '3. La cadena respiratoria bombea protones...',
    '4. El gráfico muestra un aumento de la velocidad hasta saturación.',
  ]);
  const examB = await makePdf(['RESPUESTA DEL ALUMNO B', '1. Glucólisis: no recuerdo las enzimas...']);

  const uploadA = await upload(
    base,
    '/api/submissions',
    { activityId: String(activityId), studentId: String(studentA.id) },
    [
      { name: 'examen-a-p1.pdf', type: 'application/pdf', buffer: examA },
      { name: 'examen-a-p2.pdf', type: 'application/pdf', buffer: examA2 },
    ],
  );
  const uploadB = await upload(
    base,
    '/api/submissions',
    { activityId: String(activityId), studentId: String(studentB.id) },
    [{ name: 'examen-b.pdf', type: 'application/pdf', buffer: examB }],
  );
  ok(
    [uploadA, uploadB].every((response) => response.status === 201),
    'se crean las entregas de los dos alumnos',
  );

  const detailA = uploadA.data as { submission: { id: number }; pages: { url: string }[] };
  ok(detailA.pages.length >= 2, 'la entrega A tiene al menos dos páginas');
  const submissionIdA = detailA.submission.id;
  const submissionIdB = (uploadB.data as { submission: { id: number } }).submission.id;

  // 6. Límite del lote
  const tooBig = await json<{ error: string }>(base, 'POST', '/api/jobs/correct', {
    submissionIds: Array.from({ length: 11 }, (_, index) => index + 1),
  });
  ok(tooBig.status === 400, 'el servidor rechaza lotes de más de 10 entregas');

  // 7. Lote con proveedores simulados
  const job = await json<{
    id: number;
    status: string;
    done: number;
    total: number;
    error: string | null;
  }>(base, 'POST', '/api/jobs/correct', {
    submissionIds: [submissionIdA, submissionIdB],
  });
  ok(job.status === 202, 'el lote se acepta (202)');

  const deadline = Date.now() + 90_000;
  let jobState = job.data;
  while (Date.now() < deadline) {
    const current = await json<{ id: number; status: string; done: number; total: number; error: string | null }>(
      base,
      'GET',
      `/api/jobs/${job.data.id}`,
    );
    jobState = current.data;
    if (current.data.status === 'done' || current.data.status === 'error') break;
    await sleep(400);
  }
  ok(
    jobState.status === 'done',
    `el lote termina correctamente (estado: ${jobState.status}${jobState.error ? ` · ${jobState.error}` : ''})`,
  );

  // 8. Comparación y propuesta
  const reviewA = await json<{
    evaluations: { role: string; status: string; items: { points: number }[] }[];
    grade: { status: string; total: number; items: { rubricItemId: number; points: number }[] } | null;
    rubric: { id: number; maxPoints: number }[];
    divergenceThreshold: number;
  }>(base, 'GET', `/api/submissions/${submissionIdA}`);
  ok(reviewA.status === 200, 'se obtiene el detalle de revisión');
  const evaluations = reviewA.data.evaluations;
  ok(evaluations.length === 3, 'hay 1 propuesta primaria y 2 evaluaciones independientes');
  ok(evaluations.every((evaluation) => evaluation.status === 'done'), 'las 3 evaluaciones terminan');
  ok(evaluations.filter((evaluation) => evaluation.role === 'independent').length === 2, 'hay 2 evaluaciones independientes');
  ok(reviewA.data.grade !== null, 'se genera una propuesta de corrección');
  ok(reviewA.data.grade!.items.length === 4, 'la propuesta cubre los 4 apartados');
  const proposedTotal = reviewA.data.grade!.items.reduce((sum, item) => sum + item.points, 0);
  ok(Math.abs(proposedTotal - reviewA.data.grade!.total) < 0.05, 'el total coincide con la suma de apartados');
  ok(reviewA.data.grade!.total >= 0 && reviewA.data.grade!.total <= 10, 'el total está dentro de la escala');

  // 9. Revisión humana: editar y guardar borrador
  const rubricItems = reviewA.data.rubric;
  const editedTotal = rubricItems[0].maxPoints + 0.5 * (rubricItems.length - 1);
  const edited = await json<{ grade: { status: string; total: number }; submission: { status: string } }>(
    base,
    'PUT',
    `/api/submissions/${submissionIdA}/grade`,
    {
      items: rubricItems.map((item, index) => ({
        rubricItemId: item.id,
        points: index === 0 ? item.maxPoints : 0.5,
        comment: index === 0 ? 'Resuelve la glucólisis con precisión.' : 'Respuesta parcial.',
      })),
      overallComment: 'Buen dominio del metabolismo, revisar la cadena respiratoria.',
    },
  );
  ok(edited.status === 200, 'se guarda la corrección editada');
  ok(edited.data.grade.status === 'draft', 'la corrección editada queda en borrador');
  ok(Math.abs(edited.data.grade.total - editedTotal) < 0.05, 'el total se recalcula tras la edición');

  // 10. Aprobación
  const approved = await json<{ grade: { status: string }; submission: { status: string } }>(
    base,
    'POST',
    `/api/submissions/${submissionIdA}/approve`,
  );
  ok(approved.data.grade.status === 'approved', 'el profesor aprueba la corrección');
  ok(approved.data.submission.status === 'approved', 'la entrega queda aprobada');

  // 11. Exportación CSV del acta
  const csvResponse = await fetch(`${base}/api/activities/${activityId}/export.csv`);
  const csv = await csvResponse.text();
  ok(csvResponse.status === 200, 'el CSV se descarga');
  ok(csv.includes('Nota (%)') && csv.includes('Comentario general'), 'el CSV incluye calificaciones y comentarios');
  ok(csv.includes(studentA.name) && csv.includes(studentB.name), 'el CSV incluye a ambos alumnos');
  ok(csv.includes('exportada'), 'las entregas aprobadas se marcan como exportadas');

  // 12. Exportación PDF por alumno
  const pdfResponse = await fetch(`${base}/api/submissions/${submissionIdA}/report.pdf`);
  const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
  ok(pdfResponse.status === 200, 'el PDF se descarga');
  ok(pdfResponse.headers.get('content-type')?.includes('application/pdf') ?? false, 'el PDF tiene el tipo correcto');
  ok(pdfBuffer.subarray(0, 5).toString() === '%PDF-', 'el PDF es válido');
  ok(pdfBuffer.length > 2000, 'el PDF contiene contenido');

  const finalState = await json<{ grade: { status: string } }>(
    base,
    'GET',
    `/api/submissions/${submissionIdA}`,
  );
  ok(finalState.data.grade.status === 'exported', 'la entrega queda marcada como exportada');

  console.log(`\n✓ Recorrido de aceptación completado (${checks} comprobaciones).`);
  console.log('  Actividad → documentos → rúbrica → entregas → lote → comparación → revisión → aprobación → CSV + PDF.');
} catch (error) {
  console.error('\n✗ El recorrido de aceptación ha fallado.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  // Elimina el esquema de test antes de cerrar el pool; app.close() cierra
  // la conexión PostgreSQL (hook onClose → closeDb).
  const { dropSchema } = await import('../server/db.ts');
  await dropSchema().catch(() => undefined);
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
