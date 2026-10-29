import type { AppSettings, RubricItem, Subject } from '../../shared/types';
import { z } from 'zod';
import { db, getSettings, nowIso } from '../db';
import { emitEvent } from '../events';
import { extractJsonObject } from '../llm/prompts';
import { buildOmrCommentSystemPrompt, buildOmrCommentUserPrompt } from '../llm/prompts';
import { runProviderEvaluation, runProviderRead, runWithModelFailover } from '../llm/providers';
import type { GradingInput, ImagePart } from '../llm/types';
import { listRubric } from '../mappers';
import { proposeGrade, round1, type EvaluationLike, type ScoreLike } from './aggregate';
import { confirmedOmrAnswers } from '../routes/omr';
import { scoreAnswers, type OmrConfig } from '../../shared/omr';

interface SubmissionDbRow {
  id: number;
  activity_id: number;
  student_id: number;
  status: string;
  reading: string | null;
}

interface ActivityDbRow {
  id: number;
  title: string;
  subject: string;
  description: string;
}

interface FileDbRow {
  id: number;
  owner_type: string;
  owner_id: number;
  mime: string;
  stored_path: string;
  kind: string;
  page_no: number | null;
}

interface DocumentDbRow {
  id: number;
  kind: string;
  name: string;
  text: string | null;
}

const DOC_LABEL: Record<string, string> = {
  enunciado: 'ENUNCIADO',
  solucion: 'SOLUCIÓN',
  rubrica: 'RÚBRICA',
  documentacion: 'DOCUMENTACIÓN',
};

async function pageFiles(
  ownerType: 'submission' | 'document',
  ownerId: number,
): Promise<FileDbRow[]> {
  return db
    .prepare(
      `SELECT * FROM files WHERE owner_type = $1 AND owner_id = $2 AND kind = 'page'
       ORDER BY page_no ASC, id ASC`,
    )
    .all<FileDbRow>(ownerType, ownerId);
}

async function toImageParts(
  files: FileDbRow[],
  labelPrefix: string,
  readBase64: (storedPath: string) => Promise<string>,
): Promise<ImagePart[]> {
  const parts: ImagePart[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    parts.push({
      label: `${labelPrefix} — página ${file.page_no ?? index + 1}`,
      mime: file.mime.startsWith('image/') ? file.mime : 'image/png',
      base64: await readBase64(file.stored_path),
    });
  }
  return parts;
}

export async function buildGradingInput(
  submissionId: number,
  settings: AppSettings,
): Promise<GradingInput> {
  const submission = await db
    .prepare('SELECT * FROM submissions WHERE id = $1')
    .get<SubmissionDbRow>(submissionId);
  if (!submission) throw new Error(`Entrega ${submissionId} no encontrada`);

  const activity = await db
    .prepare('SELECT * FROM activities WHERE id = $1')
    .get<ActivityDbRow>(submission.activity_id);
  if (!activity) throw new Error('Actividad no encontrada');
  const omr=await confirmedOmrAnswers(submissionId,activity.id);

  const rubric = await listRubric(activity.id);
  if (rubric.length === 0) throw new Error('La actividad no tiene apartados en la rúbrica');

  const documents = await db
    .prepare('SELECT * FROM activity_documents WHERE activity_id = $1 ORDER BY id ASC')
    .all<DocumentDbRow>(activity.id);

  const studentPages = await pageFiles('submission', submissionId);
  if (!omr && studentPages.length === 0) {
    throw new Error('La entrega no tiene páginas legibles (sube una foto o un PDF)');
  }

  const documentText = documents
    .filter((doc) => doc.kind === 'enunciado' || doc.kind === 'documentacion')
    .map((doc) => doc.text ?? '')
    .filter(Boolean)
    .join('\n\n');
  const solutionText = documents
    .filter((doc) => doc.kind === 'solucion')
    .map((doc) => doc.text ?? '')
    .filter(Boolean)
    .join('\n\n');

  const { readFileBase64 } = await import('../storage');
  const maxPagesPerDocument = Math.max(1, settings.maxPagesPerEvaluation);

  let images: ImagePart[] = [];
  if (settings.includeImages) {
    // Cada fuente tiene su propio presupuesto: la entrega larga no debe
    // consumir el espacio del enunciado y ocultar preguntas al modelo.
    images = omr ? [] : await toImageParts(
      studentPages.slice(0, maxPagesPerDocument),
      `RESPUESTA DEL ALUMNO (primeras ${Math.min(studentPages.length, maxPagesPerDocument)} de ${studentPages.length} páginas)`,
      readFileBase64,
    );
    const solutionDocs = documents.filter((doc) => doc.kind === 'solucion');
    const solutionPages: FileDbRow[] = [];
    for (const doc of solutionDocs) solutionPages.push(...(await pageFiles('document', doc.id)));
    if (solutionPages.length > 0) {
      images = images.concat(
        await toImageParts(
          solutionPages.slice(0, maxPagesPerDocument),
          `SOLUCIÓN DE REFERENCIA (primeras ${Math.min(solutionPages.length, maxPagesPerDocument)} de ${solutionPages.length} páginas)`,
          readFileBase64,
        ),
      );
    }
    const enunciadoDocs = documents.filter((doc) => doc.kind === 'enunciado');
    const enunciadoPages: FileDbRow[] = [];
    for (const doc of enunciadoDocs) enunciadoPages.push(...(await pageFiles('document', doc.id)));
    if (enunciadoPages.length > 0) {
      images = images.concat(
        await toImageParts(
          enunciadoPages.slice(0, maxPagesPerDocument),
          `ENUNCIADO (primeras ${Math.min(enunciadoPages.length, maxPagesPerDocument)} de ${enunciadoPages.length} páginas)`,
          readFileBase64,
        ),
      );
    }
  }

  return {
    subject: activity.subject as Subject,
    activityTitle: activity.title,
    activityDescription: activity.description,
    rubric: rubric.map((item: RubricItem) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      maxPoints: item.maxPoints,
    })),
    documentText,
    solutionText: omr ? `Clave de referencia confirmada (extraída de las soluciones de la actividad):\n${JSON.stringify(omr.config.key)}\nReglas de puntuación: ${JSON.stringify(omr.config.scoring)}\n\nSoluciones generadas/de referencia:\n${solutionText}` : solutionText,
    images,
    seed: submission.id,
    ...(omr?{detectedAnswers:omr.answers}:{}),
  };
}

