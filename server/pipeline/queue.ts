import type { JobRow } from '../../shared/types';
import { db, getSettings, nowIso } from '../db';
import { emitEvent } from '../events';
import { correctSubmission } from './correct';

interface JobDbRow {
  id: number;
  kind: string;
  status: 'queued' | 'running' | 'done' | 'error';
  payload: string;
  total: number;
  done: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function mapJob(row: JobDbRow): JobRow {
  let submissionIds: number[] = [];
  try {
    submissionIds = (JSON.parse(row.payload) as { submissionIds?: number[] }).submissionIds ?? [];
  } catch {
    submissionIds = [];
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    total: row.total,
    done: row.done,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submissionIds,
  };
}

export function getJob(jobId: number): JobRow | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobDbRow | undefined;
  return row ? mapJob(row) : null;
}

export function listJobs(limit = 20): JobRow[] {
  const rows = db
    .prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?')
    .all(limit) as JobDbRow[];
  return rows.map(mapJob);
}

function updateJob(
  jobId: number,
  patch: Partial<Pick<JobRow, 'status' | 'done' | 'error'>>,
  broadcast = true,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.done !== undefined) {
    sets.push('done = ?');
    values.push(patch.done);
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    values.push(patch.error);
  }
  sets.push('updated_at = ?');
  values.push(nowIso());
  values.push(jobId);
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  if (broadcast) {
    const job = getJob(jobId);
    if (job) {
      emitEvent({
        type: 'job',
        jobId: job.id,
        status: job.status,
        done: job.done,
        total: job.total,
      });
    }
  }
}

export async function startCorrectJob(submissionIds: number[]): Promise<JobRow> {
  const created = db
    .prepare(
      `INSERT INTO jobs (kind, status, payload, total, done, created_at, updated_at)
       VALUES ('correct', 'queued', ?, ?, 0, ?, ?)`,
    )
    .run(JSON.stringify({ submissionIds }), submissionIds.length, nowIso(), nowIso());
  const jobId = Number(created.lastInsertRowid);

  const markQueued = db.prepare("UPDATE submissions SET status = 'queued', error = NULL WHERE id = ?");
  for (const id of submissionIds) markQueued.run(id);

  void runJob(jobId, submissionIds);
  return getJob(jobId) as JobRow;
}

async function runJob(jobId: number, submissionIds: number[]): Promise<void> {
  updateJob(jobId, { status: 'running' });
  const settings = getSettings();
  const concurrency = Math.min(Math.max(1, settings.concurrency), submissionIds.length || 1);
  const queue = [...submissionIds];
  let done = 0;
  let failures = 0;
  const errors: string[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      const submissionId = queue.shift();
      if (submissionId === undefined) return;
      try {
        await correctSubmission(submissionId);
      } catch (error) {
        failures += 1;
        errors.push(
          `Entrega #${submissionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      done += 1;
      updateJob(jobId, { done });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const allFailed = failures > 0 && failures === submissionIds.length;
  updateJob(jobId, {
    status: allFailed ? 'error' : 'done',
    error: errors.length ? errors.join('\n').slice(0, 4000) : undefined,
  });
}
