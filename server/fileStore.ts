import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { del, get, head, put } from '@vercel/blob';
import { FILES_DIR } from './db';

/**
 * Almacenamiento de archivos de exámenes. En Vercel usa Blob privado; en local,
 * disco. El `stored_path` de la base de datos es el pathname en ambos casos.
 */
const useBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

function safeRelPath(relPath: string): string {
  const normalized = relPath.split(path.sep).join('/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').includes('..')) {
    throw new Error('Ruta de archivo no válida');
  }
  return normalized;
}

function localPath(relPath: string): string {
  return path.join(FILES_DIR, safeRelPath(relPath));
}

export function storageKind(): 'blob' | 'local' {
  return useBlob ? 'blob' : 'local';
}

export async function writeStoredFile(
  relPath: string,
  buffer: Buffer,
  mime: string,
): Promise<void> {
  const pathname = safeRelPath(relPath);
  if (useBlob) {
    await put(pathname, buffer, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: mime,
    });
    return;
  }
  const target = localPath(pathname);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
}

export async function readStoredFile(relPath: string): Promise<Buffer> {
  const pathname = safeRelPath(relPath);
  if (useBlob) {
    const result = await get(pathname, { access: 'private' });
    if (!result) throw new Error('El archivo ya no existe en Blob');
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }
  return fs.readFile(localPath(pathname));
}

export async function storedFileExists(relPath: string): Promise<boolean> {
  const pathname = safeRelPath(relPath);
  if (useBlob) {
    try {
      await head(pathname);
      return true;
    } catch {
      return false;
    }
  }
  return fssync.existsSync(localPath(pathname));
}

export async function removeStoredFile(relPath: string): Promise<void> {
  const pathname = safeRelPath(relPath);
  if (useBlob) {
    try {
      await del(pathname);
    } catch {
      /* ya no existe */
    }
    return;
  }
  await fs.rm(localPath(pathname), { force: true });
}
