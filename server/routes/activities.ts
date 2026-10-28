import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, getSettings, nowIso } from '../db';
import { badRequest, notFound } from '../errors';
import {
  getActivityBundle,
  getActivityRow,
  listActivities,
  listDocuments,
  listRubric,
} from '../mappers';
import { runProviderScan, runProviderSolve, runWithModelFailover } from '../llm/providers';
import type { ImagePart } from '../llm/types';
import { buildSolutionPdf } from '../export/solution';
import { insertFile, readFileBase64, removeOwnerFiles, storeUpload } from '../storage';
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

async function assertActivity(activityId: number): Promise<void> {
  const row = await db.prepare('SELECT id FROM activities WHERE id = $1').get(activityId);
  if (!row) throw notFound('Actividad no encontrada');
}

export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/activities', async () => listActivities());

  app.get('/api/activities/:id', async (request) => {
    const activityId = Number((request.params as { id: string }).id);
    const bundle = await getActivityBundle(activityId);
    if (!bundle) throw notFound('Actividad no encontrada');
    return bundle;
  });

  // Las soluciones de la misma asignatura quedan disponibles como plantillas reutilizables.
  app.get('/api/activities/:id/solution-templates', async (request) => {
    const activityId = Number((request.params as { id: string }).id);
    const activity = await getActivityRow(activityId);
    if (!activity) throw notFound('Actividad no encontrada');
    return db
      .prepare(
        `SELECT d.id, d.activity_id, a.title AS activity_title, d.name, d.text, d.created_at
         FROM activity_documents d JOIN activities a ON a.id = d.activity_id
         WHERE a.subject = $1 AND a.id <> $2 AND d.kind = 'solucion'
           AND d.text IS NOT NULL AND length(trim(d.text)) > 0
         ORDER BY d.created_at DESC, d.id DESC`,
      )
      .all<{
        id: number;
        activity_id: number;
        activity_title: string;
        name: string;
        text: string;
        created_at: string;
      }>(activity.subject, activityId)
      .then((rows) =>
        rows.map((row) => ({
          id: row.id,
          activityId: row.activity_id,
          activityTitle: row.activity_title,
          name: row.name,
          text: row.text,
          createdAt: row.created_at,
        })),
      );
  });

  app.post('/api/activities/:id/solution-templates/:documentId', async (request, reply) => {
    const activityId = Number((request.params as { id: string }).id);
    const documentId = Number((request.params as { documentId: string }).documentId);
    const activity = await getActivityRow(activityId);
    if (!activity) throw notFound('Actividad no encontrada');
    const template = await db
      .prepare(
        `SELECT d.name, d.text FROM activity_documents d
         JOIN activities a ON a.id = d.activity_id
         WHERE d.id = $1 AND d.kind = 'solucion' AND a.subject = $2
           AND a.id <> $3 AND d.text IS NOT NULL AND length(trim(d.text)) > 0`,
      )
      .get<{ name: string; text: string }>(documentId, activity.subject, activityId);
    if (!template) throw notFound('Plantilla no encontrada para esta asignatura');
    const name = `Plantilla · ${template.name}`.slice(0, 200);
    await db
      .prepare(
        "INSERT INTO activity_documents (activity_id, kind, name, text, created_at) VALUES ($1, 'solucion', $2, $3, $4)",
      )
      .run(activityId, name, template.text, nowIso());
    reply.code(201);
    return listDocuments(activityId);
  });

  app.get('/api/activities/:activityId/documents/:documentId/download', async (request, reply) => {
    const { activityId: rawActivityId, documentId: rawDocumentId } = request.params as {
      activityId: string;
      documentId: string;
    };
    const activityId = Number(rawActivityId);
    const documentId = Number(rawDocumentId);
    const row = await db
      .prepare(
        `SELECT d.name, d.text, a.title AS activity_title
         FROM activity_documents d JOIN activities a ON a.id = d.activity_id
         WHERE d.id = $1 AND d.activity_id = $2 AND d.kind = 'solucion'`,
      )
      .get<{ name: string; text: string | null; activity_title: string }>(documentId, activityId);
    if (!row) throw notFound('Solución no encontrada');
    if (!row.text?.trim()) throw badRequest('La solución no contiene texto para descargar');
    const format = (request.query as { format?: string }).format;
    if (format === 'md') {
      reply
        .type('text/markdown; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="solucion-${documentId}.md"`)
        .header('Cache-Control', 'no-store');
      return row.text;
    }
    if (format !== 'pdf') throw badRequest('Formato inválido. Usa format=md o format=pdf');
    const pdf = await buildSolutionPdf({
      title: row.name,
      activityTitle: row.activity_title,
      markdown: row.text,
    });
    return reply
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename="solucion-${documentId}.pdf"`)
      .header('Cache-Control', 'no-store')
      .send(pdf);
  });

  app.post('/api/activities', async (request, reply) => {
    const body = activitySchema.parse(request.body ?? {});
    if (body.classId) {
      const exists = await db.prepare('SELECT id FROM classes WHERE id = $1').get(body.classId);
      if (!exists) throw badRequest('La clase indicada no existe');
    }
    const created = await db
      .prepare(
        `INSERT INTO activities (title, subject, class_id, description, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      )
      .get<{ id: number }>(
        body.title,
        body.subject,
        body.classId ?? null,
        body.description ?? '',
        body.status ?? 'draft',
        nowIso(),
      );
    reply.code(201);
    return getActivityBundle(created?.id ?? 0);
  });

  app.patch('/api/activities/:id', async (request) => {
    const activityId = Number((request.params as { id: string }).id);
    await assertActivity(activityId);
    const body = activitySchema.partial().parse(request.body ?? {});
    if (body.classId !== undefined && body.classId !== null) {
      const exists = await db.prepare('SELECT id FROM classes WHERE id = $1').get(body.classId);
      if (!exists) throw badRequest('La clase indicada no existe');
    }
    const current = await db
      .prepare('SELECT * FROM activities WHERE id = $1')
      .get<{
        title: string;
        subject: string;
        class_id: number | null;
        description: string;
        status: string;
      }>(activityId);
    if (!current) throw notFound('Actividad no encontrada');
    await db
      .prepare(
        `UPDATE activities SET title = $1, subject = $2, class_id = $3, description = $4, status = $5
         WHERE id = $6`,
      )
      .run(
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
    await assertActivity(activityId);
    const documents = await db
      .prepare('SELECT id FROM activity_documents WHERE activity_id = $1')
      .all<{ id: number }>(activityId);
    const submissions = await db
      .prepare('SELECT id FROM submissions WHERE activity_id = $1')
      .all<{ id: number }>(activityId);
    for (const document of documents) await removeOwnerFiles('document', document.id);
    for (const submission of submissions) await removeOwnerFiles('submission', submission.id);
    await db.prepare('DELETE FROM activities WHERE id = $1').run(activityId);
    reply.code(204).send();
  });

  app.put('/api/activities/:id/rubric', async (request) => {
    const activityId = Number((request.params as { id: string }).id);
    await assertActivity(activityId);
    const body = rubricSchema.parse(request.body ?? {});
    const existing = await db
      .prepare('SELECT id FROM rubric_items WHERE activity_id = $1')
      .all<{ id: number }>(activityId);
    const keepIds = new Set(body.items.filter((item) => item.id).map((item) => item.id as number));
    const ownedIds = new Set(existing.map((row) => row.id));

    for (const item of body.items) {
      if (item.id && !ownedIds.has(item.id)) {
        throw badRequest(`El apartado ${item.id} no pertenece a esta actividad`);
      }
    }

    await db.transaction(async (tx) => {
      for (const row of existing) {
        if (!keepIds.has(row.id)) {
          await tx.prepare('DELETE FROM rubric_items WHERE id = $1').run(row.id);
        }
      }
      for (let index = 0; index < body.items.length; index += 1) {
        const item = body.items[index];
        if (item.id) {
          await tx
            .prepare(
              'UPDATE rubric_items SET ord = $1, title = $2, description = $3, max_points = $4 WHERE id = $5',
            )
            .run(index + 1, item.title, item.description ?? '', item.maxPoints, item.id);
        } else {
          await tx
            .prepare(
              'INSERT INTO rubric_items (activity_id, ord, title, description, max_points) VALUES ($1, $2, $3, $4, $5)',
            )
            .run(activityId, index + 1, item.title, item.description ?? '', item.maxPoints);
        }
      }
    });

    return listRubric(activityId);
  });

  app.post('/api/activities/:id/documents', async (request, reply) => {
    const activityId = Number((request.params as { id: string }).id);
    await assertActivity(activityId);
    const { fields, files } = await collectMultipart(request);
    if (files.length === 0) throw badRequest('Falta el archivo del documento');
    const kindParsed = documentKind.safeParse(fields.kind);
    if (!kindParsed.success) {
      throw badRequest('Tipo de documento inválido (enunciado, solucion, rubrica o documentacion)');
    }
    const name = (fields.name ?? files[0].filename).trim() || files[0].filename;

    const created = await db
      .prepare(
        'INSERT INTO activity_documents (activity_id, kind, name, text, created_at) VALUES ($1, $2, $3, NULL, $4) RETURNING id',
      )
      .get<{ id: number }>(activityId, kindParsed.data, name, nowIso());
    const documentId = created?.id ?? 0;

    let pageNo = 0;
    for (const file of files) {
      const stored = await storeUpload('document', documentId, file);
      if (stored.text !== null) {
        await db
          .prepare('UPDATE activity_documents SET text = $1 WHERE id = $2')
          .run(stored.text, documentId);
      }
      await insertFile({
        ownerType: 'document',
        ownerId: documentId,
        originalName: stored.original.originalName,
        storedPath: stored.original.storedPath,
        mime: stored.original.mime,
        kind: 'original',
        pageNo: null,
      });
      for (const page of stored.pages) {
        pageNo += 1;
        await insertFile({
          ownerType: 'document',
          ownerId: documentId,
          originalName: stored.original.originalName,
          storedPath: page.storedPath,
          mime: page.mime,
          kind: 'page',
          pageNo,
        });
      }
    }

    reply.code(201);
    return (await listDocuments(activityId)).find((document) => document.id === documentId);
  });

  // Propone la rúbrica a partir del enunciado, la solución/plantilla y el resto de documentos.
  app.post('/api/activities/:id/generate-rubric', async (request) => {
    const activityId = Number((request.params as { id: string }).id);
    const activity = await getActivityRow(activityId);
    if (!activity) throw notFound('Actividad no encontrada');

    const documents = await listDocuments(activityId);
    const labels: Record<string, string> = {
      enunciado: 'Enunciado',
      solucion: 'Solución o plantilla',
      rubrica: 'Rúbrica existente',
      documentacion: 'Documentación',
    };
    const contextParts: string[] = [];
    if (activity.description.trim()) contextParts.push(`Descripción: ${activity.description.trim()}`);
    for (const doc of documents) {
      if (!doc.text?.trim()) continue;
      contextParts.push(`${labels[doc.kind] ?? doc.kind} · ${doc.name}:\n${doc.text.trim()}`);
    }

    const images: ImagePart[] = [];
    const settings = await getSettings();
    if (settings.includeImages) {
      for (const doc of documents.filter((item) => item.kind === 'enunciado')) {
        const pages = await db
          .prepare(
            "SELECT stored_path, mime FROM files WHERE owner_type = 'document' AND owner_id = $1 AND kind = 'page' ORDER BY page_no ASC, id ASC",
          )
          .all<{ stored_path: string; mime: string }>(doc.id);
        for (const page of pages) {
          if (images.length >= settings.maxPagesPerEvaluation) break;
          if (!page.mime.startsWith('image/')) continue;
          try {
            images.push({
              label: `Enunciado · ${doc.name} · página ${images.length + 1}`,
              mime: page.mime,
              base64: await readFileBase64(page.stored_path),
            });
          } catch {
            /* página antigua o ya eliminada: seguimos con el texto disponible */
          }
        }
        if (images.length >= settings.maxPagesPerEvaluation) break;
      }
    }

    if (contextParts.length === 0 && images.length === 0) {
      throw badRequest('Sube el enunciado o la plantilla para poder proponer la rúbrica');
    }

    let result;
    try {
      result = await runWithModelFailover(
        settings.primary,
        settings.independent,
        (provider, model) =>
          runProviderScan(provider, model, {
            esperado: 'examen',
            images,
            contexto: contextParts.join('\n\n'),
          }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw badRequest(`No se ha podido generar la rúbrica: ${message}`);
    }

    const items = result.apartados
      .map((item) => ({
        title: item.title.trim(),
        description: item.description.trim(),
        maxPoints: item.maxPoints,
      }))
      .filter((item) => item.title.length > 0);
    if (items.length === 0) {
      throw badRequest(
        'El modelo no ha propuesto apartados. Revisa que el enunciado se lea bien o crea la rúbrica manualmente.',
      );
    }
    return { items, observaciones: result.observaciones };
  });

  // Genera la plantilla de respuestas con IA cuando no existe solución de referencia.
  app.post('/api/activities/:id/generate-solution', async (request) => {
    const activityId = Number((request.params as { id: string }).id);
    const activity = await getActivityRow(activityId);
    if (!activity) throw notFound('Actividad no encontrada');

    const documents = await listDocuments(activityId);
    const enunciados = documents.filter((doc) => doc.kind === 'enunciado');
    if (enunciados.length === 0) {
      throw badRequest('Sube primero el enunciado (PDF o foto) para poder generar la plantilla');
    }

    const MAX_ENUNCIADO_PAGES = 6;
    const images: ImagePart[] = [];
    let enunciadoText = '';
    for (const doc of enunciados) {
      if (doc.text) enunciadoText += `${doc.text}\n\n`;
      if (images.length >= MAX_ENUNCIADO_PAGES) continue;
      const pages = await db
        .prepare(
          "SELECT stored_path, mime FROM files WHERE owner_type = 'document' AND owner_id = $1 AND kind = 'page' ORDER BY page_no ASC, id ASC",
        )
        .all<{ stored_path: string; mime: string }>(doc.id);
      for (let index = 0; index < pages.length; index += 1) {
        if (images.length >= MAX_ENUNCIADO_PAGES) break;
        const page = pages[index];
        if (!page.mime.startsWith('image/')) continue;
        images.push({
          label: `Enunciado · ${doc.name} · página ${index + 1}`,
          mime: page.mime,
          base64: await readFileBase64(page.stored_path),
        });
      }
    }
    if (!enunciadoText.trim() && images.length === 0) {
      throw badRequest('El enunciado no tiene texto ni páginas legibles desde las que generar la plantilla');
    }

    const rubric = await listRubric(activityId);
    const settings = await getSettings();

    let respuestas: string;
    try {
      const solved = await runWithModelFailover(
        settings.primary,
        settings.independent,
        (provider, model) =>
          runProviderSolve(provider, model, {
            subject: activity.subject,
            enunciado: enunciadoText,
            images,
            apartados: rubric.map((item) => ({ title: item.title, maxPoints: item.maxPoints })),
          }),
      );
      respuestas = solved.respuestas.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw badRequest(`La generación de la plantilla ha fallado: ${message}. Reinténtalo en unos segundos.`);
    }
    if (!respuestas) throw badRequest('El modelo no ha devuelto respuestas. Reinténtalo en unos segundos.');

    // Upsert: si ya existe una solución generada por IA, se actualiza su texto
    // en lugar de crear un documento duplicado.
    const GENERATED_SOLUTION_NAME = 'Solución generada por IA';
    const existing = documents.find(
      (doc) => doc.kind === 'solucion' && doc.name === GENERATED_SOLUTION_NAME,
    );
    if (existing) {
      await db
        .prepare('UPDATE activity_documents SET text = $1 WHERE id = $2')
        .run(respuestas, existing.id);
    } else {
      await db
        .prepare(
          "INSERT INTO activity_documents (activity_id, kind, name, text, created_at) VALUES ($1, 'solucion', $2, $3, $4)",
        )
        .run(activityId, GENERATED_SOLUTION_NAME, respuestas, nowIso());
    }
    return listDocuments(activityId);
  });

  app.delete('/api/documents/:id', async (request, reply) => {
    const documentId = Number((request.params as { id: string }).id);
    const row = await db.prepare('SELECT id FROM activity_documents WHERE id = $1').get(documentId);
    if (!row) throw notFound('Documento no encontrado');
    await removeOwnerFiles('document', documentId);
    await db.prepare('DELETE FROM activity_documents WHERE id = $1').run(documentId);
    reply.code(204).send();
  });
}
