import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import type { ImagePart } from './llm/types';
import { FILES_DIR, db, nowIso } from './db';
import {
  readStoredFile,
  removeStoredFile as removeStored,
  storedFileExists,
  writeStoredFile,
} from './fileStore';

const execFileAsync = promisify(execFile);

const MAX_IMAGE_SIDE = 2000;
const PDF_DPI = 150;
const MAX_PDF_PAGES = 40;

export function fileUrl(fileId: number): string {
  return `/api/files/${fileId}`;
}

async function writeBuffer(relPath: string, buffer: Buffer, mime: string): Promise<void> {
  await writeStoredFile(relPath, buffer, mime);
}

function randomName(ext: string): string {
  return `${crypto.randomBytes(8).toString('hex')}${ext ? `.${ext}` : ''}`;
}

export function extFromName(name: string): string {
  return (path.extname(name).replace('.', '') || 'bin').toLowerCase();
}

export function isPdf(mime: string, name: string): boolean {
  return mime === 'application/pdf' || extFromName(name) === 'pdf';
}

export function isImage(mime: string, name: string): boolean {
  const ext = extFromName(name);
  return mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'heic'].includes(ext);
}

export function isTextDocument(name: string): boolean {
  return ['txt', 'md', 'markdown', 'csv'].includes(extFromName(name));
}

