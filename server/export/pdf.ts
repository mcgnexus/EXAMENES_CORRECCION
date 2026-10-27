import fs from 'node:fs/promises';
import PDFDocument from 'pdfkit';
import type { RubricItem } from '../../shared/types';
import { db } from '../db';
import { listRubric } from '../mappers';
import { absPath } from '../storage';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador (sin aprobar)',
  approved: 'Aprobada',
  exported: 'Exportada',
};

interface ReportData {
  activityTitle: string;
  activitySubject: string;
  studentName: string;
  rubric: RubricItem[];
  grade:
    | { total: number; overallComment: string; status: string; approvedAt: string | null }
    | null;
  items: { rubricItemId: number; points: number; comment: string }[];
  pages: { storedPath: string }[];
}

async function loadReportData(submissionId: number): Promise<ReportData> {
  const submission = await db
    .prepare(
      `SELECT s.id, s.activity_id, st.name AS student_name
       FROM submissions s JOIN students st ON st.id = s.student_id WHERE s.id = $1`,
    )
    .get<{ id: number; activity_id: number; student_name: string }>(submissionId);
  if (!submission) throw new Error('Entrega no encontrada');

  const activity = await db
    .prepare('SELECT * FROM activities WHERE id = $1')
    .get<{ id: number; title: string; subject: string }>(submission.activity_id);
  if (!activity) throw new Error('Actividad no encontrada');

  const rubric = await listRubric(activity.id);

  const gradeRow = await db
    .prepare('SELECT * FROM grades WHERE submission_id = $1')
    .get<{
      total: number;
      overall_comment: string;
      status: string;
      approved_at: string | null;
    }>(submissionId);

  const itemRows = await db
    .prepare('SELECT rubric_item_id, points, comment FROM grade_items WHERE submission_id = $1')
    .all<{ rubric_item_id: number; points: number; comment: string }>(submissionId);

  const pages = await db
    .prepare(
      "SELECT stored_path FROM files WHERE owner_type = 'submission' AND owner_id = $1 AND kind = 'page' ORDER BY page_no ASC, id ASC",
    )
    .all<{ stored_path: string }>(submissionId);

  return {
    activityTitle: activity.title,
    activitySubject: activity.subject,
    studentName: submission.student_name,
    rubric,
    grade: gradeRow
      ? {
          total: gradeRow.total,
          overallComment: gradeRow.overall_comment,
          status: gradeRow.status,
          approvedAt: gradeRow.approved_at,
        }
      : null,
    items: itemRows.map((row) => ({
      rubricItemId: row.rubric_item_id,
      points: row.points,
      comment: row.comment,
    })),
    pages: pages.map((page) => ({ storedPath: page.stored_path })),
  };
}

function subjectLabel(subject: string): string {
  return subject === 'bioquimica' ? 'Bioquímica' : 'Biología';
}

export async function buildSubmissionReportPdf(
  submissionId: number,
): Promise<{ filename: string; buffer: Buffer }> {
  const data = await loadReportData(submissionId);
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Corrección ${data.studentName}` } });
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = 40;
  const contentWidth = 515;

  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text('Hoja de corrección');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(11).fillColor('#374151');
  doc.text(`${data.activityTitle} · ${subjectLabel(data.activitySubject)}`);
  doc.text(`Alumno/a: ${data.studentName}`);
  doc.text(`Estado: ${STATUS_LABEL[data.grade?.status ?? 'draft'] ?? data.grade?.status ?? 'Sin corregir'}`);
  if (data.grade?.approvedAt) {
    doc.text(`Fecha de aprobación: ${new Date(data.grade.approvedAt).toLocaleString('es-ES')}`);
  }
  doc.moveDown(0.8);

  const maxTotal = data.rubric.reduce((sum, item) => sum + item.maxPoints, 0);
  const total = data.grade?.total ?? 0;
  const percent = maxTotal > 0 ? Math.round((total / maxTotal) * 1000) / 10 : 0;

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827');
  doc.text(`Calificación: ${total.toFixed(1)} / ${maxTotal.toFixed(1)}  (${percent}%)`);
  doc.moveDown(0.6);

  doc.fontSize(11).text('Detalle por apartado', left, doc.y);
  doc.moveDown(0.4);

  const colTitle = left;
  const colPoints = left + 280;
  const colComment = left + 350;
  const titleWidth = 270;
  const commentWidth = contentWidth - 350;

  const headerY = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#6b7280');
  doc.text('Apartado', colTitle, headerY, { width: titleWidth });
  doc.text('Puntos', colPoints, headerY, { width: 60 });
  doc.text('Comentario', colComment, headerY, { width: commentWidth });
  doc.moveDown(0.4);
  doc
    .moveTo(left, doc.y)
    .lineTo(left + contentWidth, doc.y)
    .strokeColor('#d1d5db')
    .stroke();
  doc.moveDown(0.4);

  for (const rubricItem of data.rubric) {
    const item = data.items.find((entry) => entry.rubricItemId === rubricItem.id);
    const comment = item?.comment || '—';
    const startY = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor('#111827');
    doc.text(rubricItem.title, colTitle, startY, { width: titleWidth });
    const titleHeight = doc.heightOfString(rubricItem.title, { width: titleWidth });
    doc.text(`${(item?.points ?? 0).toFixed(1)} / ${rubricItem.maxPoints}`, colPoints, startY, {
      width: 60,
    });
    doc.fillColor('#374151').text(comment, colComment, startY, { width: commentWidth });
    const commentHeight = doc.heightOfString(comment, { width: commentWidth });
    doc.y = startY + Math.max(titleHeight, commentHeight) + 8;
  }

  doc.moveDown(0.4);
  doc
    .moveTo(left, doc.y)
    .lineTo(left + contentWidth, doc.y)
    .strokeColor('#d1d5db')
    .stroke();
  doc.moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Comentario general');
  doc.font('Helvetica').fontSize(9).fillColor('#374151');
  doc.text(data.grade?.overallComment || 'Sin comentario general.', left, doc.y + 4, {
    width: contentWidth,
  });

  for (let index = 0; index < data.pages.length; index += 1) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827');
    doc.text(`${data.studentName} · página ${index + 1}`, left, 40);
    try {
      const buffer = await fs.readFile(absPath(data.pages[index].storedPath));
      doc.image(buffer, left, 70, {
        fit: [contentWidth, 720],
        align: 'center',
        valign: 'center',
      });
    } catch {
      doc.font('Helvetica').fontSize(9).fillColor('#9ca3af').text('(imagen no disponible)');
    }
  }

  doc.end();
  const buffer = await finished;
  const safeName = data.studentName.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '_');
  return {
    filename: `correccion_${safeName || submissionId}.pdf`,
    buffer,
  };
}
