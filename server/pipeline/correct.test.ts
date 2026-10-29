import { describe, expect, it, vi, beforeEach } from 'vitest';
import { defaultConfig } from '../../shared/omr';

const calls: { sql: string; args: unknown[] }[] = [];
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  all: vi.fn(),
  run: vi.fn(),
  read: vi.fn(),
  evaluate: vi.fn(),
  emit: vi.fn(),
  confirmed: vi.fn(),
  rubric: vi.fn(),
  settings: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    prepare: (sql: string) => ({
      get: async (...args: unknown[]) => {
        calls.push({ sql, args });
        return mocks.get(sql);
      },
      all: async (...args: unknown[]) => {
        calls.push({ sql, args });
        return mocks.all(sql);
      },
      run: async (...args: unknown[]) => {
        calls.push({ sql, args });
        return mocks.run(sql);
      },
    }),
  },
  nowIso: () => '2026-01-01T00:00:00Z',
  getSettings: () => mocks.settings(),
}));
vi.mock('../events', () => ({ emitEvent: mocks.emit }));
vi.mock('../llm/providers', () => ({
  runProviderEvaluation: mocks.evaluate,
  runProviderRead: mocks.read,
  runWithModelFailover: async (_p: unknown, _a: unknown, fn: (p: string, m: string) => Promise<unknown>) => fn('prov', 'model'),
}));
vi.mock('../mappers', () => ({ listRubric: mocks.rubric }));
vi.mock('../routes/omr', () => ({ confirmedOmrAnswers: mocks.confirmed }));

const { correctSubmission } = await import('./correct');

const KEY = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [String(i + 1), 'A']));
const CONFIG = { ...defaultConfig, key: KEY, keyConfirmed: true };
const ANSWERS = Array.from({ length: 50 }, (_, i) => ({
  question: i + 1,
  answer: i === 1 ? 'B' : i === 2 ? null : 'A',
}));

function route(sql: string): unknown {
  if (sql.includes('FROM submissions WHERE id')) return { id: 5, activity_id: 3, student_id: 9, status: 'uploaded' };
  if (sql.includes('FROM activities WHERE id')) return { id: 3, subject: 'biologia' };
  if (sql.includes('INSERT INTO evaluations')) return { id: 77 };
  if (sql.includes('FROM grades WHERE submission_id')) return undefined;
  return undefined;
}

describe('corrección determinista de entregas OMR', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    mocks.get.mockImplementation(route);
    mocks.all.mockResolvedValue([]);
    mocks.run.mockResolvedValue(undefined);
    mocks.settings.mockResolvedValue({
      primary: { provider: 'prov', model: 'model-a' },
      independent: [],
      maxPagesPerEvaluation: 5,
      includeImages: false,
      divergenceThreshold: 1,
    });
    mocks.rubric.mockResolvedValue([
      { id: 11, title: 'Bloque 1', description: '', maxPoints: 30 },
      { id: 12, title: 'Bloque 2', description: '', maxPoints: 20 },
    ]);
    mocks.confirmed.mockResolvedValue({ answers: ANSWERS, config: CONFIG });
    mocks.read.mockResolvedValue({
      text: JSON.stringify({ reading: '48 correctas, 1 error, 1 en blanco', overallComment: 'Buen resultado', questionComments: [{ question: 2, comment: 'La correcta era A' }] }),
    });
  });

  it('fija la nota con scoreAnswers, usa un único LLM de comentarios y nunca llama a evaluaciones con puntos', async () => {
    await correctSubmission(5);

    // La nota de grades es la determinista: 48 aciertos, 1 error (-0.33), 1 blanco → 47.67
    const gradesInsert = calls.find((c) => c.sql.includes('INSERT INTO grades'));
    expect(gradesInsert?.args[1]).toBe(47.67);
    // Rúbrica 30+20 (suma 50 = escala): reparto proporcional con redondeo a 0.1
    // y el último apartado absorbiendo el drift.
    const itemInserts = calls.filter((c) => c.sql.includes('INSERT INTO grade_items'));
    expect(itemInserts).toHaveLength(2);
    expect(itemInserts[0]?.args[1]).toBe(11);
    expect(itemInserts[0]?.args[2]).toBe(28.6);
    expect(itemInserts[1]?.args[1]).toBe(12);
    expect(itemInserts[1]?.args[2]).toBe(19.1);
    // Un único LLM, sin imágenes y con la lista OMR + clave como contexto de texto.
    expect(mocks.read).toHaveBeenCalledTimes(1);
    const readInput = mocks.read.mock.calls[0][2];
    expect(readInput.images).toEqual([]);
    expect(readInput.context).toContain('"question":2');
    expect(readInput.instructions).toContain('NO asignes puntos');
    // La evaluación guarda la nota determinista como total, no puntos del LLM.
    const evaluationUpdate = calls.find((c) => c.sql.includes("UPDATE evaluations SET status = 'done'"));
    expect(evaluationUpdate?.args[2]).toBe(47.67);
    // Nunca se invoca la evaluación por rúbrica con puntos.
    expect(mocks.evaluate).not.toHaveBeenCalled();
    // La entrega queda revisada.
    const reviewUpdate = calls.find((c) => c.sql.includes("UPDATE submissions SET status = $1, error = NULL"));
    expect(reviewUpdate?.args[0]).toBe('reviewed');
  });
});
