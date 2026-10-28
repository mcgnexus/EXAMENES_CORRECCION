import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, getSettings, nowIso } from '../db';
import { badRequest, conflict, notFound } from '../errors';
import { emitEvent } from '../events';
import { getSubmissionDetail, getSubmissionRow, listSubmissions } from '../mappers';
import { collectMultipart } from '../multipart';
import { insertFile, readFileBase64, removeOwnerFiles, storeUpload } from '../storage';
import { runProviderRead, runWithModelFailover } from '../llm/providers';
import type { ImagePart } from '../llm/types';
import { round1 } from '../pipeline/aggregate';
import { detectAnswerSheet } from '../omr';
import { getOmrConfig } from './omr';
import { scoreAnswers,configSchema } from '../../shared/omr';

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

async function assertSubmission(submissionId: number): Promise<{
  id: number;
  activity_id: number;
  student_id: number;
}> {
  const row = await db
    .prepare('SELECT id, activity_id, student_id FROM submissions WHERE id = $1')
    .get<{ id: number; activity_id: number; student_id: number }>(submissionId);
  if (!row) throw notFound('Entrega no encontrada');
  return row;
}

async function resetCorrectionData(submissionId: number): Promise<void> {
  await db.prepare('DELETE FROM evaluations WHERE submission_id = $1').run(submissionId);
  await db.prepare('DELETE FROM grades WHERE submission_id = $1').run(submissionId);
}

