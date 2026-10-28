import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

type PdfJsModule = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfJsModule> | undefined;

/** Carga PDF.js solo cuando se sube un PDF, para no engordar el bundle inicial. */
async function loadPdfJs(): Promise<PdfJsModule> {
  pdfjsPromise ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return pdfjsPromise;
}

const MAX_PAGES = 40;
const TARGET_WIDTH = 1600;
const JPEG_QUALITY = 0.88;

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function pageFileName(name: string, page: number): string {
  const base = name.replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '_') || 'documento';
  return `${base}-pagina-${String(page).padStart(2, '0')}.jpg`;
}

async function canvasToFile(
  canvas: HTMLCanvasElement,
  name: string,
  quality: number,
): Promise<File> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((result) => resolve(result), 'image/jpeg', quality),
  );
  if (!blob) throw new Error('No se ha podido generar la imagen de una página del PDF');
  return new File([blob], name, { type: 'image/jpeg' });
}

export interface PdfProgress {
  file: string;
  page: number;
  totalPages: number;
}

/**
 * Sustituye cada PDF por una imagen JPEG por página, renderizada en el propio
 * navegador con PDF.js. Evita depender de Poppler en el servidor.
 */
export async function expandPdfFiles(
  files: File[],
  onProgress?: (progress: PdfProgress) => void,
): Promise<File[]> {
  const result: File[] = [];

  for (const file of files) {
    if (!isPdfFile(file)) {
      result.push(file);
      continue;
    }

    let loadingTask: PDFDocumentLoadingTask;
    let pdfDocument: PDFDocumentProxy;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const pdfjs = await loadPdfJs();
      loadingTask = pdfjs.getDocument({ data });
      pdfDocument = await loadingTask.promise;
    } catch {
      throw new Error(
        `No se ha podido abrir «${file.name}». Comprueba que no esté dañado ni protegido con contraseña.`,
      );
    }

    const totalPages = Math.min(pdfDocument.numPages, MAX_PAGES);
    // PDFs largos: páginas algo más pequeñas para no superar el límite de subida.
    const targetWidth = totalPages > 8 ? 1200 : TARGET_WIDTH;
    const quality = totalPages > 8 ? 0.78 : JPEG_QUALITY;
    try {
      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
        onProgress?.({ file: file.name, page: pageNumber, totalPages });
        const page = await pdfDocument.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(targetWidth / base.width, 2);
        const viewport = page.getViewport({ scale });
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('El navegador no permite renderizar el PDF');

        await page.render({ canvasContext: context, viewport, canvas }).promise;
        result.push(await canvasToFile(canvas, pageFileName(file.name, pageNumber), quality));
        page.cleanup();
      }
    } finally {
      await loadingTask.destroy();
    }
  }

  return result;
}