interface PersistEvaluationInput {
  submissionId: number;
  role: 'primary' | 'independent';
  provider: string;
  model: string;
  input: GradingInput;
}

async function runAndPersistEvaluation(payload: PersistEvaluationInput): Promise<number> {
  const { submissionId, role, provider, model, input } = payload;
  const created = await db
    .prepare(
      `INSERT INTO evaluations (submission_id, role, provider, model, status, started_at, created_at)
       VALUES ($1, $2, $3, $4, 'running', $5, $6) RETURNING id`,
    )
    .get<{ id: number }>(submissionId, role, provider, model, nowIso(), nowIso());
  const evaluationId = created?.id ?? 0;

  try {
    const output = await runProviderEvaluation(provider, model, input);
    const total = round1(output.items.reduce((sum, item) => sum + item.points, 0));
    await db
      .prepare(
        `UPDATE evaluations SET status = 'done', reading = $1, overall_comment = $2,
         total_points = $3, finished_at = $4 WHERE id = $5`,
      )
      .run(output.reading, output.overallComment, total, nowIso(), evaluationId);

    const insertScore = db.prepare(
      `INSERT INTO evaluation_scores (evaluation_id, rubric_item_id, points, comment, confidence)
       VALUES ($1, $2, $3, $4, $5)`,
    );
    for (const item of output.items) {
      await insertScore.run(evaluationId, item.itemId, item.points, item.comment, item.confidence);
    }
    return evaluationId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .prepare("UPDATE evaluations SET status = 'error', error = $1, finished_at = $2 WHERE id = $3")
      .run(message.slice(0, 2000), nowIso(), evaluationId);
    throw error;
  }
}

async function loadEvaluations(submissionId: number): Promise<EvaluationLike[]> {
  const evaluations = await db
    .prepare('SELECT * FROM evaluations WHERE submission_id = $1 ORDER BY id ASC')
    .all<{
      id: number;
      role: 'primary' | 'independent';
      status: string;
      overall_comment: string | null;
    }>(submissionId);

  const result: EvaluationLike[] = [];
  for (const evaluation of evaluations) {
    const scores = await db
      .prepare(
        'SELECT rubric_item_id, points, comment FROM evaluation_scores WHERE evaluation_id = $1',
      )
      .all<{ rubric_item_id: number; points: number; comment: string }>(evaluation.id);
    result.push({
      role: evaluation.role,
      status: evaluation.status,
      overallComment: evaluation.overall_comment,
      items: scores.map(
        (score): ScoreLike => ({
          rubricItemId: score.rubric_item_id,
          points: score.points,
          comment: score.comment,
        }),
      ),
    });
  }
  return result;
}