export async function registerSubmissionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/submissions/:id', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    const detail = await getSubmissionDetail(submissionId);
    if (!detail) throw notFound('Entrega no encontrada');
    return detail;
  });

  app.post('/api/submissions/:id/detect-bubbles', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    const submission = await assertSubmission(submissionId);
    const row = await db.prepare("SELECT stored_path FROM files WHERE owner_type='submission' AND owner_id=$1 AND kind='page' ORDER BY page_no ASC LIMIT 1").get<{stored_path:string}>(submissionId);
    if (!row) throw badRequest('No hay página de imagen que analizar');
    const base64 = await readFileBase64(row.stored_path);
    const config = await getOmrConfig(submission.activity_id);
    const answers = await detectAnswerSheet(Buffer.from(base64, 'base64'),config.template);
    return { answers, config, warning: 'Confirma visualmente las marcas antes de aplicar la nota.' };
  });

  app.post('/api/submissions/:id/grade-bubbles', async (request) => {
    const submissionId = Number((request.params as {id:string}).id);
    const submission = await assertSubmission(submissionId);
    const body = z.object({answers:z.array(z.object({question:z.number().int().min(1).max(200), answer:z.string().regex(/^[A-H]$/).nullable()})).min(1).max(200), confirmed:z.literal(true),config:z.unknown()}).parse(request.body);
    const config=await getOmrConfig(submission.activity_id);
    if(JSON.stringify(configSchema.parse(body.config))!==JSON.stringify(config)) throw conflict('La configuración ha cambiado: repite la detección y revisión.');
    // Preview only: never change submission status or claim that this is a saved grade.
    try{return scoreAnswers(body.answers,config);}catch(error){throw badRequest(error instanceof Error?error.message:'Respuestas inválidas');}
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

    const activity = await db
      .prepare('SELECT id, class_id FROM activities WHERE id = $1')
      .get<{ id: number; class_id: number | null }>(activityId);
    if (!activity) throw notFound('Actividad no encontrada');

    const student = await db
      .prepare('SELECT id, class_id, name FROM students WHERE id = $1')
      .get<{ id: number; class_id: number; name: string }>(studentId);
    if (!student) throw notFound('Alumno no encontrado');
    if (activity.class_id && activity.class_id !== student.class_id) {
      throw badRequest('El alumno no pertenece a la clase de la actividad');
    }

    const existing = await db
      .prepare('SELECT id FROM submissions WHERE activity_id = $1 AND student_id = $2')
      .get<{ id: number }>(activityId, studentId);

    let submissionId: number;
    if (existing) {
      submissionId = existing.id;
    } else {
      const created = await db
        .prepare(
          "INSERT INTO submissions (activity_id, student_id, status, created_at) VALUES ($1, $2, 'uploaded', $3) RETURNING id",
        )
        .get<{ id: number }>(activityId, studentId, nowIso());
      submissionId = created?.id ?? 0;
    }

    const maxPage = await db
      .prepare(
        "SELECT COALESCE(MAX(page_no), 0) AS max FROM files WHERE owner_type = 'submission' AND owner_id = $1 AND kind = 'page'",
      )
      .get<{ max: number }>(submissionId);
    let pageNo = (maxPage?.max ?? 0) + 1;

    for (const file of files) {
      const stored = await storeUpload('submission', submissionId, file);
      await insertFile({
        ownerType: 'submission',
        ownerId: submissionId,
        originalName: stored.original.originalName,
        storedPath: stored.original.storedPath,
        mime: stored.original.mime,
        kind: 'original',
        pageNo: null,
      });
      for (const page of stored.pages) {
        await insertFile({
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

    await resetCorrectionData(submissionId);
    await db
      .prepare(
        "UPDATE submissions SET status = 'uploaded', error = NULL, reading = NULL WHERE id = $1",
      )
      .run(submissionId);
    emitEvent({ type: 'submission', submissionId, status: 'uploaded' });

    reply.code(existing ? 200 : 201);
    return getSubmissionDetail(submissionId);
  });

  app.delete('/api/submissions/:id', async (request, reply) => {
    const submissionId = Number((request.params as { id: string }).id);
    await assertSubmission(submissionId);
    await removeOwnerFiles('submission', submissionId);
    await db.prepare('DELETE FROM submissions WHERE id = $1').run(submissionId);
    reply.code(204).send();
  });

  app.post('/api/submissions/:id/move', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    const submission = await assertSubmission(submissionId);
    const body = z.object({ studentId: z.number().int().positive() }).parse(request.body ?? {});

    const activity = await db
      .prepare('SELECT class_id FROM activities WHERE id = $1')
      .get<{ class_id: number | null }>(submission.activity_id);
    const student = await db
      .prepare('SELECT id, class_id, name FROM students WHERE id = $1')
      .get<{ id: number; class_id: number; name: string }>(body.studentId);
    if (!student) throw notFound('Alumno no encontrado');
    if (activity?.class_id && activity.class_id !== student.class_id) {
      throw badRequest('El alumno no pertenece a la clase de la actividad');
    }
    const existing = await db
      .prepare('SELECT id FROM submissions WHERE activity_id = $1 AND student_id = $2')
      .get<{ id: number }>(submission.activity_id, body.studentId);
    if (existing && existing.id !== submissionId) {
      throw conflict('Ese alumno ya tiene una entrega en esta actividad');
    }

    await db
      .prepare('UPDATE submissions SET student_id = $1 WHERE id = $2')
      .run(body.studentId, submissionId);
    return getSubmissionDetail(submissionId);
  });

  app.put('/api/submissions/:id/grade', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    const submission = await assertSubmission(submissionId);
    const body = gradeSchema.parse(request.body ?? {});

    const rubric = await db
      .prepare('SELECT id, max_points FROM rubric_items WHERE activity_id = $1 ORDER BY ord ASC, id ASC')
      .all<{ id: number; max_points: number }>(submission.activity_id);
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
    await db.transaction(async (tx) => {
      await tx
        .prepare(
          `INSERT INTO grades (submission_id, total, overall_comment, status, approved_at, updated_at)
           VALUES ($1, $2, $3, 'draft', NULL, $4)
           ON CONFLICT(submission_id) DO UPDATE SET total = EXCLUDED.total,
             overall_comment = EXCLUDED.overall_comment, status = 'draft',
             approved_at = NULL, updated_at = EXCLUDED.updated_at`,
        )
        .run(submissionId, total, body.overallComment ?? '', timestamp);
      await tx.prepare('DELETE FROM grade_items WHERE submission_id = $1').run(submissionId);
      const insert = tx.prepare(
        `INSERT INTO grade_items (submission_id, rubric_item_id, points, comment, source)
         VALUES ($1, $2, $3, $4, 'manual')`,
      );
      for (const item of items) {
        await insert.run(submissionId, item.rubricItemId, item.points, item.comment);
      }
      await tx
        .prepare("UPDATE submissions SET status = 'reviewed' WHERE id = $1")
        .run(submissionId);
    });

    emitEvent({ type: 'submission', submissionId, status: 'reviewed' });
    return getSubmissionDetail(submissionId);
  });

  app.post('/api/submissions/:id/approve', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    const submission = await assertSubmission(submissionId);
    const grade = await db
      .prepare('SELECT id FROM grades WHERE submission_id = $1')
      .get(submissionId);
    if (!grade) throw badRequest('Todavía no hay una corrección que aprobar');

    const rubricCount = await db
      .prepare('SELECT COUNT(*) AS total FROM rubric_items WHERE activity_id = $1')
      .get<{ total: number }>(submission.activity_id);
    const gradeCount = await db
      .prepare('SELECT COUNT(*) AS total FROM grade_items WHERE submission_id = $1')
      .get<{ total: number }>(submissionId);
    if ((gradeCount?.total ?? 0) < (rubricCount?.total ?? 0)) {
      throw badRequest('Faltan apartados por puntuar antes de aprobar');
    }

    const timestamp = nowIso();
    await db.transaction(async (tx) => {
      await tx
        .prepare(
          "UPDATE grades SET status = 'approved', approved_at = $1, updated_at = $2 WHERE submission_id = $3",
        )
        .run(timestamp, timestamp, submissionId);
      await tx
        .prepare("UPDATE submissions SET status = 'approved' WHERE id = $1")
        .run(submissionId);
    });

    emitEvent({ type: 'submission', submissionId, status: 'approved' });
    return getSubmissionDetail(submissionId);
  });

  app.post('/api/submissions/:id/unapprove', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    await assertSubmission(submissionId);
    const timestamp = nowIso();
    await db.transaction(async (tx) => {
      await tx
        .prepare(
          "UPDATE grades SET status = 'draft', approved_at = NULL, updated_at = $1 WHERE submission_id = $2",
        )
        .run(timestamp, submissionId);
      await tx
        .prepare("UPDATE submissions SET status = 'reviewed' WHERE id = $1")
        .run(submissionId);
    });
    emitEvent({ type: 'submission', submissionId, status: 'reviewed' });
    return getSubmissionDetail(submissionId);
  });

  app.get('/api/submissions/:id/brief', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    const row = await getSubmissionRow(submissionId);
    if (!row) throw notFound('Entrega no encontrada');
    return row;
  });

  // Transcripción de control: permite comprobar qué ve realmente el modelo.
  app.post('/api/submissions/:id/reading-check', async (request) => {
    const submissionId = Number((request.params as { id: string }).id);
    const submission = await assertSubmission(submissionId);
    const activity = await db
      .prepare('SELECT subject FROM activities WHERE id = $1')
      .get<{ subject: string }>(submission.activity_id);
    if (!activity) throw notFound('Actividad no encontrada');

    const pages = await db
      .prepare(
        "SELECT stored_path, mime, page_no FROM files WHERE owner_type = 'submission' AND owner_id = $1 AND kind = 'page' ORDER BY page_no ASC, id ASC",
      )
      .all<{ stored_path: string; mime: string; page_no: number | null }>(submissionId);
    if (pages.length === 0) throw badRequest('La entrega no tiene páginas que comprobar');

    const settings = await getSettings();
    const limit = Math.max(1, settings.maxPagesPerEvaluation);
    const selected = pages.slice(0, limit);
    const images: ImagePart[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      const page = selected[index];
      if (!page.mime.startsWith('image/')) continue;
      try {
        images.push({
          label: `Entrega · página ${page.page_no ?? index + 1}`,
          mime: page.mime,
          base64: await readFileBase64(page.stored_path),
        });
      } catch {
        /* página no disponible: se avisa por el recuento */
      }
    }
    if (images.length === 0) throw badRequest('No se han podido leer las páginas de la entrega');

    const result = await runWithModelFailover(
      settings.primary,
      settings.independent,
      (provider, model) =>
        runProviderRead(provider, model, {
          subject: activity.subject as 'biologia' | 'bioquimica',
          images,
        }),
    );

    return {
      text: result.text.trim(),
      pages: images.length,
      totalPages: pages.length,
      provider: settings.primary.provider,
      model: settings.primary.model,
    };
  });

  app.get('/api/config', async () => ({ settings: await getSettings() }));
}
