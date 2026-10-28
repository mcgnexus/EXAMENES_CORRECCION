/**
 * Benchmark de corrección contra la URL desplegada: sube un examen pequeño,
 * lanza el lote y mide el tiempo total y el de cada evaluación.
 * Uso: npx tsx scripts/_benchmark.ts <BASE_URL> <user:pass>
 */
import PDFDocument from 'pdfkit';

const [, , baseUrl, auth] = process.argv;
if (!baseUrl || !auth) {
  console.error('Uso: npx tsx scripts/_benchmark.ts <BASE_URL> <user:pass>');
  process.exit(2);
}
const headers = { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` };

async function json<T>(method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(baseUrl + route, {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
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

function makePdf(lines: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(12).fillColor('#111111');
    for (const line of lines) doc.text(line);
    doc.end();
  });
}

// 1. Preparación
const createdClass = await json<{ id: number }>('POST', '/api/classes', {
  name: 'Benchmark',
  subject: 'bioquimica',
});
const classId = createdClass.data.id;
const imported = await json<{ students: { id: number }[] }>(
  'POST',
  `/api/classes/${classId}/students/import`,
  { text: 'Ana Benchmark' },
);
const studentId = imported.data.students[0].id;
const activity = await json<{ activity: { id: number } }>('POST', '/api/activities', {
  title: 'Benchmark · metabolismo',
  subject: 'bioquimica',
  classId,
});
const activityId = activity.data.activity.id;
const rubric = await json('PUT', `/api/activities/${activityId}/rubric`, {
  items: [
    { title: 'Glucólisis', maxPoints: 2.5 },
    { title: 'Ciclo de Krebs', maxPoints: 2.5 },
    { title: 'Cadena respiratoria', maxPoints: 2.5 },
    { title: 'Interpretación', maxPoints: 2.5 },
  ],
});
if (rubric.status !== 200) throw new Error(`rúbrica → ${rubric.status}`);

const examPdf = await makePdf([
  'ENTREGA DE ANA BENCHMARK',
  '1. La glucólisis ocurre en el citosol: glucosa + 2 ATP → 2 piruvato, rendimiento neto 2 ATP y 2 NADH, enzimas como hexoquinasa y fosfofructoquinasa.',
  '2. El ciclo de Krebs oxida el acetil-CoA produciendo 3 NADH, 1 FADH2 y 1 GTP por vuelta, con la citrato sintasa como enzima reguladora.',
  '3. La cadena respiratoria transporta electrones desde NADH hasta el O2 a través de los complejos I-IV, bombeando protones; la ATP sintasa usa ese gradiente.',
  '4. El gráfico muestra saturación de velocidad con sustrato: comportamiento enzimático tipo Michaelis-Menten.',
]);
const submissionResponse = await fetch(`${baseUrl}/api/submissions`, {
  method: 'POST',
  headers,
  body: (() => {
    const form = new FormData();
    form.append('activityId', String(activityId));
    form.append('studentId', String(studentId));
    form.append('file', new Blob([new Uint8Array(examPdf)], { type: 'application/pdf' }), 'examen.pdf');
    return form;
  })(),
});
if (submissionResponse.status !== 201) throw new Error(`entrega → ${submissionResponse.status}: ${await submissionResponse.text()}`);
const detail = (await submissionResponse.json()) as { submission: { id: number }; pages: unknown[] };
const submissionId = detail.submission.id;
console.log(`entrega ${submissionId} con ${detail.pages.length} página(s). Lanzando lote...`);

// 2. Lote y medición
const t0 = Date.now();
const job = await json<{ id: number }>('POST', '/api/jobs/correct', { submissionIds: [submissionId] });
if (job.status !== 202) throw new Error(`lote → ${job.status}: ${JSON.stringify(job.data)}`);
const jobId = job.data.id;

let jobState: { status: string; error: string | null } = { status: 'queued', error: null };
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const current = await json<{ status: string; error: string | null }>('GET', `/api/jobs/${jobId}`);
  jobState = current.data;
  if (jobState.status === 'done' || jobState.status === 'error') break;
}
const totalSecs = Math.round((Date.now() - t0) / 1000);
console.log(`lote ${jobId}: ${jobState.status} en ${totalSecs}s${jobState.error ? ` | ${jobState.error}` : ''}`);

// 3. Detalle de evaluaciones
const review = await json<{
  evaluations: { role: string; model: string; status: string; totalPoints: number | null; startedAt: string | null; finishedAt: string | null }[];
  grade: { status: string; total: number } | null;
}>('GET', `/api/submissions/${submissionId}`);
for (const evaluation of review.data.evaluations) {
  const secs =
    evaluation.startedAt && evaluation.finishedAt
      ? Math.round((new Date(evaluation.finishedAt).getTime() - new Date(evaluation.startedAt).getTime()) / 1000)
      : null;
  console.log(`  ${evaluation.role.padEnd(12)} ${evaluation.model.padEnd(22)} ${evaluation.status.padEnd(7)} ${secs ?? '?'}s (${evaluation.totalPoints ?? '-'} pts)`);
}
console.log(`nota propuesta: ${review.data.grade ? `${review.data.grade.total}/10 (${review.data.grade.status})` : 'sin nota'}`);

// 4. Limpieza
await json('DELETE', `/api/submissions/${submissionId}`);
await json('DELETE', `/api/activities/${activityId}`);
await json('DELETE', `/api/classes/${classId}`);
console.log('limpieza completada.');

if (jobState.status !== 'done') process.exit(1);
