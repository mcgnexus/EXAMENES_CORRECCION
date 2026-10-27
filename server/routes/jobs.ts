import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db';
import { badRequest, notFound } from '../errors';
import { getJob, listJobs, startCorrectJob } from '../pipeline/queue';

const correctSchema = z.object({
  submissionIds: z
    .array(z.number().int().positive())
    .min(1, 'Selecciona al menos una entrega')
    .max(10, 'Un lote no puede superar las 10 entregas'),
});

export async function registerJobRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/jobs/correct', async (request, reply) => {
    const body = correctSchema.parse(request.body ?? {});
    const unique = [...new Set(body.submissionIds)];
    if (unique.length !== body.submissionIds.length) {
      throw badRequest('Hay entregas repetidas en el lote');
    }

    const placeholders = unique.map((_, index) => `$${index + 1}`).join(',');
    const rows = await db
      .prepare(`SELECT id, activity_id, status FROM submissions WHERE id IN (${placeholders})`)
      .all<{ id: number; activity_id: number; status: string }>(...unique);
    if (rows.length !== unique.length) throw notFound('Alguna de las entregas no existe');

    const activityIds = new Set(rows.map((row) => row.activity_id));
    if (activityIds.size > 1) {
      throw badRequest('Todas las entregas del lote deben ser de la misma actividad');
    }

    const job = await startCorrectJob(unique);
    reply.code(202);
    return job;
  });

  app.get('/api/jobs', async () => listJobs(20));

  app.get('/api/jobs/:id', async (request) => {
    const jobId = Number((request.params as { id: string }).id);
    const job = await getJob(jobId);
    if (!job) throw notFound('Trabajo no encontrado');
    return job;
  });
}
