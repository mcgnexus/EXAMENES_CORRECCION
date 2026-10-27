/**
 * Prueba de persistencia del volumen de Railway.
 *   npx tsx scripts/_volume-probe.ts create  <BASE> <user:pass>   → imprime {classId,activityId,fileUrl}
 *   npx tsx scripts/_volume-probe.ts verify  <BASE> <user:pass> '<json>'  → 200 = volumen presente; borra el marco
 */
import PDFDocument from 'pdfkit';

const [, , mode, baseUrl, auth, payload] = process.argv;
if (!mode || !baseUrl || !auth) {
  console.error('Uso: _volume-probe.ts create|verify <BASE> <user:pass> [json]');
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

function makePdf(line: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.text(line);
    doc.end();
  });
}

async function uploadDocument(activityId: number, buffer: Buffer) {
  const form = new FormData();
  form.append('kind', 'enunciado');
  form.append('name', 'Probe de volumen');
  form.append('file', new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }), 'probe.pdf');
  const response = await fetch(`${baseUrl}/api/activities/${activityId}/documents`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (response.status !== 201) throw new Error(`upload → ${response.status}: ${await response.text()}`);
  return (await response.json()) as { id: number; originalFileId: number | null };
}

if (mode === 'create') {
  const createdClass = await json<{ id: number }>('POST', '/api/classes', {
    name: 'Volume probe',
    subject: 'biologia',
  });
  const classId = createdClass.data.id;
  const activity = await json<{ activity: { id: number } }>('POST', '/api/activities', {
    title: 'Volume probe',
    subject: 'biologia',
    classId,
  });
  const activityId = activity.data.activity.id;
  const document = await uploadDocument(activityId, await makePdf('Marcador de volumen'));
  const fileUrl = document.originalFileId ? `/api/files/${document.originalFileId}` : null;
  if (!fileUrl) throw new Error('sin originalFileId');
  const head = await fetch(baseUrl + fileUrl, { headers });
  if (head.status !== 200) throw new Error(`lectura inicial → ${head.status}`);
  console.log(JSON.stringify({ classId, activityId, documentId: document.id, fileUrl, initial: head.status }));
} else if (mode === 'verify') {
  // Argumentos posicionales: PowerShell 5.1 pierde las comillas del JSON al
  // pasarlos como argumento de proceso nativo.
  const [, , , , , classIdRaw, activityIdRaw, documentIdRaw, fileUrl] = process.argv;
  const classId = Number(classIdRaw);
  const activityId = Number(activityIdRaw);
  const documentId = Number(documentIdRaw);
  const after = await fetch(baseUrl + fileUrl, { headers });
  console.log(`lectura tras reinicio → ${after.status} (${after.headers.get('content-type') ?? 'sin tipo'})`);
  // Limpieza del marco
  await json('DELETE', `/api/documents/${documentId}`);
  await json('DELETE', `/api/activities/${activityId}`);
  await json('DELETE', `/api/classes/${classId}`);
  if (after.status === 200) {
    console.log('VOLUMEN PRESENTE: el fichero sobrevivió al reinicio.');
    process.exit(0);
  }
  console.log('SIN VOLUMEN: el fichero desapareció con el contenedor.');
  process.exit(1);
} else {
  console.error(`modo desconocido: ${mode}`);
  process.exit(2);
}
