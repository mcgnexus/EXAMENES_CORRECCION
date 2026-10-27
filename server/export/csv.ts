import type { RubricItem } from '../../shared/types';
import { db } from '../db';
import { listRubric } from '../mappers';

export function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[";\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildCsv(rows: (string | number | null | undefined)[][]): string {
  return `\uFEFF${rows.map((row) => row.map(csvEscape).join(';')).join('\r\n')}\r\n`;
}

const STATUS_LABEL: Record<string, string> = {
  uploaded: 'subida',
  queued: 'en cola',
  running: 'corrigiendo',
  reviewed: 'revisada',
  approved: 'aprobada',
  exported: 'exportada',
  error: 'error',
};

interface GradeRowDb {
  total: number;
  overall_comment: string;
  status: string;
}

interface GradeItemDb {
  rubric_item_id: number;
  points: number;
  comment: string;
}

export async function buildActivityCsv(
  activityId: number,
): Promise<{ filename: string; content: string }> {
  const activity = await db
    .prepare('SELECT * FROM activities WHERE id = $1')
    .get<{ id: number; title: string }>(activityId);
  if (!activity) throw new Error('Actividad no encontrada');

  const rubric = await listRubric(activityId);
  const maxTotal = rubric.reduce((sum, item) => sum + item.maxPoints, 0);

  const submissions = await db
    .prepare(
      `SELECT s.id, st.name AS student_name, s.status
       FROM submissions s JOIN students st ON st.id = s.student_id
       WHERE s.activity_id = $1 ORDER BY lower(st.name) ASC`,
    )
    .all<{ id: number; student_name: string; status: string }>(activityId);

  const itemTitle = (item: RubricItem) => `${item.title} (0-${item.maxPoints})`;

  const header: (string | number)[] = [
    'Alumno',
    'Estado',
    'Total',
    `Nota (%)`,
    ...rubric.map(itemTitle),
    'Comentario general',
    ...rubric.map((item) => `Comentario: ${item.title}`),
  ];

  const rows: (string | number | null | undefined)[][] = [header];

  for (const submission of submissions) {
    const grade = await db
      .prepare('SELECT total, overall_comment, status FROM grades WHERE submission_id = $1')
      .get<GradeRowDb>(submission.id);
    const gradeItems = await db
      .prepare('SELECT rubric_item_id, points, comment FROM grade_items WHERE submission_id = $1')
      .all<GradeItemDb>(submission.id);
    const byItem = new Map(gradeItems.map((item) => [item.rubric_item_id, item]));

    const total = grade ? grade.total : null;
    const percent =
      total !== null && maxTotal > 0 ? Math.round((total / maxTotal) * 1000) / 10 : null;

    rows.push([
      submission.student_name,
      STATUS_LABEL[grade?.status ?? submission.status] ?? (grade?.status ?? submission.status),
      total ?? '',
      percent ?? '',
      ...rubric.map((item) => byItem.get(item.id)?.points ?? ''),
      grade?.overall_comment ?? '',
      ...rubric.map((item) => byItem.get(item.id)?.comment ?? ''),
    ]);
  }

  const safeTitle = activity.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '_');
  return {
    filename: `calificaciones_${safeTitle || activityId}.csv`,
    content: buildCsv(rows),
  };
}
