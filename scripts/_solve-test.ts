/**
 * Prueba real de generación de plantilla de respuestas contra producción.
 * Uso: npx tsx scripts/_solve-test.ts <BASE_URL> <user:pass>
 */
import PDFDocument from 'pdfkit';

const [, , baseUrl, auth] = process.argv;
if (!baseUrl || !auth) {
  console.error('Uso: npx tsx scripts/_solve-test.ts <BASE_URL> <user:pass>');
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

const activity = await json<{ activity: { id: number } }>('POST', '/api/activities', {
  title: 'Prueba de plantilla IA · Lípidos',
  subject: 'bioquimica',
});
const activityId = activity.data.activity.id;
const rubric = await json('PUT', `/api/activities/${activityId}/rubric`, {
  items: [
    { title: 'Clasificación de lípidos', maxPoints: 2 },
    { title: 'Modelo de mosaico fluido', maxPoints: 2 },
    { title: 'Saturados e insaturados', maxPoints: 3 },
    { title: 'Temperatura y permeabilidad', maxPoints: 3 },
  ],
});
if (rubric.status !== 200) throw new Error('rúbrica');

const examPdf = await makePdf([
  'EXAMEN DE BIOQUÍMICA · UNIDAD 4 · LÍPIDOS Y MEMBRANAS',
  'Apartado 1 (2 puntos). Clasifica los lípidos según su función biológica y cita un ejemplo de cada grupo.',
  'Apartado 2 (2 puntos). Describe la estructura de una membrana plasmática según el modelo de mosaico fluido.',
  'Apartado 3 (3 puntos). Explica las diferencias entre ácidos grasos saturados e insaturados y su impacto en la fluidez de la membrana.',
  'Apartado 4 (3 puntos). Razona qué ocurriría con la permeabilidad de una membrana si disminuye la temperatura ambiente.',
]);
const form = new FormData();
form.append('kind', 'enunciado');
form.append('name', 'Enunciado');
form.append('file', new Blob([new Uint8Array(examPdf)], { type: 'application/pdf' }), 'enunciado.pdf');
const up = await fetch(`${baseUrl}/api/activities/${activityId}/documents`, { method: 'POST', headers, body: form });
if (up.status !== 201) throw new Error(`enunciado → ${up.status}`);

console.log('Generando plantilla con IA...');
const t0 = Date.now();
const generated = await json<{ id: number; kind: string; name: string; text: string | null }[]>(
  'POST',
  `/api/activities/${activityId}/generate-solution`,
);
const secs = Math.round((Date.now() - t0) / 1000);
const solucion = generated.data.find(
  (doc) => doc.kind === 'solucion' && doc.name === 'Solución generada por IA',
);
if (generated.status !== 200 || !solucion) {
  console.log(`FALLO HTTP ${generated.status} en ${secs}s:`, JSON.stringify(generated.data).slice(0, 400));
  process.exit(1);
}
console.log(`✓ Plantilla generada en ${secs}s (${(solucion.text ?? '').length} caracteres)\n`);
console.log('--- INICIO DE LA PLANTILLA (primeros 1800 caracteres) ---');
console.log((solucion.text ?? '').slice(0, 1800));
console.log('--- FIN DEL Extracto ---');

// Limpieza
await json('DELETE', `/api/documents/${solucion.id}`);
const docs = await json<{ documents: { id: number; originalFileId: number | null }[] }>(
  'GET',
  `/api/activities/${activityId}`,
);
for (const doc of docs.data.documents) await json('DELETE', `/api/documents/${doc.id}`);
await json('DELETE', `/api/activities/${activityId}`);
console.log('\nlimpieza completada.');
