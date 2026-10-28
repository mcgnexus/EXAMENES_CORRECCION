import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { notFound } from '../errors';
import { readStoredFile, storedFileExists } from '../fileStore';

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/files/:id', async (request, reply) => {
    const fileId = Number((request.params as { id: string }).id);
    const row = await db
      .prepare('SELECT * FROM files WHERE id = $1')
      .get<{ id: number; stored_path: string; mime: string; original_name: string }>(fileId);
    if (!row) throw notFound('Archivo no encontrado');
    if (!(await storedFileExists(row.stored_path))) {
      throw notFound('El archivo ya no existe en el almacenamiento');
    }

    const buffer = await readStoredFile(row.stored_path);
    reply.header('Content-Type', row.mime);
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.send(buffer);
  });
}
