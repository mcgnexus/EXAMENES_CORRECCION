import fs from 'node:fs';
import path from 'node:path';
import { Pool, types, type ClientBase, type PoolClient, type QueryResult } from 'pg';
import type { AppSettings } from '../shared/types';

export const ROOT = process.cwd();

// Carga .env (DATABASE_URL, claves, PORT…) si aún no está en el entorno.
const ENV_FILE = path.join(ROOT, '.env');
if (fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    /* entorno ya cargado o fichero ilegible */
  }
}

export const DATA_DIR = path.resolve(
  process.env.DATA_DIR ??
    (process.env.VERCEL ? path.join('/tmp', 'examenes-correccion') : path.join(ROOT, 'data')),
);
export const FILES_DIR = path.join(DATA_DIR, 'files');

// En Vercel solo /tmp es escribible. Es una ubicación efímera; producción debe
// configurar almacenamiento de objetos antes de aceptar archivos.
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

// int8 (ids, conteos) llega como string por defecto: lo pasamos a number.
// float4/float8 ya se convierten a number; los puntos usan double precision.
types.setTypeParser(20, (value) => Number(value));

/**
 * Esquema dedicado para tests (aceptación). Si PG_SCHEMA está definido, todas
 * las consultas se ejecutan con `SET LOCAL search_path` dentro de su propia
 * transacción: aísla los datos del test sin afectar al esquema principal y es
 * seguro con el pooler transaccional de Neon.
 */
