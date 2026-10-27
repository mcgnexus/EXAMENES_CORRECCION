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

export function listClasses(): ClassRow[] {
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS student_count
       FROM classes c ORDER BY c.name COLLATE NOCASE ASC`,
    )
    .all() as ClassDb[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    subject: row.subject as ClassRow['subject'],
    studentCount: row.student_count,
    createdAt: row.created_at,
  }));
}

export function listStudents(classId: number): StudentRow[] {
  const rows = db
    .prepare('SELECT * FROM students WHERE class_id = ? ORDER BY sort_order ASC, id ASC')
    .all(classId) as {
    id: number;
    class_id: number;
    name: string;
    sort_order: number;
  }[];
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

export function listActivities(): ActivityRow[] {
  const rows = db.prepare(`${ACTIVITY_SELECT} ORDER BY a.id DESC`).all() as ActivityDb[];
  return rows.map(mapActivity);
}

export function getActivityRow(activityId: number): ActivityRow | null {
  const row = db.prepare(`${ACTIVITY_SELECT} WHERE a.id = ?`).get(activityId) as
    | ActivityDb
    | undefined;
  return row ? mapActivity(row) : null;
}

export function listRubric(activityId: number): RubricItem[] {
  return db
    .prepare('SELECT * FROM rubric_items WHERE activity_id = ? ORDER BY ord ASC, id ASC')
    .all(activityId)
    .map((row) => {
      const item = row as {
        id: number;
        activity_id: number;
        ord: number;
        title: string;
        description: string;
        max_points: number;
      };
      return {
        id: item.id,
        activityId: item.activity_id,
        ord: item.ord,
        title: item.title,
        description: item.description,
        maxPoints: item.max_points,
      };
    });
}

export function listDocuments(activityId: number): DocumentRow[] {
  const rows = db
    .prepare(
      `SELECT d.*,
         (SELECT COUNT(*) FROM files f WHERE f.owner_type = 'document' AND f.owner_id = d.id AND f.kind = 'page') AS page_count,
         (SELECT original_name FROM files f WHERE f.owner_type = 'document' AND f.owner_id = d.id AND f.kind = 'original' LIMIT 1) AS original_name,
         (SELECT mime FROM files f WHERE f.owner_type = 'document' AND f.owner_id = d.id AND f.kind = 'original' LIMIT 1) AS mime,
         (SELECT id FROM files f WHERE f.owner_type = 'document' AND f.owner_id = d.id AND f.kind = 'original' LIMIT 1) AS original_file_id
       FROM activity_documents d WHERE d.activity_id = ? ORDER BY d.id ASC`,
    )
    .all(activityId) as {
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
  }[];
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

export function listSubmissions(activityId: number): SubmissionRow[] {
  const rows = db
    .prepare(
      `SELECT s.*, st.name AS student_name,
         (SELECT COUNT(*) FROM files f WHERE f.owner_type = 'submission' AND f.owner_id = s.id AND f.kind = 'page') AS file_count
       FROM submissions s JOIN students st ON st.id = s.student_id
       WHERE s.activity_id = ? ORDER BY st.name COLLATE NOCASE ASC`,
    )
    .all(activityId) as {
    id: number;
    activity_id: number;
    student_id: number;
    student_name: string;
    status: string;
    error: string | null;
    created_at: string;
    file_count: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    activityId: row.activity_id,
    studentId: row.student_id,
    studentName: row.student_name,
    status: row.status as SubmissionRow['status'],
    error: row.error,
    createdAt: row.created_at,
    fileCount: row.file_count,
  }));
}

export function getSubmissionRow(submissionId: number): SubmissionRow | null {
  const row = db
    .prepare(
      `SELECT s.*, st.name AS student_name,
         (SELECT COUNT(*) FROM files f WHERE f.owner_type = 'submission' AND f.owner_id = s.id AND f.kind = 'page') AS file_count
       FROM submissions s JOIN students st ON st.id = s.student_id WHERE s.id = ?`,
    )
    .get(submissionId) as
    | {
        id: number;
        activity_id: number;
        student_id: number;
        student_name: string;
        status: string;
        error: string | null;
        created_at: string;
        file_count: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    activityId: row.activity_id,
    studentId: row.student_id,
    studentName: row.student_name,
    status: row.status as SubmissionRow['status'],
    error: row.error,
    createdAt: row.created_at,
    fileCount: row.file_count,
  };
}

export function listFiles(ownerType: 'document' | 'submission', ownerId: number): FileRow[] {
  const rows = db
    .prepare(
      'SELECT * FROM files WHERE owner_type = ? AND owner_id = ? ORDER BY kind ASC, page_no ASC, id ASC',
    )
    .all(ownerType, ownerId) as {
    id: number;
    owner_type: 'document' | 'submission';
    owner_id: number;
    original_name: string;
    mime: string;
    kind: 'original' | 'page';
    page_no: number | null;
  }[];
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

export function listEvaluations(submissionId: number): EvaluationRow[] {
  const evaluations = db
    .prepare('SELECT * FROM evaluations WHERE submission_id = ? ORDER BY id ASC')
    .all(submissionId) as {
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
  }[];

  return evaluations.map((evaluation) => ({
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
    items: (
      db
        .prepare(
          'SELECT rubric_item_id, points, comment, confidence FROM evaluation_scores WHERE evaluation_id = ?',
        )
        .all(evaluation.id) as {
        rubric_item_id: number;
        points: number;
        comment: string;
        confidence: number | null;
      }[]
    ).map((row) => ({
      rubricItemId: row.rubric_item_id,
      points: row.points,
      comment: row.comment,
      confidence: row.confidence,
    })),
  }));
}

export function getGrade(submissionId: number): GradeRow | null {
  const grade = db
    .prepare('SELECT * FROM grades WHERE submission_id = ?')
    .get(submissionId) as
    | {
        submission_id: number;
        total: number;
        overall_comment: string;
        status: string;
        approved_at: string | null;
        updated_at: string;
      }
    | undefined;
  if (!grade) return null;

  const items = db
    .prepare(
      'SELECT rubric_item_id, points, comment, source FROM grade_items WHERE submission_id = ?',
    )
    .all(submissionId) as {
    rubric_item_id: number;
    points: number;
    comment: string;
    source: string;
  }[];

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

export function getSubmissionDetail(submissionId: number): SubmissionDetail | null {
  const submission = getSubmissionRow(submissionId);
  if (!submission) return null;
  const activity = getActivityRow(submission.activityId);
  if (!activity) return null;
  const files = listFiles('submission', submissionId);

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
    rubric: listRubric(activity.id),
    pages: files.filter((file) => file.kind === 'page'),
    originals: files.filter((file) => file.kind === 'original'),
    documents: listDocuments(activity.id),
    evaluations: listEvaluations(submissionId),
    grade: getGrade(submissionId),
    divergenceThreshold: getSettings().divergenceThreshold,
  };
}

export function getActivityBundle(activityId: number): ActivityBundle | null {
  const activity = getActivityRow(activityId);
  if (!activity) return null;
  const students = activity.classId ? listStudents(activity.classId) : [];
  return {
    activity,
    rubric: listRubric(activityId),
    documents: listDocuments(activityId),
    submissions: listSubmissions(activityId),
    students,
  };
}

export type { JobRow };
