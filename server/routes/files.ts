import { createReadStream } from 'node:fs';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { notFound } from '../errors';
import { absPath } from '../storage';

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/files/:id', async (request, reply) => {
    const fileId = Number((request.params as { id: string }).id);
    const row = await db
      .prepare('SELECT * FROM files WHERE id = $1')
      .get<{ id: number; stored_path: string; mime: string; original_name: string }>(fileId);
    if (!row) throw notFound('Archivo no encontrado');
    const fullPath = absPath(row.stored_path);
    if (!fs.existsSync(fullPath)) throw notFound('El archivo ya no existe en disco');

    reply.header('Content-Type', row.mime);
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.send(createReadStream(fullPath));
  });
}
