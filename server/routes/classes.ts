import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, nowIso } from '../db';
import { badRequest, conflict, notFound } from '../errors';
import { listClasses, listStudents } from '../mappers';

const classSchema = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.enum(['biologia', 'bioquimica']).default('biologia'),
});

const studentSchema = z.object({ name: z.string().trim().min(1).max(120) });

const importSchema = z.object({ text: z.string().min(1) });

function parseNameLines(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const names: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // Solo se descarta una cabecera real (Nombre, Alumno, Student…), nunca un
    // nombre con número como «Alumno 01».
    if (
      index === 0 &&
      !/\d/.test(line) &&
      /^(nombre|alumno|alumna|alumnos|estudiante|estudiantes|student|name)\b/i.test(line)
    ) {
      continue;
    }
    const first = line.split(/[;,\t]/)[0]?.trim() ?? '';
    if (first) names.push(first);
  }
  return names;
}

async function assertClass(classId: number): Promise<{ id: number; name: string; subject: string }> {
  const row = await db
    .prepare('SELECT * FROM classes WHERE id = $1')
    .get<{ id: number; name: string; subject: string }>(classId);
  if (!row) throw notFound('Clase no encontrada');
  return row;
}

export async function registerClassRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/classes', async () => listClasses());

  app.post('/api/classes', async (request, reply) => {
    const body = classSchema.parse(request.body ?? {});
    const created = await db
      .prepare('INSERT INTO classes (name, subject, created_at) VALUES ($1, $2, $3) RETURNING id')
      .get<{ id: number }>(body.name, body.subject, nowIso());
    reply.code(201);
    return (await listClasses()).find((row) => row.id === created?.id);
  });

  app.patch('/api/classes/:id', async (request) => {
    const classId = Number((request.params as { id: string }).id);
    await assertClass(classId);
    const body = classSchema.partial().parse(request.body ?? {});
    if (body.name !== undefined) {
      await db.prepare('UPDATE classes SET name = $1 WHERE id = $2').run(body.name, classId);
    }
    if (body.subject !== undefined) {
      await db.prepare('UPDATE classes SET subject = $1 WHERE id = $2').run(body.subject, classId);
    }
    return (await listClasses()).find((row) => row.id === classId);
  });

  app.delete('/api/classes/:id', async (request, reply) => {
    const classId = Number((request.params as { id: string }).id);
    await assertClass(classId);
    const linked = await db
      .prepare('SELECT COUNT(*) AS total FROM activities WHERE class_id = $1')
      .get<{ total: number }>(classId);
    if ((linked?.total ?? 0) > 0) {
      throw conflict('La clase tiene actividades asociadas. Reasígnalas o bórralas primero.');
    }
    await db.prepare('DELETE FROM classes WHERE id = $1').run(classId);
    reply.code(204).send();
  });

  app.get('/api/classes/:id/students', async (request) => {
    const classId = Number((request.params as { id: string }).id);
    await assertClass(classId);
    return listStudents(classId);
  });

  app.post('/api/classes/:id/students', async (request, reply) => {
    const classId = Number((request.params as { id: string }).id);
    await assertClass(classId);
    const body = studentSchema.parse(request.body ?? {});
    const next = await db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM students WHERE class_id = $1')
      .get<{ next: number }>(classId);
    const sortOrder = next?.next ?? 1;
    const created = await db
      .prepare(
        'INSERT INTO students (class_id, name, sort_order, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
      )
      .get<{ id: number }>(classId, body.name, sortOrder, nowIso());
    reply.code(201);
    return { id: created?.id, classId, name: body.name, sortOrder };
  });

  app.post('/api/classes/:id/students/import', async (request) => {
    const classId = Number((request.params as { id: string }).id);
    await assertClass(classId);
    const body = importSchema.parse(request.body ?? {});
    const names = parseNameLines(body.text);
    if (names.length === 0) throw badRequest('No se ha detectado ningún nombre en el texto');

    const next = await db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS max FROM students WHERE class_id = $1')
      .get<{ max: number }>(classId);
    let order = next?.max ?? 0;
    await db.transaction(async (tx) => {
      for (const name of names) {
        order += 1;
        await tx
          .prepare(
            'INSERT INTO students (class_id, name, sort_order, created_at) VALUES ($1, $2, $3, $4)',
          )
          .run(classId, name, order, nowIso());
      }
    });

    return { imported: names.length, students: await listStudents(classId) };
  });

  app.patch('/api/students/:id', async (request) => {
    const studentId = Number((request.params as { id: string }).id);
    const existing = await db
      .prepare('SELECT * FROM students WHERE id = $1')
      .get<{ id: number; class_id: number }>(studentId);
    if (!existing) throw notFound('Alumno no encontrado');
    const body = studentSchema.parse(request.body ?? {});
    await db.prepare('UPDATE students SET name = $1 WHERE id = $2').run(body.name, studentId);
    return { id: studentId, classId: existing.class_id, name: body.name };
  });

  app.delete('/api/students/:id', async (request, reply) => {
    const studentId = Number((request.params as { id: string }).id);
    const existing = await db.prepare('SELECT id FROM students WHERE id = $1').get(studentId);
    if (!existing) throw notFound('Alumno no encontrado');
    await db.prepare('DELETE FROM students WHERE id = $1').run(studentId);
    reply.code(204).send();
  });
}
