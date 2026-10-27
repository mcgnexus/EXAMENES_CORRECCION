import type { FastifyInstance } from 'fastify';
import { db, nowIso } from '../db';
import { notFound } from '../errors';
import { buildActivityCsv } from '../export/csv';
import { buildSubmissionReportPdf } from '../export/pdf';

async function markExported(submissionIds: number[]): Promise<void> {
  const stamp = nowIso();
  const updateGrade = db.prepare(
    "UPDATE grades SET status = 'exported', updated_at = $1 WHERE submission_id = $2 AND status = 'approved'",
  );
  const updateSubmission = db.prepare(
    "UPDATE submissions SET status = 'exported' WHERE id = $1 AND status = 'approved'",
  );
  for (const submissionId of submissionIds) {
    await updateGrade.run(stamp, submissionId);
    await updateSubmission.run(submissionId);
  }
}

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/activities/:id/export.csv', async (request, reply) => {
    const activityId = Number((request.params as { id: string }).id);
    const exists = await db.prepare('SELECT id FROM activities WHERE id = $1').get(activityId);
    if (!exists) throw notFound('Actividad no encontrada');

    const approved = await db
      .prepare("SELECT id FROM submissions WHERE activity_id = $1 AND status = 'approved'")
      .all<{ id: number }>(activityId);
    await markExported(approved.map((row) => row.id));

    const { filename, content } = await buildActivityCsv(activityId);

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(content);
  });

  app.get('/api/submissions/:id/report.pdf', async (request, reply) => {
    const submissionId = Number((request.params as { id: string }).id);
    const exists = await db.prepare('SELECT id FROM submissions WHERE id = $1').get(submissionId);
    if (!exists) throw notFound('Entrega no encontrada');

    const { filename, buffer } = await buildSubmissionReportPdf(submissionId);
    await markExported([submissionId]);

    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Content-Length', buffer.length);
    return reply.send(buffer);
  });
}