async function writeProposedGrade(
  submissionId: number,
  activityId: number,
  threshold: number,
): Promise<void> {
  const rubric = await listRubric(activityId);
  const proposed = proposeGrade(rubric, await loadEvaluations(submissionId), threshold);

  const existing = await db
    .prepare('SELECT * FROM grades WHERE submission_id = $1')
    .get<{ id: number; status: string }>(submissionId);
  if (existing && (existing.status === 'approved' || existing.status === 'exported')) {
    return;
  }

  await db
    .prepare(
      `INSERT INTO grades (submission_id, total, overall_comment, status, updated_at)
       VALUES ($1, $2, $3, 'draft', $4)
       ON CONFLICT(submission_id) DO UPDATE SET total = EXCLUDED.total,
         overall_comment = EXCLUDED.overall_comment, updated_at = EXCLUDED.updated_at`,
    )
    .run(submissionId, proposed.total, proposed.overallComment, nowIso());

  await db.prepare('DELETE FROM grade_items WHERE submission_id = $1').run(submissionId);
  const insert = db.prepare(
    `INSERT INTO grade_items (submission_id, rubric_item_id, points, comment, source)
     VALUES ($1, $2, $3, $4, 'proposal')`,
  );
  for (const item of proposed.items) {
    await insert.run(submissionId, item.rubricItemId, item.points, item.comment);
  }
}

interface OmrData { answers: { question: number; answer: string | null }[]; config: OmrConfig; overrides?: Record<string,'correct'|'wrong'> }

/**
 * Corrección determinista para entregas de test: la nota SIEMPRE sale de las
 * reglas de puntuación guardadas (scoreAnswers) sobre las respuestas
 * confirmadas del detector; el LLM solo redacta lectura y comentarios y no
 * puede cambiar ningún punto.
 */
