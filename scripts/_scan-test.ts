/**
 * Prueba real del escáner contra la URL desplegada (usa el modelo primario).
 * Uso: npx tsx scripts/_scan-test.ts <BASE_URL> <user:pass>
 */
import PDFDocument from 'pdfkit';

const [, , baseUrl, auth] = process.argv;
if (!baseUrl || !auth) {
  console.error('Uso: npx tsx scripts/_scan-test.ts <BASE_URL> <user:pass>');
  process.exit(2);
}
const headers = { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` };

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

async function scan(esperado: string, buffer: Buffer, name: string) {
  const form = new FormData();
  form.append('esperado', esperado);
  form.append('file', new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }), name);
  const t0 = Date.now();
  const response = await fetch(`${baseUrl}/api/scan`, { method: 'POST', headers, body: form });
  const secs = Math.round((Date.now() - t0) / 1000);
  const text = await response.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, secs, data };
}

// Prueba 1: examen
const examPdf = await makePdf([
  'EXAMEN DE BIOQUÍMICA · UNIDAD 4 · LIPIDOS Y MEMBRANAS',
  'Universidad de Alcalá · Grado en Biología · Curso 2026-2027',
  '',
  'Apartado 1 (2 puntos). Clasifica los lípidos según su función biológica y cita un ejemplo de cada grupo.',
  'Apartado 2 (2 puntos). Describe la estructura de una membrana plasmática según el modelo de mosaico fluido.',
  'Apartado 3 (3 puntos). Explica las diferencias entre ácidos grasos saturados e insaturados y su impacto en la fluidez de la membrana.',
  'Apartado 4 (3 puntos). Razona qué ocurriría con la permeabilidad de una membrana si disminuye la temperatura ambiente.',
]);

const exam = await scan('examen', examPdf, 'examen-lipidos.pdf');
console.log(`\n== EXAMEN → HTTP ${exam.status} en ${exam.secs}s ==`);
const examData = exam.data as {
  tipo?: string;
  titulo?: string;
  asignatura?: string;
  enunciado?: string;
  apartados?: { title: string; maxPoints: number }[];
  observaciones?: string;
  error?: string;
};
if (exam.status !== 200) {
  console.log(examData);
} else {
  console.log('tipo:', examData.tipo);
  console.log('titulo:', examData.titulo);
  console.log('asignatura:', examData.asignatura);
  console.log('enunciado:', (examData.enunciado ?? '').slice(0, 300).replace(/\n/g, ' | '));
  console.log('apartados:', JSON.stringify(examData.apartados));
  console.log('observaciones:', examData.observaciones);
}

// Prueba 2: lista de alumnos
const listPdf = await makePdf([
  'LISTA DE ALUMNOS · BIOQUÍMICA · GRUPO B · CURSO 2026-2027',
  '1. Laura Sánchez Moreno',
  '2. Javier Torres Ibáñez',
  '3. Carmen Ruiz Delgado',
  '4. Andrés Molina Serrano',
  '5. Lucía Fernández Ortiz',
  '6. Pablo Navarro Gil',
  '7. Elena Castaño Vidal',
]);

const list = await scan('lista', listPdf, 'lista-alumnos.pdf');
console.log(`\n== LISTA → HTTP ${list.status} en ${list.secs}s ==`);
const listData = list.data as { tipo?: string; nombres?: string[]; observaciones?: string; error?: string };
if (list.status !== 200) {
  console.log(listData);
} else {
  console.log('tipo:', listData.tipo);
  console.log('nombres detectados:', JSON.stringify(listData.nombres));
  console.log('observaciones:', listData.observaciones);
}
