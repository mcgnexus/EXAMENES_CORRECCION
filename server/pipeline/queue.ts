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

export async function getJob(jobId: number): Promise<JobRow | null> {
  const row = await db.prepare('SELECT * FROM jobs WHERE id = $1').get<JobDbRow>(jobId);
  return row ? mapJob(row) : null;
}

export async function listJobs(limit = 20): Promise<JobRow[]> {
  const rows = await db
    .prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT $1')
    .all<JobDbRow>(limit);
  return rows.map(mapJob);
}

async function updateJob(
  jobId: number,
  patch: Partial<Pick<JobRow, 'status' | 'done' | 'error'>>,
  broadcast = true,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    values.push(patch.status);
    sets.push(`status = $${values.length}`);
  }
  if (patch.done !== undefined) {
    values.push(patch.done);
    sets.push(`done = $${values.length}`);
  }
  if (patch.error !== undefined) {
    values.push(patch.error);
    sets.push(`error = $${values.length}`);
  }
  values.push(nowIso());
  sets.push(`updated_at = $${values.length}`);
  values.push(jobId);
  const where = `$${values.length}`;
  await db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ${where}`).run(...values);

  if (broadcast) {
    const job = await getJob(jobId);
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
  const created = await db
    .prepare(
      `INSERT INTO jobs (kind, status, payload, total, done, created_at, updated_at)
       VALUES ('correct', 'queued', $1, $2, 0, $3, $4) RETURNING id`,
    )
    .get<{ id: number }>(JSON.stringify({ submissionIds }), submissionIds.length, nowIso(), nowIso());

  const markQueued = db.prepare(
    "UPDATE submissions SET status = 'queued', error = NULL WHERE id = $1",
  );
  for (const id of submissionIds) await markQueued.run(id);

  void runJob(created?.id ?? 0, submissionIds);
  return (await getJob(created?.id ?? 0)) as JobRow;
}

async function runJob(jobId: number, submissionIds: number[]): Promise<void> {
  await updateJob(jobId, { status: 'running' });
  const settings = await getSettings();
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
      await updateJob(jobId, { done });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const allFailed = failures > 0 && failures === submissionIds.length;
  await updateJob(jobId, {
    status: allFailed ? 'error' : 'done',
    error: errors.length ? errors.join('\n').slice(0, 4000) : undefined,
  });
}
