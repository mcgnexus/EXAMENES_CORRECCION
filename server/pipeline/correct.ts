import type { AppSettings, RubricItem, Subject } from '../../shared/types';
import { db, getSettings, nowIso } from '../db';
import { emitEvent } from '../events';
import { runProviderEvaluation } from '../llm/providers';
import type { GradingInput, ImagePart } from '../llm/types';
import { listRubric } from '../mappers';
import { proposeGrade, round1, type EvaluationLike, type ScoreLike } from './aggregate';

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

function pageFiles(ownerType: 'submission' | 'document', ownerId: number): FileDbRow[] {
  return db
    .prepare(
      `SELECT * FROM files WHERE owner_type = ? AND owner_id = ? AND kind = 'page'
       ORDER BY page_no ASC, id ASC`,
    )
    .all(ownerType, ownerId) as FileDbRow[];
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

async function buildGradingInput(
  submissionId: number,
  settings: AppSettings,
): Promise<GradingInput> {
  const submission = db
    .prepare('SELECT * FROM submissions WHERE id = ?')
    .get(submissionId) as SubmissionDbRow | undefined;
  if (!submission) throw new Error(`Entrega ${submissionId} no encontrada`);

  const activity = db
    .prepare('SELECT * FROM activities WHERE id = ?')
    .get(submission.activity_id) as ActivityDbRow | undefined;
  if (!activity) throw new Error('Actividad no encontrada');

  const rubric = listRubric(activity.id);
  if (rubric.length === 0) throw new Error('La actividad no tiene apartados en la rúbrica');

  const documents = db
    .prepare('SELECT * FROM activity_documents WHERE activity_id = ? ORDER BY id ASC')
    .all(activity.id) as DocumentDbRow[];

  const studentPages = pageFiles('submission', submissionId);
  if (studentPages.length === 0) {
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
  const maxPages = Math.max(1, settings.maxPagesPerEvaluation);

  let images: ImagePart[] = [];
  if (settings.includeImages) {
    images = await toImageParts(studentPages.slice(0, maxPages), 'RESPUESTA DEL ALUMNO', readFileBase64);
    const remaining = Math.max(0, maxPages - images.length);
    const solutionPages = documents
      .filter((doc) => doc.kind === 'solucion')
      .flatMap((doc) => pageFiles('document', doc.id));
    if (remaining > 0 && solutionPages.length > 0) {
      images = images.concat(
        await toImageParts(solutionPages.slice(0, remaining), 'SOLUCIÓN DE REFERENCIA', readFileBase64),
      );
    }
    const remaining2 = Math.max(0, maxPages - images.length);
    const enunciadoPages = documents
      .filter((doc) => doc.kind === 'enunciado')
      .flatMap((doc) => pageFiles('document', doc.id));
    if (remaining2 > 0 && enunciadoPages.length > 0) {
      images = images.concat(
        await toImageParts(enunciadoPages.slice(0, remaining2), 'ENUNCIADO', readFileBase64),
      );
    }
  }

  return {
    subject: activity.subject as Subject,
    activityTitle: activity.title,
    activityDescription: activity.description,
    rubric: rubric.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      maxPoints: item.maxPoints,
    })),
    documentText,
    solutionText,
    images,
    seed: submission.id,
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
  const created = db
    .prepare(
      `INSERT INTO evaluations (submission_id, role, provider, model, status, started_at, created_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    )
    .run(submissionId, role, provider, model, nowIso(), nowIso());
  const evaluationId = Number(created.lastInsertRowid);

  try {
    const output = await runProviderEvaluation(provider, model, input);
    const total = round1(output.items.reduce((sum, item) => sum + item.points, 0));
    db.prepare(
      `UPDATE evaluations SET status = 'done', reading = ?, overall_comment = ?,
         total_points = ?, finished_at = ? WHERE id = ?`,
    ).run(output.reading, output.overallComment, total, nowIso(), evaluationId);

    const insertScore = db.prepare(
      `INSERT INTO evaluation_scores (evaluation_id, rubric_item_id, points, comment, confidence)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const item of output.items) {
      insertScore.run(evaluationId, item.itemId, item.points, item.comment, item.confidence);
    }
    return evaluationId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(
      "UPDATE evaluations SET status = 'error', error = ?, finished_at = ? WHERE id = ?",
    ).run(message.slice(0, 2000), nowIso(), evaluationId);
    throw error;
  }
}

