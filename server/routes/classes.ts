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

function assertClass(classId: number): { id: number; name: string; subject: string } {
  const row = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId) as
    | { id: number; name: string; subject: string }
    | undefined;
  if (!row) throw notFound('Clase no encontrada');
  return row;
}

export async function registerClassRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/classes', async () => listClasses());

  app.post('/api/classes', async (request, reply) => {
    const body = classSchema.parse(request.body ?? {});
    const result = db
      .prepare('INSERT INTO classes (name, subject, created_at) VALUES (?, ?, ?)')
      .run(body.name, body.subject, nowIso());
    reply.code(201);
    return listClasses().find((row) => row.id === Number(result.lastInsertRowid));
  });

  app.patch('/api/classes/:id', async (request) => {
    const classId = Number((request.params as { id: string }).id);
    assertClass(classId);
    const body = classSchema.partial().parse(request.body ?? {});
    if (body.name !== undefined) {
      db.prepare('UPDATE classes SET name = ? WHERE id = ?').run(body.name, classId);
    }
    if (body.subject !== undefined) {
      db.prepare('UPDATE classes SET subject = ? WHERE id = ?').run(body.subject, classId);
    }
    return listClasses().find((row) => row.id === classId);
  });

  app.delete('/api/classes/:id', async (request, reply) => {
    const classId = Number((request.params as { id: string }).id);
    assertClass(classId);
    const linked = db
      .prepare('SELECT COUNT(*) AS total FROM activities WHERE class_id = ?')
      .get(classId) as { total: number };
    if (linked.total > 0) {
      throw conflict('La clase tiene actividades asociadas. Reasígnalas o bórralas primero.');
    }
    db.prepare('DELETE FROM classes WHERE id = ?').run(classId);
    reply.code(204).send();
  });

  app.get('/api/classes/:id/students', async (request) => {
    const classId = Number((request.params as { id: string }).id);
    assertClass(classId);
    return listStudents(classId);
  });

  app.post('/api/classes/:id/students', async (request, reply) => {
    const classId = Number((request.params as { id: string }).id);
    assertClass(classId);
    const body = studentSchema.parse(request.body ?? {});
    const next = db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM students WHERE class_id = ?')
      .get(classId) as { next: number };
    const result = db
      .prepare('INSERT INTO students (class_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)')
      .run(classId, body.name, next.next, nowIso());
    reply.code(201);
    return { id: Number(result.lastInsertRowid), classId, name: body.name, sortOrder: next.next };
  });

  app.post('/api/classes/:id/students/import', async (request) => {
    const classId = Number((request.params as { id: string }).id);
    assertClass(classId);
    const body = importSchema.parse(request.body ?? {});
    const names = parseNameLines(body.text);
    if (names.length === 0) throw badRequest('No se ha detectado ningún nombre en el texto');

    const next = db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS max FROM students WHERE class_id = ?')
      .get(classId) as { max: number };
    let order = next.max;
    const insert = db.prepare(
      'INSERT INTO students (class_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)',
    );
    db.transaction(() => {
      for (const name of names) {
        order += 1;
        insert.run(classId, name, order, nowIso());
      }
    })();

    return { imported: names.length, students: listStudents(classId) };
  });

  app.patch('/api/students/:id', async (request) => {
    const studentId = Number((request.params as { id: string }).id);
    const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId) as
      | { id: number; class_id: number }
      | undefined;
    if (!existing) throw notFound('Alumno no encontrado');
    const body = studentSchema.parse(request.body ?? {});
    db.prepare('UPDATE students SET name = ? WHERE id = ?').run(body.name, studentId);
    return { id: studentId, classId: existing.class_id, name: body.name };
  });

  app.delete('/api/students/:id', async (request, reply) => {
    const studentId = Number((request.params as { id: string }).id);
    const existing = db.prepare('SELECT id FROM students WHERE id = ?').get(studentId);
    if (!existing) throw notFound('Alumno no encontrado');
    db.prepare('DELETE FROM students WHERE id = ?').run(studentId);
    reply.code(204).send();
  });
}