async function correctOmrSubmission(
  submissionId: number,
  activityId: number,
  subject: string,
  omr: OmrData,
): Promise<void> {
  const score = scoreAnswers(omr.answers, omr.config, omr.overrides ?? {});
  const settings = await getSettings();
  const created = await db
    .prepare(
      `INSERT INTO evaluations (submission_id, role, provider, model, status, started_at, created_at)
       VALUES ($1, 'primary', $2, $3, 'running', $4, $5) RETURNING id`,
    )
    .get<{ id: number }>(submissionId, settings.primary.provider, settings.primary.model, nowIso(), nowIso());
  const evaluationId = created?.id ?? 0;
  let commentary: { reading: string; overallComment: string };
  try {
    const result = await runWithModelFailover(
      settings.primary,
      settings.independent,
      (provider, model) =>
        runProviderRead(provider, model, {
          subject: subject as 'biologia' | 'bioquimica',
          images: [],
          instructions: buildOmrCommentSystemPrompt(subject),
          context: buildOmrCommentUserPrompt(omr.config.key, omr.answers, score),
        }),
    );
    const parsed = z
      .object({
        reading: z.string().default(''),
        overallComment: z.string().default(''),
        questionComments: z
          .array(z.object({ question: z.number(), comment: z.string() }))
          .default([]),
      })
      .parse(extractJsonObject(result.text));
    commentary = { reading: parsed.reading, overallComment: parsed.overallComment };
    await db
      .prepare(
        `UPDATE evaluations SET status = 'done', reading = $1, overall_comment = $2,
         total_points = $3, finished_at = $4 WHERE id = $5`,
      )
      .run(parsed.reading, parsed.overallComment, score.total, nowIso(), evaluationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .prepare("UPDATE evaluations SET status = 'error', error = $1, finished_at = $2 WHERE id = $3")
      .run(message.slice(0, 2000), nowIso(), evaluationId);
    throw error;
  }

  // Nota determinista repartida proporcionalmente entre los apartados de la
  // rúbrica según sus máximos; el último apartado absorbe el redondeo.
  // Una nota ya aprobada o exportada no se toca.
  const approved = await db
    .prepare('SELECT status FROM grades WHERE submission_id = $1')
    .get<{ status: string }>(submissionId);
  if (approved && (approved.status === 'approved' || approved.status === 'exported')) {
    return;
  }
  const rubric = await listRubric(activityId);
  if (rubric.length === 0) throw new Error('La actividad no tiene apartados en la rúbrica');
  const maxSum = rubric.reduce((sum, item) => sum + item.maxPoints, 0) || 1;
  let assigned = 0;
  const distributed = rubric.map((item, index) => {
    if (index === rubric.length - 1) {
      const points = round1(Math.max(0, Math.min(item.maxPoints, score.total - assigned)));
      assigned = round1(assigned + points);
      return { item, points };
    }
    const points = round1(Math.min(item.maxPoints, (score.total * item.maxPoints) / maxSum));
    assigned = round1(assigned + points);
    return { item, points };
  });

  await db
    .prepare(
      `INSERT INTO grades (submission_id, total, overall_comment, status, updated_at)
       VALUES ($1, $2, $3, 'draft', $4)
       ON CONFLICT(submission_id) DO UPDATE SET total = EXCLUDED.total,
         overall_comment = EXCLUDED.overall_comment, updated_at = EXCLUDED.updated_at`,
    )
    .run(submissionId, score.total, commentary.overallComment, nowIso());
  await db.prepare('DELETE FROM grade_items WHERE submission_id = $1').run(submissionId);
  const insert = db.prepare(
    `INSERT INTO grade_items (submission_id, rubric_item_id, points, comment, source)
     VALUES ($1, $2, $3, $4, 'omr')`,
  );
  for (const { item, points } of distributed) {
    await insert.run(
      submissionId,
      item.id,
      points,
      `Corrección determinista del test (${score.total} / ${score.scale}). ${commentary.overallComment}`.trim(),
    );
  }
}

export async function correctSubmission(submissionId: number): Promise<void> {
  const settings = await getSettings();
  const submission = await db
    .prepare('SELECT * FROM submissions WHERE id = $1')
    .get<SubmissionDbRow>(submissionId);
  if (!submission) throw new Error(`Entrega ${submissionId} no encontrada`);

  await db
    .prepare("UPDATE submissions SET status = 'running', error = NULL WHERE id = $1")
    .run(submissionId);
  emitEvent({ type: 'submission', submissionId, status: 'running' });

  try {
    // Entregas de test confirmadas: corrección determinista (la nota sale de
    // las reglas de puntuación; el LLM solo comenta y nunca ve la foto).
    const omr = await confirmedOmrAnswers(submissionId, submission.activity_id);
    if (omr) {
      const activity = await db
        .prepare('SELECT id, subject FROM activities WHERE id = $1')
        .get<{ id: number; subject: string }>(submission.activity_id);
      if (!activity) throw new Error('Actividad no encontrada');
      await correctOmrSubmission(submissionId, activity.id, activity.subject, omr);
      await db
        .prepare('UPDATE submissions SET status = $1, error = NULL WHERE id = $2')
        .run('reviewed', submissionId);
      emitEvent({ type: 'submission', submissionId, status: 'reviewed' });
      return;
    }

    const input = await buildGradingInput(submissionId, settings);

    // Las 3 evaluaciones son independientes entre sí: se lanzan en paralelo.
    // La primaria tiene failover: si el modelo configurado falla de forma
    // transitoria (503/429/…), prueba con los alternativos en orden. Los
    // fallos de las independientes quedan registrados por
    // runAndPersistEvaluation y la comparación sigue con las que terminen.
    const independentPromises = settings.independent.map((independent) =>
      runAndPersistEvaluation({
        submissionId,
        role: 'independent',
        provider: independent.provider,
        model: independent.model,
        input,
      }),
    );

    const primaryPromise = runWithModelFailover(
      settings.primary,
      settings.independent,
      (provider, model) =>
        runAndPersistEvaluation({
          submissionId,
          role: 'primary',
          provider,
          model,
          input,
        }),
    );

    const results = await Promise.allSettled([primaryPromise, ...independentPromises]);

    const primaryResult = results[0];
    if (primaryResult.status === 'rejected') {
      const reason = primaryResult.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      throw new Error(`La propuesta del modelo primario falló: ${message}`);
    }

    const activity = await db
      .prepare('SELECT id FROM activities WHERE id = $1')
      .get<{ id: number }>(submission.activity_id);
    if (!activity) throw new Error('Actividad no encontrada');
    await writeProposedGrade(submissionId, activity.id, settings.divergenceThreshold);

    const current = await db
      .prepare('SELECT status FROM grades WHERE submission_id = $1')
      .get<{ status: string }>(submissionId);
    const nextStatus =
      current && (current.status === 'approved' || current.status === 'exported')
        ? current.status
        : 'reviewed';

    await db
      .prepare('UPDATE submissions SET status = $1, error = NULL WHERE id = $2')
      .run(nextStatus, submissionId);
    emitEvent({ type: 'submission', submissionId, status: nextStatus });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .prepare("UPDATE submissions SET status = 'error', error = $1 WHERE id = $2")
      .run(message.slice(0, 2000), submissionId);
    emitEvent({ type: 'submission', submissionId, status: 'error' });
    throw error;
  }
}