const SCHEMA = process.env.PG_SCHEMA?.trim() || null;
if (SCHEMA && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(SCHEMA)) {
  throw new Error(`PG_SCHEMA inválido: ${SCHEMA}`);
}
const searchPathSql = SCHEMA ? `SET LOCAL search_path TO "${SCHEMA}", public` : null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  // Neon exige TLS; sslmode de la URL + verificación del certificado.
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: true },
});
pool.on('error', (error) => {
  console.error('Error en la conexión PostgreSQL:', error.message);
});

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS classes (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT 'biologia',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS students (
        id BIGSERIAL PRIMARY KEY,
        class_id BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activities (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT 'biologia',
        class_id BIGINT REFERENCES classes(id) ON DELETE SET NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rubric_items (
        id BIGSERIAL PRIMARY KEY,
        activity_id BIGINT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        ord INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        max_points DOUBLE PRECISION NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS activity_documents (
        id BIGSERIAL PRIMARY KEY,
        activity_id BIGINT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        text TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        id BIGSERIAL PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id BIGINT NOT NULL,
        original_name TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        mime TEXT NOT NULL,
        kind TEXT NOT NULL,
        page_no INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS submissions (
        id BIGSERIAL PRIMARY KEY,
        activity_id BIGINT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'uploaded',
        error TEXT,
        reading TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(activity_id, student_id)
      );

      CREATE TABLE IF NOT EXISTS evaluations (
        id BIGSERIAL PRIMARY KEY,
        submission_id BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        reading TEXT,
        overall_comment TEXT,
        total_points DOUBLE PRECISION,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluation_scores (
        id BIGSERIAL PRIMARY KEY,
        evaluation_id BIGINT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
        rubric_item_id BIGINT NOT NULL REFERENCES rubric_items(id) ON DELETE CASCADE,
        points DOUBLE PRECISION NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        confidence DOUBLE PRECISION
      );

      CREATE TABLE IF NOT EXISTS grades (
        id BIGSERIAL PRIMARY KEY,
        submission_id BIGINT NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
        total DOUBLE PRECISION NOT NULL DEFAULT 0,
        overall_comment TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        approved_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS grade_items (
        id BIGSERIAL PRIMARY KEY,
        submission_id BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        rubric_item_id BIGINT NOT NULL REFERENCES rubric_items(id) ON DELETE CASCADE,
        points DOUBLE PRECISION NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'proposal',
        UNIQUE(submission_id, rubric_item_id)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id BIGSERIAL PRIMARY KEY,
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
  {id:'002_omr_config',sql:`CREATE TABLE IF NOT EXISTS activity_omr_config (
    activity_id BIGINT PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE,
    config JSONB NOT NULL,
    updated_at TEXT NOT NULL
  );`},
  {id:'003_omr_answers',sql:`CREATE TABLE IF NOT EXISTS submission_omr_answers (
    submission_id BIGINT PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
    answers JSONB NOT NULL,
    config JSONB NOT NULL,
    confirmed_at TEXT NOT NULL
  );`},
  {id:'004_omr_overrides',sql:`ALTER TABLE submission_omr_answers ADD COLUMN IF NOT EXISTS overrides JSONB NOT NULL DEFAULT '{}'::jsonb;`},
  {id:'004_omr_overrides',sql:`ALTER TABLE submission_omr_answers ADD COLUMN IF NOT EXISTS overrides JSONB NOT NULL DEFAULT '{}'::jsonb;`},
];

type Runner = (sql: string, params: unknown[]) => Promise<QueryResult>;

export interface Statement {
  all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined>;
  run(...params: unknown[]): Promise<{ changes: number; rows: Record<string, unknown>[] }>;
}

function makeStatement(runner: Runner, sql: string): Statement {
  return {
    async all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]> {
      const result = await runner(sql, params);
      return result.rows as T[];
    },
    async get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined> {
      const result = await runner(sql, params);
      return result.rows[0] as T | undefined;
    },
    async run(...params: unknown[]): Promise<{ changes: number; rows: Record<string, unknown>[] }> {
      const result = await runner(sql, params);
      return { changes: result.rowCount ?? 0, rows: result.rows };
    },
  };
}

async function withClient<T>(client: ClientBase, fn: () => Promise<T>): Promise<T> {
  if (!searchPathSql) return fn();
  await client.query('BEGIN');
  try {
    await client.query(searchPathSql);
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function poolRunner(sql: string, params: unknown[]): Promise<QueryResult> {
  await ensureReady();
  if (!searchPathSql) return pool.query(sql, params);
  const client = await pool.connect();
  try {
    return await withClient(client, () => client.query(sql, params));
  } finally {
    client.release();
  }
}

export interface Db {
  prepare(sql: string): Statement;
  transaction<T>(fn: (tx: Pick<Db, 'prepare'>) => Promise<T>): Promise<T>;
}

export const db: Db = {
  prepare(sql: string): Statement {
    return makeStatement(poolRunner, sql);
  },
  async transaction<T>(fn: (tx: Pick<Db, 'prepare'>) => Promise<T>): Promise<T> {
    await ensureReady();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (searchPathSql) await client.query(searchPathSql);
      const tx: Pick<Db, 'prepare'> = {
        prepare: (sql: string) => makeStatement((text, params) => client.query(text, params), sql),
      };
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
};

let initPromise: Promise<void> | null = null;
let ready = false;

async function runMigrations(client: PoolClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
  );
  const applied = await client.query<{ id: string }>('SELECT id FROM migrations');
  const done = new Set(applied.rows.map((row) => row.id));
  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue;
    await client.query(migration.sql);
    await client.query('INSERT INTO migrations (id, applied_at) VALUES ($1, $2)', [
      migration.id,
      new Date().toISOString(),
    ]);
  }
}

async function ensureReady(): Promise<void> {
  if (ready) return;
  if (!initPromise) {
    initPromise = (async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error(
          'Falta DATABASE_URL. Copia .env.example a .env y define la URL de PostgreSQL.',
        );
      }
      if (SCHEMA) await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
      const client = await pool.connect();
      try {
        await withClient(client, () => runMigrations(client));
      } finally {
        client.release();
      }
      ready = true;
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

export const DEFAULT_SETTINGS: AppSettings = {
  primary: { provider: 'simulado', model: 'simulado-v1' },
  independent: [
    { provider: 'simulado', model: 'simulado-v2' },
  ],
  divergenceThreshold: 1,
  concurrency: 3,
  includeImages: true,
  maxPagesPerEvaluation: 6,
};

export async function getSettings(): Promise<AppSettings> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = $1')
    .get<{ value: string }>('app');
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

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  await db
    .prepare(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
    )
    .run('app', JSON.stringify(settings));
  return settings;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function recoverInterruptedWork(): Promise<void> {
  const stamp = nowIso();
  await db
    .prepare(
      "UPDATE jobs SET status = 'error', error = $1, updated_at = $2 WHERE status IN ('queued','running')",
    )
    .run('Interrumpido al reiniciar la aplicación', stamp);
  await db
    .prepare(
      "UPDATE submissions SET status = 'error', error = $1 WHERE status IN ('queued','running')",
    )
    .run('Interrumpido al reiniciar la aplicación');
  await db
    .prepare(
      "UPDATE evaluations SET status = 'error', error = $1 WHERE status IN ('pending','running')",
    )
    .run('Interrumpido al reiniciar la aplicación');
}

/** Elimina el esquema dedicado de tests (no-op si PG_SCHEMA no está definido). */
export async function dropSchema(): Promise<void> {
  if (!SCHEMA) return;
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
}

let ended = false;

/** Cierra el pool. Idempotente: seguro llamarlo varias veces. */
export async function closeDb(): Promise<void> {
  if (ended) return;
  ended = true;
  await pool.end().catch(() => undefined);
}