async function normalizeImage(buffer: Buffer): Promise<{ buffer: Buffer; mime: string }> {
  try {
    const out = await sharp(buffer)
      .rotate()
      .resize({
        width: MAX_IMAGE_SIDE,
        height: MAX_IMAGE_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    return { buffer: out, mime: 'image/png' };
  } catch {
    return { buffer, mime: 'application/octet-stream' };
  }
}

async function pdfToPngBuffers(buffer: Buffer, tmpPrefix: string): Promise<Buffer[]> {
  const tmpDir = path.join(FILES_DIR, '_tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const pdfPath = path.join(tmpDir, `${tmpPrefix}.pdf`);
  const outPrefix = path.join(tmpDir, `${tmpPrefix}-page`);
  await fs.writeFile(pdfPath, buffer);
  try {
    await execFileAsync('pdftoppm', [
      '-png',
      '-r',
      String(PDF_DPI),
      '-f',
      '1',
      '-l',
      String(MAX_PDF_PAGES),
      pdfPath,
      outPrefix,
    ]);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new Error(
        'La conversión de PDF no está disponible en este entorno. Sube las páginas como imágenes JPG o PNG.',
      );
    }
    throw error;
  }
  try {
    const files = (await fs.readdir(tmpDir))
      .filter((name) => name.startsWith(`${tmpPrefix}-page`) && name.endsWith('.png'))
      .sort((a, b) => {
        const na = Number(a.match(/(\d+)\.png$/)?.[1] ?? 0);
        const nb = Number(b.match(/(\d+)\.png$/)?.[1] ?? 0);
        return na - nb;
      });
    const buffers: Buffer[] = [];
    for (const name of files) {
      buffers.push(await fs.readFile(path.join(tmpDir, name)));
    }
    return buffers;
  } finally {
    await fs.rm(pdfPath, { force: true });
    for (const name of await fs.readdir(tmpDir)) {
      if (name.startsWith(`${tmpPrefix}-page`)) {
        await fs.rm(path.join(tmpDir, name), { force: true });
      }
    }
  }
}

export interface StoredUpload {
  original: { storedPath: string; mime: string; originalName: string; size: number };
  pages: { storedPath: string; mime: string; pageNo: number }[];
  text: string | null;
}

/**
 * Convierte una subida (PDF o imagen) en ImageParts para el escáner, sin
 * persistir nada en disco. Máximo `maxPages` páginas.
 */
export async function renderUploadToImages(
  file: { buffer: Buffer; filename: string; mimetype: string },
  maxPages = 4,
): Promise<ImagePart[]> {
  const parts: ImagePart[] = [];
  if (isPdf(file.mimetype, file.filename)) {
    const rendered = await pdfToPngBuffers(
      file.buffer,
      `scan-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    );
    for (let index = 0; index < Math.min(rendered.length, maxPages); index += 1) {
      const normalized = await normalizeImage(rendered[index]);
      parts.push({
        label: `Página ${index + 1}`,
        mime: normalized.mime.startsWith('image/') ? normalized.mime : 'image/png',
        base64: normalized.buffer.toString('base64'),
      });
    }
    return parts;
  }
  if (isImage(file.mimetype, file.filename)) {
    const normalized = await normalizeImage(file.buffer);
    parts.push({
      label: 'Documento escaneado',
      mime: normalized.mime.startsWith('image/') ? normalized.mime : 'image/png',
      base64: normalized.buffer.toString('base64'),
    });
    return parts;
  }
  throw new Error('El escaneo admite imágenes (JPG/PNG/…) o PDF');
}

/**
 * Stores an uploaded exam/document. PDFs are expanded into one PNG per page,
 * images are normalized, plain-text documents are kept as text.
 */
export async function storeUpload(
  ownerType: 'document' | 'submission',
  ownerId: number,
  file: { buffer: Buffer; filename: string; mimetype: string },
): Promise<StoredUpload> {
  const ext = extFromName(file.filename);
  const relDir = path.join(ownerType, String(ownerId));
  const originalRel = path.join(relDir, randomName(ext));
  const pages: { storedPath: string; mime: string; pageNo: number }[] = [];
  let text: string | null = null;

  if (isPdf(file.mimetype, file.filename)) {
    const pdfRel = path.join(relDir, randomName('pdf'));
    await writeBuffer(pdfRel, file.buffer, 'application/pdf');
    const rendered = await pdfToPngBuffers(
      file.buffer,
      `${ownerType}-${ownerId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    );
    for (let i = 0; i < rendered.length; i += 1) {
      const normalized = await normalizeImage(rendered[i]);
      const pageRel = path.join(relDir, randomName('png'));
      await writeBuffer(pageRel, normalized.buffer, 'image/png');
      pages.push({ storedPath: pageRel, mime: 'image/png', pageNo: i + 1 });
    }
    return {
      original: { storedPath: pdfRel, mime: 'application/pdf', originalName: file.filename, size: file.buffer.length },
      pages,
      text,
    };
  }

  if (isImage(file.mimetype, file.filename)) {
    const normalized = await normalizeImage(file.buffer);
    const imgRel = path.join(relDir, randomName('png'));
    await writeBuffer(imgRel, normalized.buffer, normalized.mime);
    pages.push({ storedPath: imgRel, mime: 'image/png', pageNo: 1 });
    return {
      original: {
        storedPath: imgRel,
        mime: normalized.mime,
        originalName: file.filename,
        size: normalized.buffer.length,
      },
      pages,
      text,
    };
  }

  await writeBuffer(originalRel, file.buffer, file.mimetype);
  if (isTextDocument(file.filename)) {
    text = file.buffer.toString('utf8');
  }
  return {
    original: { storedPath: originalRel, mime: file.mimetype, originalName: file.filename, size: file.buffer.length },
    pages,
    text,
  };
}

export async function insertFile(input: {
  ownerType: 'document' | 'submission';
  ownerId: number;
  originalName: string;
  storedPath: string;
  mime: string;
  kind: 'original' | 'page';
  pageNo: number | null;
}): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO files (owner_type, owner_id, original_name, stored_path, mime, kind, page_no, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    )
    .get<{ id: number }>(
      input.ownerType,
      input.ownerId,
      input.originalName,
      input.storedPath,
      input.mime,
      input.kind,
      input.pageNo,
      nowIso(),
    );
  return row?.id ?? 0;
}

export async function readFileBase64(relPath: string): Promise<string> {
  const buffer = await readStoredFile(relPath);
  return buffer.toString('base64');
}

export async function fileExists(storedPath: string): Promise<boolean> {
  return storedFileExists(storedPath);
}

export async function removeStoredFile(storedPath: string): Promise<void> {
  await removeStored(storedPath);
}

export async function removeOwnerFiles(ownerType: string, ownerId: number): Promise<void> {
  const rows = await db
    .prepare('SELECT stored_path FROM files WHERE owner_type = $1 AND owner_id = $2')
    .all<{ stored_path: string }>(ownerType, ownerId);
  for (const row of rows) await removeStoredFile(row.stored_path);
  await db
    .prepare('DELETE FROM files WHERE owner_type = $1 AND owner_id = $2')
    .run(ownerType, ownerId);
}
