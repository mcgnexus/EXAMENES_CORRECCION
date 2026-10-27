import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings } from '../shared/types';

export const ROOT = process.cwd();
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const DB_PATH = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT 'biologia',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT 'biologia',
        class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rubric_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        ord INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        max_points REAL NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS activity_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        text TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_type TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        original_name TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        mime TEXT NOT NULL,
        kind TEXT NOT NULL,
        page_no INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'uploaded',
        error TEXT,
        reading TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(activity_id, student_id)
      );

      CREATE TABLE IF NOT EXISTS evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        reading TEXT,
        overall_comment TEXT,
        total_points REAL,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluation_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        evaluation_id INTEGER NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
        rubric_item_id INTEGER NOT NULL REFERENCES rubric_items(id) ON DELETE CASCADE,
        points REAL NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        confidence REAL
      );

      CREATE TABLE IF NOT EXISTS grades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
        total REAL NOT NULL DEFAULT 0,
        overall_comment TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        approved_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS grade_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        rubric_item_id INTEGER NOT NULL REFERENCES rubric_items(id) ON DELETE CASCADE,
        points REAL NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'proposal',
        UNIQUE(submission_id, rubric_item_id)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        payload TEXT NOT NULL,
        total INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

db.exec(`CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);

for (const migration of MIGRATIONS) {
  const applied = db.prepare('SELECT id FROM migrations WHERE id = ?').get(migration.id);
  if (!applied) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(
      migration.id,
      new Date().toISOString(),
    );
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  primary: { provider: 'simulado', model: 'simulado-v1' },
  independent: [
    { provider: 'simulado', model: 'simulado-v2' },
    { provider: 'simulado', model: 'simulado-v3' },
  ],
  divergenceThreshold: 1,
  concurrency: 3,
  includeImages: true,
  maxPagesPerEvaluation: 6,
};

export function getSettings(): AppSettings {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app') as
    | { value: string }
    | undefined;
  if (!row) return { ...DEFAULT_SETTINGS, independent: [...DEFAULT_SETTINGS.independent] };
  try {
    const parsed = JSON.parse(row.value) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      primary: parsed.primary ?? DEFAULT_SETTINGS.primary,
      independent: parsed.independent ?? DEFAULT_SETTINGS.independent,
    };
  } catch {
    return { ...DEFAULT_SETTINGS, independent: [...DEFAULT_SETTINGS.independent] };
  }
}

export function saveSettings(settings: AppSettings): AppSettings {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('app', JSON.stringify(settings));
  return settings;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function recoverInterruptedWork(): void {
  const stamp = nowIso();
  db.prepare(
    "UPDATE jobs SET status = 'error', error = ?, updated_at = ? WHERE status IN ('queued','running')",
  ).run('Interrumpido al reiniciar la aplicación', stamp);
  db.prepare(
    "UPDATE submissions SET status = 'error', error = ? WHERE status IN ('queued','running')",
  ).run('Interrumpido al reiniciar la aplicación');
  db.prepare(
    "UPDATE evaluations SET status = 'error', error = ? WHERE status IN ('pending','running')",
  ).run('Interrumpido al reiniciar la aplicación');
}
