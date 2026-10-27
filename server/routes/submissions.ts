import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, getSettings, nowIso } from '../db';
import { badRequest, conflict, notFound } from '../errors';
import { emitEvent } from '../events';
import { getSubmissionDetail, getSubmissionRow, listSubmissions } from '../mappers';
import { collectMultipart } from '../multipart';
import { insertFile, removeOwnerFiles, storeUpload } from '../storage';
import { round1 } from '../pipeline/aggregate';

const gradeSchema = z.object({
  items: z.array(
    z.object({
      rubricItemId: z.number().int().positive(),
      points: z.number().min(0),
      comment: z.string().max(4000).optional().default(''),
    }),
  ),
  overallComment: z.string().max(8000).optional().default(''),
});

function assertSubmission(submissionId: number): {
  id: number;
  activity_id: number;
  student_id: number;
} {
  const row = db
    .prepare('SELECT id, activity_id, student_id FROM submissions WHERE id = ?')
    .get(submissionId) as { id: number; activity_id: number; student_id: number } | undefined;
  if (!row) throw notFound('Entrega no encontrada');
  return row;
}

function resetCorrectionData(submissionId: number): void {
  db.prepare('DELETE FROM evaluations WHERE submission_id = ?').run(submissionId);
  db.prepare('DELETE FROM grades WHERE submission_id = ?').run(submissionId);
}

