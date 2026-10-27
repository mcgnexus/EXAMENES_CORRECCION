import type { FastifyInstance } from 'fastify';
import { db, nowIso } from '../db';
import { notFound } from '../errors';
import { buildActivityCsv } from '../export/csv';
import { buildSubmissionReportPdf } from '../export/pdf';

function markExported(submissionIds: number[]): void {
  const stamp = nowIso();
  const updateGrade = db.prepare(
    "UPDATE grades SET status = 'exported', updated_at = ? WHERE submission_id = ? AND status = 'approved'",
  );
  const updateSubmission = db.prepare(
    "UPDATE submissions SET status = 'exported' WHERE id = ? AND status = 'approved'",
  );
  for (const submissionId of submissionIds) {
    updateGrade.run(stamp, submissionId);
    updateSubmission.run(submissionId);
  }
}

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/activities/:id/export.csv', async (request, reply) => {
    const activityId = Number((request.params as { id: string }).id);
    const exists = db.prepare('SELECT id FROM activities WHERE id = ?').get(activityId);
    if (!exists) throw notFound('Actividad no encontrada');

    const approved = db
      .prepare("SELECT id FROM submissions WHERE activity_id = ? AND status = 'approved'")
      .all(activityId) as { id: number }[];
    markExported(approved.map((row) => row.id));

    const { filename, content } = buildActivityCsv(activityId);

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(content);
  });

  app.get('/api/submissions/:id/report.pdf', async (request, reply) => {
    const submissionId = Number((request.params as { id: string }).id);
    const exists = db.prepare('SELECT id FROM submissions WHERE id = ?').get(submissionId);
    if (!exists) throw notFound('Entrega no encontrada');

    const { filename, buffer } = await buildSubmissionReportPdf(submissionId);
    markExported([submissionId]);

    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Content-Length', buffer.length);
    return reply.send(buffer);
  });
}
