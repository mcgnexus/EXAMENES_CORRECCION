import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, nowIso } from '../db';
import { badRequest, notFound } from '../errors';
import {
  getActivityBundle,
  listActivities,
  listDocuments,
  listRubric,
} from '../mappers';
import { insertFile, removeOwnerFiles, storeUpload } from '../storage';
import { collectMultipart } from '../multipart';

const activitySchema = z.object({
  title: z.string().trim().min(1).max(200),
  subject: z.enum(['biologia', 'bioquimica']).default('biologia'),
  classId: z.number().int().positive().nullable().optional(),
  description: z.string().max(4000).optional().default(''),
  status: z.enum(['draft', 'active', 'archived']).optional().default('draft'),
});

const rubricSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.number().int().positive().optional(),
        title: z.string().trim().min(1).max(200),
        description: z.string().max(4000).optional().default(''),
        maxPoints: z.number().positive().max(1000),
      }),
    )
    .min(1, 'La rúbrica necesita al menos un apartado'),
});

const documentKind = z.enum(['enunciado', 'solucion', 'rubrica', 'documentacion']);

function assertActivity(activityId: number): void {
  const row = db.prepare('SELECT id FROM activities WHERE id = ?').get(activityId);
  if (!row) throw notFound('Actividad no encontrada');
}

export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/activities', async () => listActivities());

  app.get('/api/activities/:id', async (request) => {
    const activityId = Number((request.params as { id: string }).id);
    const bundle = getActivityBundle(activityId);
    if (!bundle) throw notFound('Actividad no encontrada');
    return bundle;
  });

  app.post('/api/activities', async (request, reply) => {
    const body = activitySchema.parse(request.body ?? {});
    if (body.classId) {
      const exists = db.prepare('SELECT id FROM classes WHERE id = ?').get(body.classId);
      if (!exists) throw badRequest('La clase indicada no existe');
    }
    const result = db
      .prepare(
        `INSERT INTO activities (title, subject, class_id, description, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.title,
        body.subject,
        body.classId ?? null,
        body.description ?? '',
        body.status ?? 'draft',
        nowIso(),
      );
    reply.code(201);
    return getActivityBundle(Number(result.lastInsertRowid));
  });

  app.patch('/api/activities/:id', async (request) => {
    const activityId = Number((request.params as { id: string }).id);
    assertActivity(activityId);
    const body = activitySchema.partial().parse(request.body ?? {});
    if (body.classId !== undefined && body.classId !== null) {
      const exists = db.prepare('SELECT id FROM classes WHERE id = ?').get(body.classId);
      if (!exists) throw badRequest('La clase indicada no existe');
    }
    const current = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId) as {
      title: string;
      subject: string;
      class_id: number | null;
      description: string;
      status: string;
    };
    db.prepare(
      `UPDATE activities SET title = ?, subject = ?, class_id = ?, description = ?, status = ?
       WHERE id = ?`,
    ).run(
      body.title ?? current.title,
      body.subject ?? current.subject,
      body.classId === undefined ? current.class_id : body.classId,
      body.description ?? current.description,
      body.status ?? current.status,
      activityId,
    );
    return getActivityBundle(activityId);
  });

  app.delete('/api/activities/:id', async (request, reply) => {
    const activityId = Number((request.params as { id: string }).id);
    assertActivity(activityId);
    const documents = db
      .prepare('SELECT id FROM activity_documents WHERE activity_id = ?')
      .all(activityId) as { id: number }[];
    const submissions = db
      .prepare('SELECT id FROM submissions WHERE activity_id = ?')
      .all(activityId) as { id: number }[];
    for (const document of documents) await removeOwnerFiles('document', document.id);
    for (const submission of submissions) await removeOwnerFiles('submission', submission.id);
    db.prepare('DELETE FROM activities WHERE id = ?').run(activityId);
    reply.code(204).send();
  });

  app.put('/api/activities/:id/rubric', async (request) => {
    const activityId = Number((request.params as { id: string }).id);
    assertActivity(activityId);
    const body = rubricSchema.parse(request.body ?? {});
    const existing = db
      .prepare('SELECT id FROM rubric_items WHERE activity_id = ?')
      .all(activityId) as { id: number }[];
    const keepIds = new Set(body.items.filter((item) => item.id).map((item) => item.id as number));
    const ownedIds = new Set(existing.map((row) => row.id));

    for (const item of body.items) {
      if (item.id && !ownedIds.has(item.id)) {
        throw badRequest(`El apartado ${item.id} no pertenece a esta actividad`);
      }
    }

    db.transaction(() => {
      for (const row of existing) {
        if (!keepIds.has(row.id)) {
          db.prepare('DELETE FROM rubric_items WHERE id = ?').run(row.id);
        }
      }
      body.items.forEach((item, index) => {
        if (item.id) {
          db.prepare(
            'UPDATE rubric_items SET ord = ?, title = ?, description = ?, max_points = ? WHERE id = ?',
          ).run(index + 1, item.title, item.description ?? '', item.maxPoints, item.id);
        } else {
          db.prepare(
            'INSERT INTO rubric_items (activity_id, ord, title, description, max_points) VALUES (?, ?, ?, ?, ?)',
          ).run(activityId, index + 1, item.title, item.description ?? '', item.maxPoints);
        }
      });
    })();

    return listRubric(activityId);
  });

  app.post('/api/activities/:id/documents', async (request, reply) => {
    const activityId = Number((request.params as { id: string }).id);
    assertActivity(activityId);
    const { fields, files } = await collectMultipart(request);
    const file = files[0];
    if (!file) throw badRequest('Falta el archivo del documento');
    const kindParsed = documentKind.safeParse(fields.kind);
    if (!kindParsed.success) {
      throw badRequest('Tipo de documento inválido (enunciado, solucion, rubrica o documentacion)');
    }
    const name = (fields.name ?? file.filename).trim() || file.filename;

    const created = db
      .prepare(
        'INSERT INTO activity_documents (activity_id, kind, name, text, created_at) VALUES (?, ?, ?, NULL, ?)',
      )
      .run(activityId, kindParsed.data, name, nowIso());
    const documentId = Number(created.lastInsertRowid);

    const stored = await storeUpload('document', documentId, file);
    if (stored.text !== null) {
      db.prepare('UPDATE activity_documents SET text = ? WHERE id = ?').run(stored.text, documentId);
    }
    insertFile({
      ownerType: 'document',
      ownerId: documentId,
      originalName: stored.original.originalName,
      storedPath: stored.original.storedPath,
      mime: stored.original.mime,
      kind: 'original',
      pageNo: null,
    });
    for (const page of stored.pages) {
      insertFile({
        ownerType: 'document',
        ownerId: documentId,
        originalName: stored.original.originalName,
        storedPath: page.storedPath,
        mime: page.mime,
        kind: 'page',
        pageNo: page.pageNo,
      });
    }

    reply.code(201);
    return listDocuments(activityId).find((document) => document.id === documentId);
  });

  app.delete('/api/documents/:id', async (request, reply) => {
    const documentId = Number((request.params as { id: string }).id);
    const row = db
      .prepare('SELECT id FROM activity_documents WHERE id = ?')
      .get(documentId);
    if (!row) throw notFound('Documento no encontrado');
    await removeOwnerFiles('document', documentId);
    db.prepare('DELETE FROM activity_documents WHERE id = ?').run(documentId);
    reply.code(204).send();
  });
}