function loadEvaluations(submissionId: number): EvaluationLike[] {
  const evaluations = db
    .prepare('SELECT * FROM evaluations WHERE submission_id = ? ORDER BY id ASC')
    .all(submissionId) as {
    id: number;
    role: 'primary' | 'independent';
    status: string;
    overall_comment: string | null;
  }[];

  return evaluations.map((evaluation) => ({
    role: evaluation.role,
    status: evaluation.status,
    overallComment: evaluation.overall_comment,
    items: db
      .prepare(
        'SELECT rubric_item_id, points, comment FROM evaluation_scores WHERE evaluation_id = ?',
      )
      .all(evaluation.id)
      .map((row) => {
        const score = row as { rubric_item_id: number; points: number; comment: string };
        return {
          rubricItemId: score.rubric_item_id,
          points: score.points,
          comment: score.comment,
        } satisfies ScoreLike;
      }),
  }));
}

function writeProposedGrade(submissionId: number, activityId: number, threshold: number): void {
  const rubric = listRubric(activityId);
  const proposed = proposeGrade(rubric, loadEvaluations(submissionId), threshold);

  const existing = db
    .prepare('SELECT * FROM grades WHERE submission_id = ?')
    .get(submissionId) as { id: number; status: string } | undefined;
  if (existing && (existing.status === 'approved' || existing.status === 'exported')) {
    return;
  }

  db.prepare(
    `INSERT INTO grades (submission_id, total, overall_comment, status, updated_at)
     VALUES (?, ?, ?, 'draft', ?)
     ON CONFLICT(submission_id) DO UPDATE SET total = excluded.total,
       overall_comment = excluded.overall_comment, updated_at = excluded.updated_at`,
  ).run(submissionId, proposed.total, proposed.overallComment, nowIso());

  db.prepare('DELETE FROM grade_items WHERE submission_id = ?').run(submissionId);
  const insert = db.prepare(
    `INSERT INTO grade_items (submission_id, rubric_item_id, points, comment, source)
     VALUES (?, ?, ?, ?, 'proposal')`,
  );
  for (const item of proposed.items) {
    insert.run(submissionId, item.rubricItemId, item.points, item.comment);
  }
}

export async function correctSubmission(submissionId: number): Promise<void> {
  const settings = getSettings();
  const submission = db
    .prepare('SELECT * FROM submissions WHERE id = ?')
    .get(submissionId) as SubmissionDbRow | undefined;
  if (!submission) throw new Error(`Entrega ${submissionId} no encontrada`);

  db.prepare("UPDATE submissions SET status = 'running', error = NULL WHERE id = ?").run(
    submissionId,
  );
  emitEvent({ type: 'submission', submissionId, status: 'running' });

  try {
    const input = await buildGradingInput(submissionId, settings);

    try {
      await runAndPersistEvaluation({
        submissionId,
        role: 'primary',
        provider: settings.primary.provider,
        model: settings.primary.model,
        input,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`La propuesta del modelo primario falló: ${message}`);
    }

    for (const independent of settings.independent) {
      try {
        await runAndPersistEvaluation({
          submissionId,
          role: 'independent',
          provider: independent.provider,
          model: independent.model,
          input,
        });
      } catch {
        // El fallo queda registrado en la evaluación; la comparación sigue con el resto.
      }
    }

    const activity = db
      .prepare('SELECT * FROM activities WHERE id = ?')
      .get(submission.activity_id) as { id: number };
    writeProposedGrade(submissionId, activity.id, settings.divergenceThreshold);

    const current = db
      .prepare('SELECT status FROM grades WHERE submission_id = ?')
      .get(submissionId) as { status: string } | undefined;
    const nextStatus =
      current && (current.status === 'approved' || current.status === 'exported')
        ? current.status
        : 'reviewed';

    db.prepare("UPDATE submissions SET status = ?, error = NULL WHERE id = ?").run(
      nextStatus,
      submissionId,
    );
    emitEvent({ type: 'submission', submissionId, status: nextStatus });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE submissions SET status = 'error', error = ? WHERE id = ?").run(
      message.slice(0, 2000),
      submissionId,
    );
    emitEvent({ type: 'submission', submissionId, status: 'error' });
    throw error;
  }
}
