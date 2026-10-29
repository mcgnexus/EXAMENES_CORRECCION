export type Subject = 'biologia' | 'bioquimica';

export type SubmissionStatus =
  | 'uploaded'
  | 'queued'
  | 'running'
  | 'reviewed'
  | 'approved'
  | 'exported'
  | 'error';

export type EvaluationRole = 'primary' | 'independent';
export type EvaluationStatus = 'pending' | 'running' | 'done' | 'error';
export type DocumentKind = 'enunciado' | 'solucion' | 'rubrica' | 'documentacion';

export interface ClassRow {
  id: number;
  name: string;
  subject: Subject;
  studentCount: number;
  createdAt: string;
}

export interface StudentRow {
  id: number;
  classId: number;
  name: string;
  sortOrder: number;
}

export interface ActivityRow {
  id: number;
  title: string;
  subject: Subject;
  classId: number | null;
  className: string | null;
  description: string;
  status: 'draft' | 'active' | 'archived';
  createdAt: string;
  maxPoints: number;
  submissionCount: number;
  rubricCount: number;
}

export interface RubricItem {
  id: number;
  activityId: number;
  ord: number;
  title: string;
  description: string;
  maxPoints: number;
}

export interface DocumentRow {
  id: number;
  activityId: number;
  kind: DocumentKind;
  name: string;
  text: string | null;
  originalName: string;
  mime: string;
  originalFileId: number | null;
  pageCount: number;
  createdAt: string;
}

export interface SolutionTemplateRow {
  id: number;
  activityId: number;
  activityTitle: string;
  name: string;
  text: string;
  createdAt: string;
}

export interface FileRow {
  id: number;
  ownerType: 'document' | 'submission';
  ownerId: number;
  originalName: string;
  mime: string;
  kind: 'original' | 'page';
  pageNo: number | null;
  url: string;
}

export interface SubmissionRow {
  id: number;
  activityId: number;
  studentId: number;
  studentName: string;
  dni: string | null;
  course: string | null;
  className: string | null;
  status: SubmissionStatus;
  error: string | null;
  createdAt: string;
  fileCount: number;
}

export interface ModelScore {
  rubricItemId: number;
  points: number;
  comment: string;
  confidence: number | null;
}

export interface EvaluationRow {
  id: number;
  submissionId: number;
  role: EvaluationRole;
  provider: string;
  model: string;
  status: EvaluationStatus;
  error: string | null;
  reading: string | null;
  overallComment: string | null;
  totalPoints: number | null;
  items: ModelScore[];
  startedAt: string | null;
  finishedAt: string | null;
}

export interface GradeItem {
  rubricItemId: number;
  points: number;
  comment: string;
  source: 'proposal' | 'manual' | 'accepted';
}

export interface GradeRow {
  submissionId: number;
  total: number;
  overallComment: string;
  status: 'draft' | 'approved' | 'exported';
  approvedAt: string | null;
  updatedAt: string;
  items: GradeItem[];
}

export interface SubmissionDetail {
  submission: SubmissionRow;
  activity: { id: number; title: string; subject: Subject; classId: number | null; description: string };
  student: { id: number; name: string };
  rubric: RubricItem[];
  pages: FileRow[];
  originals: FileRow[];
  documents: DocumentRow[];
  evaluations: EvaluationRow[];
  grade: GradeRow | null;
  divergenceThreshold: number;
}

export interface JobRow {
  id: number;
  kind: string;
  status: 'queued' | 'running' | 'done' | 'error';
  total: number;
  done: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  submissionIds: number[];
}

export interface ProviderConfig {
  provider: string;
  model: string;
}

export interface AppSettings {
  primary: ProviderConfig;
  independent: ProviderConfig[];
  divergenceThreshold: number;
  concurrency: number;
  includeImages: boolean;
  maxPagesPerEvaluation: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
  requiresKey: boolean;
  keyVariable: string | null;
  defaultModel: string;
}

export interface ActivityBundle {
  activity: ActivityRow;
  rubric: RubricItem[];
  documents: DocumentRow[];
  submissions: SubmissionRow[];
  students: StudentRow[];
}

export type ScanKind = 'examen' | 'lista' | 'otro';

export interface ScanRubricItem {
  title: string;
  description: string;
  maxPoints: number;
}

export interface ScanResult {
  tipo: ScanKind;
  titulo: string;
  asignatura: string;
  enunciado: string;
  apartados: ScanRubricItem[];
  nombres: string[];
  dni: string;
  curso: string;
  clase: string;
  observaciones: string;
}