export async function registerSubmissionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/submissions/:id', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    const detail = getSubmissionDetail(submissionId);
    if (!detail) throw notFound('Entrega no encontrada');
    return detail;
  });

  app.get('/api/submissions', async (request) => {
    const activityId = Number((request.query as { activityId?: string }).activityId ?? 0);
    if (!activityId) throw badRequest('Falta activityId');
    return listSubmissions(activityId);
  });

  app.post('/api/submissions', async (request, reply) => {
    const { fields, files } = await collectMultipart(request);
    const activityId = Number(fields.activityId);
    const studentId = Number(fields.studentId);
    if (!Number.isInteger(activityId) || !Number.isInteger(studentId)) {
      throw badRequest('Faltan activityId o studentId');
    }
    if (files.length === 0) throw badRequest('No se ha recibido ningún archivo');

    const activity = db
      .prepare('SELECT id, class_id FROM activities WHERE id = ?')
      .get(activityId) as { id: number; class_id: number | null } | undefined;
    if (!activity) throw notFound('Actividad no encontrada');

    const student = db
      .prepare('SELECT id, class_id, name FROM students WHERE id = ?')
      .get(studentId) as { id: number; class_id: number; name: string } | undefined;
    if (!student) throw notFound('Alumno no encontrado');
    if (activity.class_id && activity.class_id !== student.class_id) {
      throw badRequest('El alumno no pertenece a la clase de la actividad');
    }

    let submission = db
      .prepare('SELECT id FROM submissions WHERE activity_id = ? AND student_id = ?')
      .get(activityId, studentId) as { id: number } | undefined;

    let submissionId: number;
    if (submission) {
      submissionId = submission.id;
    } else {
      const created = db
        .prepare(
          "INSERT INTO submissions (activity_id, student_id, status, created_at) VALUES (?, ?, 'uploaded', ?)",
        )
        .run(activityId, studentId, nowIso());
      submissionId = Number(created.lastInsertRowid);
    }

    let pageNo =
      ((
        db
          .prepare(
            "SELECT COALESCE(MAX(page_no), 0) AS max FROM files WHERE owner_type = 'submission' AND owner_id = ? AND kind = 'page'",
          )
          .get(submissionId) as { max: number }
      ).max ?? 0) + 1;

    for (const file of files) {
      const stored = await storeUpload('submission', submissionId, file);
      insertFile({
        ownerType: 'submission',
        ownerId: submissionId,
        originalName: stored.original.originalName,
        storedPath: stored.original.storedPath,
        mime: stored.original.mime,
        kind: 'original',
        pageNo: null,
      });
      for (const page of stored.pages) {
        insertFile({
          ownerType: 'submission',
          ownerId: submissionId,
          originalName: stored.original.originalName,
          storedPath: page.storedPath,
          mime: page.mime,
          kind: 'page',
          pageNo,
        });
        pageNo += 1;
      }
    }

    resetCorrectionData(submissionId);
    db.prepare(
      "UPDATE submissions SET status = 'uploaded', error = NULL, reading = NULL WHERE id = ?",
    ).run(submissionId);
    emitEvent({ type: 'submission', submissionId, status: 'uploaded' });

    reply.code(submission ? 200 : 201);
    return getSubmissionDetail(submissionId);
  });

  app.delete('/api/submissions/:id', async (request, reply) => {
    const submissionId = Number((request.params as { id: string }).id);
    assertSubmission(submissionId);
    await removeOwnerFiles('submission', submissionId);
    db.prepare('DELETE FROM submissions WHERE id = ?').run(submissionId);
    reply.code(204).send();
  });

  app.post('/api/submissions/:id/move', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    const submission = assertSubmission(submissionId);
    const body = z.object({ studentId: z.number().int().positive() }).parse(request.body ?? {});

    const activity = db
      .prepare('SELECT class_id FROM activities WHERE id = ?')
      .get(submission.activity_id) as { class_id: number | null };
    const student = db
      .prepare('SELECT id, class_id, name FROM students WHERE id = ?')
      .get(body.studentId) as { id: number; class_id: number; name: string } | undefined;
    if (!student) throw notFound('Alumno no encontrado');
    if (activity.class_id && activity.class_id !== student.class_id) {
      throw badRequest('El alumno no pertenece a la clase de la actividad');
    }
    const existing = db
      .prepare('SELECT id FROM submissions WHERE activity_id = ? AND student_id = ?')
      .get(submission.activity_id, body.studentId) as { id: number } | undefined;
    if (existing && existing.id !== submissionId) {
      throw conflict('Ese alumno ya tiene una entrega en esta actividad');
    }

    db.prepare('UPDATE submissions SET student_id = ? WHERE id = ?').run(body.studentId, submissionId);
    return getSubmissionDetail(submissionId);
  });

  app.put('/api/submissions/:id/grade', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    const submission = assertSubmission(submissionId);
    const body = gradeSchema.parse(request.body ?? {});

    const rubric = db
      .prepare('SELECT id, max_points FROM rubric_items WHERE activity_id = ? ORDER BY ord ASC, id ASC')
      .all(submission.activity_id) as { id: number; max_points: number }[];
    if (rubric.length === 0) throw badRequest('La actividad no tiene rúbrica');

    const byId = new Map(rubric.map((item) => [item.id, item]));
    const seen = new Set<number>();
    const items = body.items.map((item) => {
      const rubricItem = byId.get(item.rubricItemId);
      if (!rubricItem) throw badRequest(`El apartado ${item.rubricItemId} no pertenece a la rúbrica`);
      if (seen.has(item.rubricItemId)) throw badRequest('Apartado duplicado en la corrección');
      seen.add(item.rubricItemId);
      return {
        rubricItemId: item.rubricItemId,
        points: round1(Math.min(rubricItem.max_points, Math.max(0, item.points))),
        comment: item.comment ?? '',
      };
    });
    for (const rubricItem of rubric) {
      if (!seen.has(rubricItem.id)) {
        throw badRequest('Faltan apartados por puntuar en la corrección');
      }
    }

    const total = round1(items.reduce((sum, item) => sum + item.points, 0));
    const timestamp = nowIso();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO grades (submission_id, total, overall_comment, status, approved_at, updated_at)
         VALUES (?, ?, ?, 'draft', NULL, ?)
         ON CONFLICT(submission_id) DO UPDATE SET total = excluded.total,
           overall_comment = excluded.overall_comment, status = 'draft',
           approved_at = NULL, updated_at = excluded.updated_at`,
      ).run(submissionId, total, body.overallComment ?? '', timestamp);
      db.prepare('DELETE FROM grade_items WHERE submission_id = ?').run(submissionId);
      const insert = db.prepare(
        `INSERT INTO grade_items (submission_id, rubric_item_id, points, comment, source)
         VALUES (?, ?, ?, ?, 'manual')`,
      );
      for (const item of items) {
        insert.run(submissionId, item.rubricItemId, item.points, item.comment);
      }
      db.prepare("UPDATE submissions SET status = 'reviewed' WHERE id = ?").run(submissionId);
    })();

    emitEvent({ type: 'submission', submissionId, status: 'reviewed' });
    return getSubmissionDetail(submissionId);
  });

  app.post('/api/submissions/:id/approve', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    const submission = assertSubmission(submissionId);
    const grade = db
      .prepare('SELECT id FROM grades WHERE submission_id = ?')
      .get(submissionId) as { id: number } | undefined;
    if (!grade) throw badRequest('Todavía no hay una corrección que aprobar');

    const rubricCount = (
      db
        .prepare('SELECT COUNT(*) AS total FROM rubric_items WHERE activity_id = ?')
        .get(submission.activity_id) as { total: number }
    ).total;
    const gradeCount = (
      db
        .prepare('SELECT COUNT(*) AS total FROM grade_items WHERE submission_id = ?')
        .get(submissionId) as { total: number }
    ).total;
    if (gradeCount < rubricCount) {
      throw badRequest('Faltan apartados por puntuar antes de aprobar');
    }

    const timestamp = nowIso();
    db.transaction(() => {
      db.prepare(
        "UPDATE grades SET status = 'approved', approved_at = ?, updated_at = ? WHERE submission_id = ?",
      ).run(timestamp, timestamp, submissionId);
      db.prepare("UPDATE submissions SET status = 'approved' WHERE id = ?").run(submissionId);
    })();

    emitEvent({ type: 'submission', submissionId, status: 'approved' });
    return getSubmissionDetail(submissionId);
  });

  app.post('/api/submissions/:id/unapprove', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    assertSubmission(submissionId);
    const timestamp = nowIso();
    db.transaction(() => {
      db.prepare(
        "UPDATE grades SET status = 'draft', approved_at = NULL, updated_at = ? WHERE submission_id = ?",
      ).run(timestamp, submissionId);
      db.prepare("UPDATE submissions SET status = 'reviewed' WHERE id = ?").run(submissionId);
    })();
    emitEvent({ type: 'submission', submissionId, status: 'reviewed' });
    return getSubmissionDetail(submissionId);
  });

  app.get('/api/submissions/:id/brief', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    const row = getSubmissionRow(submissionId);
    if (!row) throw notFound('Entrega no encontrada');
    return row;
  });

  app.get('/api/config', async () => ({ settings: getSettings() }));
}
