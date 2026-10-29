import type {
  ActivityBundle,
  ActivityRow,
  ClassRow,
  DocumentRow,
  EvaluationRow,
  FileRow,
  GradeRow,
  JobRow,
  RubricItem,
  StudentRow,
  SubmissionDetail,
  SubmissionRow,
} from '../shared/types';
import { db, getSettings } from './db';
import { fileUrl } from './storage';

interface ClassDb {
  id: number;
  name: string;
  subject: string;
  created_at: string;
  student_count: number;
}

export async function listClasses(): Promise<ClassRow[]> {
  const rows = await db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS student_count
       FROM classes c ORDER BY lower(c.name) ASC`,
    )
    .all<ClassDb>();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    subject: row.subject as ClassRow['subject'],
    studentCount: row.student_count,
    createdAt: row.created_at,
  }));
}

export async function listStudents(classId: number): Promise<StudentRow[]> {
  const rows = await db
    .prepare('SELECT * FROM students WHERE class_id = $1 ORDER BY sort_order ASC, id ASC')
    .all<{
      id: number;
      class_id: number;
      name: string;
      sort_order: number;
    }>(classId);
  return rows.map((row) => ({
    id: row.id,
    classId: row.class_id,
    name: row.name,
    sortOrder: row.sort_order,
  }));
}

interface ActivityDb {
  id: number;
  title: string;
  subject: string;
  class_id: number | null;
  class_name: string | null;
  description: string;
  status: string;
  created_at: string;
  max_points: number;
  rubric_count: number;
  submission_count: number;
}

function mapActivity(row: ActivityDb): ActivityRow {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject as ActivityRow['subject'],
    classId: row.class_id,
    className: row.class_name,
    description: row.description,
    status: row.status as ActivityRow['status'],
    createdAt: row.created_at,
    maxPoints: row.max_points ?? 0,
    rubricCount: row.rubric_count ?? 0,
    submissionCount: row.submission_count ?? 0,
  };
}

const ACTIVITY_SELECT = `
  SELECT a.*, c.name AS class_name,
    (SELECT COALESCE(SUM(r.max_points), 0) FROM rubric_items r WHERE r.activity_id = a.id) AS max_points,
    (SELECT COUNT(*) FROM rubric_items r WHERE r.activity_id = a.id) AS rubric_count,
    (SELECT COUNT(*) FROM submissions s WHERE s.activity_id = a.id) AS submission_count
  FROM activities a LEFT JOIN classes c ON c.id = a.class_id
`;

export async function listActivities(): Promise<ActivityRow[]> {
  const rows = await db.prepare(`${ACTIVITY_SELECT} ORDER BY a.id DESC`).all<ActivityDb>();
  return rows.map(mapActivity);
}

export async function getActivityRow(activityId: number): Promise<ActivityRow | null> {
  const row = await db
    .prepare(`${ACTIVITY_SELECT} WHERE a.id = $1`)
    .get<ActivityDb>(activityId);
  return row ? mapActivity(row) : null;
}

export async function listRubric(activityId: number): Promise<RubricItem[]> {
  const rows = await db
    .prepare('SELECT * FROM rubric_items WHERE activity_id = $1 ORDER BY ord ASC, id ASC')
    .all<{
      id: number;
      activity_id: number;
      ord: number;
      title: string;
      description: string;
      max_points: number;
    }>(activityId);
  return rows.map((item) => ({
    id: item.id,
    activityId: item.activity_id,
    ord: item.ord,
    title: item.title,
    description: item.description,
    maxPoints: item.max_points,
  }));
}

export async function listDocuments(activityId: number): Promise<DocumentRow[]> {
  const rows = await db
    .prepare(
      `SELECT d.*,
         (SELECT COUNT(*) FROM files f WHERE f.owner_type = 'document' AND f.owner_id = d.id AND f.kind = 'page') AS page_count,
         (SELECT original_name FROM files f WHERE f.owner_type = 'document' AND f.owner_id = d.id AND f.kind = 'original' LIMIT 1) AS original_name,
         (SELECT mime FROM files f WHERE f.owner_type = 'document' AND f.owner_id = d.id AND f.kind = 'original' LIMIT 1) AS mime,
         (SELECT id FROM files f WHERE f.owner_type = 'document' AND f.owner_id = d.id AND f.kind = 'original' LIMIT 1) AS original_file_id
       FROM activity_documents d WHERE d.activity_id = $1 ORDER BY d.id ASC`,
    )
    .all<{
      id: number;
      activity_id: number;
      kind: string;
      name: string;
      text: string | null;
      page_count: number;
      original_name: string | null;
      mime: string | null;
      original_file_id: number | null;
      created_at: string;
    }>(activityId);
  return rows.map((row) => ({
    id: row.id,
    activityId: row.activity_id,
    kind: row.kind as DocumentRow['kind'],
    name: row.name,
    text: row.text,
    originalName: row.original_name ?? row.name,
    mime: row.mime ?? 'application/octet-stream',
    originalFileId: row.original_file_id,
    pageCount: row.page_count,
    createdAt: row.created_at,
  }));
}

const SUBMISSION_SELECT = `SELECT s.*, st.name AS student_name,
   (SELECT COUNT(*) FROM files f WHERE f.owner_type = 'submission' AND f.owner_id = s.id AND f.kind = 'page') AS file_count
   FROM submissions s JOIN students st ON st.id = s.student_id`;

interface SubmissionDb {
  id: number;
  activity_id: number;
  student_id: number;
  student_name: string;
  dni: string | null;
  course: string | null;
  class_name: string | null;
  status: string;
  error: string | null;
  created_at: string;
  file_count: number;
}

function mapSubmission(row: SubmissionDb): SubmissionRow {
  return {
    id: row.id,
    activityId: row.activity_id,
    studentId: row.student_id,
    studentName: row.student_name,
    dni: row.dni,
    course: row.course,
    className: row.class_name,
    status: row.status as SubmissionRow['status'],
    error: row.error,
    createdAt: row.created_at,
    fileCount: row.file_count,
  };
}

export async function listSubmissions(activityId: number): Promise<SubmissionRow[]> {
  const rows = await db
    .prepare(`${SUBMISSION_SELECT} WHERE s.activity_id = $1 ORDER BY lower(st.name) ASC`)
    .all<SubmissionDb>(activityId);
  return rows.map(mapSubmission);
}

export async function getSubmissionRow(submissionId: number): Promise<SubmissionRow | null> {
  const row = await db
    .prepare(`${SUBMISSION_SELECT} WHERE s.id = $1`)
    .get<SubmissionDb>(submissionId);
  return row ? mapSubmission(row) : null;
}

export async function listFiles(
  ownerType: 'document' | 'submission',
  ownerId: number,
): Promise<FileRow[]> {
  const rows = await db
    .prepare(
      'SELECT * FROM files WHERE owner_type = $1 AND owner_id = $2 ORDER BY kind ASC, page_no ASC, id ASC',
    )
    .all<{
      id: number;
      owner_type: 'document' | 'submission';
      owner_id: number;
      original_name: string;
      mime: string;
      kind: 'original' | 'page';
      page_no: number | null;
    }>(ownerType, ownerId);
  return rows.map((row) => ({
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    originalName: row.original_name,
    mime: row.mime,
    kind: row.kind,
    pageNo: row.page_no,
    url: fileUrl(row.id),
  }));
}

export async function listEvaluations(submissionId: number): Promise<EvaluationRow[]> {
  const evaluations = await db
    .prepare('SELECT * FROM evaluations WHERE submission_id = $1 ORDER BY id ASC')
    .all<{
      id: number;
      submission_id: number;
      role: 'primary' | 'independent';
      provider: string;
      model: string;
      status: string;
      error: string | null;
      reading: string | null;
      overall_comment: string | null;
      total_points: number | null;
      started_at: string | null;
      finished_at: string | null;
    }>(submissionId);

  const rows: EvaluationRow[] = [];
  for (const evaluation of evaluations) {
    const scores = await db
      .prepare(
        'SELECT rubric_item_id, points, comment, confidence FROM evaluation_scores WHERE evaluation_id = $1',
      )
      .all<{
        rubric_item_id: number;
        points: number;
        comment: string;
        confidence: number | null;
      }>(evaluation.id);
    rows.push({
      id: evaluation.id,
      submissionId: evaluation.submission_id,
      role: evaluation.role,
      provider: evaluation.provider,
      model: evaluation.model,
      status: evaluation.status as EvaluationRow['status'],
      error: evaluation.error,
      reading: evaluation.reading,
      overallComment: evaluation.overall_comment,
      totalPoints: evaluation.total_points,
      startedAt: evaluation.started_at,
      finishedAt: evaluation.finished_at,
      items: scores.map((row) => ({
        rubricItemId: row.rubric_item_id,
        points: row.points,
        comment: row.comment,
        confidence: row.confidence,
      })),
    });
  }
  return rows;
}

export async function getGrade(submissionId: number): Promise<GradeRow | null> {
  const grade = await db
    .prepare('SELECT * FROM grades WHERE submission_id = $1')
    .get<{
      submission_id: number;
      total: number;
      overall_comment: string;
      status: string;
      approved_at: string | null;
      updated_at: string;
    }>(submissionId);
  if (!grade) return null;

  const items = await db
    .prepare(
      'SELECT rubric_item_id, points, comment, source FROM grade_items WHERE submission_id = $1',
    )
    .all<{
      rubric_item_id: number;
      points: number;
      comment: string;
      source: string;
    }>(submissionId);

  return {
    submissionId: grade.submission_id,
    total: grade.total,
    overallComment: grade.overall_comment,
    status: grade.status as GradeRow['status'],
    approvedAt: grade.approved_at,
    updatedAt: grade.updated_at,
    items: items.map((item) => ({
      rubricItemId: item.rubric_item_id,
      points: item.points,
      comment: item.comment,
      source: item.source as GradeRow['items'][number]['source'],
    })),
  };
}

export async function getSubmissionDetail(submissionId: number): Promise<SubmissionDetail | null> {
  const submission = await getSubmissionRow(submissionId);
  if (!submission) return null;
  const activity = await getActivityRow(submission.activityId);
  if (!activity) return null;
  const files = await listFiles('submission', submissionId);

  return {
    submission,
    activity: {
      id: activity.id,
      title: activity.title,
      subject: activity.subject,
      classId: activity.classId,
      description: activity.description,
    },
    student: { id: submission.studentId, name: submission.studentName },
    rubric: await listRubric(activity.id),
    pages: files.filter((file) => file.kind === 'page'),
    originals: files.filter((file) => file.kind === 'original'),
    documents: await listDocuments(activity.id),
    evaluations: await listEvaluations(submissionId),
    grade: await getGrade(submissionId),
    divergenceThreshold: (await getSettings()).divergenceThreshold,
  };
}

export async function getActivityBundle(activityId: number): Promise<ActivityBundle | null> {
  const activity = await getActivityRow(activityId);
  if (!activity) return null;
  const students = activity.classId ? await listStudents(activity.classId) : [];
  return {
    activity,
    rubric: await listRubric(activityId),
    documents: await listDocuments(activityId),
    submissions: await listSubmissions(activityId),
    students,
  };
}

export type { JobRow };
