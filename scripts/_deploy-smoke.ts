/**
 * Humo E2E contra la URL desplegada: clase → alumnos → actividad → documento
 * PDF (pdftoppm) → entrega PDF (pdftoppm) → descarga de página PNG → SSE →
 * limpieza. Sale con código 1 si algo falla.
 * Uso: npx tsx scripts/_deploy-smoke.ts <BASE_URL> <AUTH_USER:PASS>
 */
import PDFDocument from 'pdfkit';

const [, , baseUrl, auth] = process.argv;
if (!baseUrl || !auth) {
  console.error('Uso: npx tsx scripts/_deploy-smoke.ts <BASE_URL> <user:pass>');
  process.exit(2);
}
const headers = { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` };
let checks = 0;
function ok(condition: unknown, message: string): asserts condition {
  checks += 1;
  if (!condition) throw new Error(`Comprobación fallida: ${message}`);
}

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

async function upload(route: string, fields: Record<string, string>, file: { name: string; type: string; buffer: Buffer }) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.type }), file.name);
  const response = await fetch(baseUrl + route, { method: 'POST', headers, body: form });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
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

// 0. Auth
const unauthorized = await fetch(`${baseUrl}/api/classes`);
ok(unauthorized.status === 401, 'la API pública exige autenticación (401)');

// 1. Clase + alumnos
const createdClass = await json<{ id: number }>('POST', '/api/classes', {
  name: 'Despliegue · prueba',
  subject: 'biologia',
});
ok(createdClass.status === 201 && createdClass.data.id > 0, 'se crea la clase');
const classId = createdClass.data.id;

const imported = await json<{ imported: number }>('POST', `/api/classes/${classId}/students/import`, {
  // "Alumno Uno" sin dígitos se trataría como cabecera de lista por la heurística
  // de parseo; se usan nombres que no empiecen por el prefijo de cabecera.
  text: 'Ana Prueba\nLuis Muestra',
});
ok(imported.data.imported === 2, 'se importan 2 alumnos');
const students = await json<{ id: number; name: string }[]>('GET', `/api/classes/${classId}/students`);
const student = students.data[0];

// 2. Actividad + rúbrica
const createdActivity = await json<{ activity: { id: number } }>('POST', '/api/activities', {
  title: 'Prueba de despliegue',
  subject: 'biologia',
  classId,
});
ok(createdActivity.status === 201, 'se crea la actividad');
const activityId = createdActivity.data.activity.id;

const rubric = await json<{ id: number }[]>('PUT', `/api/activities/${activityId}/rubric`, {
  items: [
    { title: 'Apartado A', maxPoints: 5 },
    { title: 'Apartado B', maxPoints: 5 },
  ],
});
ok(rubric.status === 200 && rubric.data.length === 2, 'la rúbrica se guarda');

// 3. Documento PDF → pdftoppm en el contenedor
const enunciadoPdf = await makePdf(['ENUNCIADO DE PRUEBA', '1. Pregunta de prueba.']);
const docUpload = await upload(
  `/api/activities/${activityId}/documents`,
  { kind: 'enunciado', name: 'Enunciado' },
  { name: 'enunciado.pdf', type: 'application/pdf', buffer: enunciadoPdf },
);
ok(docUpload.status === 201, 'se sube el documento PDF');
const bundle = await json<{ documents: { pageCount: number }[] }>('GET', `/api/activities/${activityId}`);
ok(bundle.data.documents[0]?.pageCount >= 1, 'pdftoppm convirtió el PDF del documento en páginas');

// 4. Entrega PDF → pdftoppm + almacenamiento en volumen/disco
const examPdf = await makePdf(['ENTREGA DEL ALUMNO', '1. Respuesta de prueba.']);
const submissionUpload = await upload(
  '/api/submissions',
  { activityId: String(activityId), studentId: String(student.id) },
  { name: 'examen.pdf', type: 'application/pdf', buffer: examPdf },
);
ok(submissionUpload.status === 201, 'se crea la entrega');
const detail = submissionUpload.data as { submission: { id: number }; pages: { url: string }[] };
ok(detail.pages.length >= 1, 'la entrega tiene páginas PNG');
const submissionId = detail.submission.id;

// 5. Descarga de la página (lee de disco/volumen)
const pageResponse = await fetch(baseUrl + detail.pages[0].url, { headers });
ok(pageResponse.status === 200, 'la página se descarga (200)');
ok(pageResponse.headers.get('content-type') === 'image/png', 'la página es image/png');
const pageBytes = (await pageResponse.arrayBuffer()).byteLength;
ok(pageBytes > 1000, `la PNG tiene contenido (${pageBytes} bytes)`);

// 6. SSE
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 8000);
try {
  const events = await fetch(`${baseUrl}/api/events`, { headers, signal: controller.signal });
  ok(events.status === 200, 'el stream SSE responde 200');
  const reader = events.body!.getReader();
  const first = await reader.read();
  const chunk = new TextDecoder().decode(first.value);
  ok(chunk.includes('conectado'), 'el stream SSE entrega datos');
} catch (error) {
  if ((error as Error).name === 'AbortError') {
    ok(false, 'el stream SSE no entregó datos en 8 s');
  } else {
    throw error;
  }
} finally {
  clearTimeout(timeout);
  controller.abort();
}

// 7. Limpieza (la BD Neon es compartida)
await json('DELETE', `/api/submissions/${submissionId}`);
const documents = await json<{ documents: { id: number }[] }>('GET', `/api/activities/${activityId}`);
for (const document of documents.data.documents) await json('DELETE', `/api/documents/${document.id}`);
await json('DELETE', `/api/activities/${activityId}`);
await json('DELETE', `/api/classes/${classId}`);
const remaining = await json<{ name: string }[]>('GET', '/api/classes');
ok(!remaining.data.some((row) => row.name === 'Despliegue · prueba'), 'limpieza completada');

console.log(`\n✓ Humo de despliegue completado (${checks} comprobaciones) contra ${baseUrl}`);
