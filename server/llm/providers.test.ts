import { describe, expect, it } from 'vitest';
import { runProviderEvaluation } from './providers';
import type { GradingInput } from './types';

function input(seed: number): GradingInput {
  return {
    subject: 'bioquimica',
    activityTitle: 'Examen de metabolismo',
    activityDescription: '',
    rubric: [
      { id: 1, title: 'Glucólisis', description: 'Describe las etapas', maxPoints: 2.5 },
      { id: 2, title: 'Ciclo de Krebs', description: 'Balance energético', maxPoints: 2.5 },
    ],
    documentText: '',
    solutionText: '',
    images: [],
    seed,
  };
}

describe('proveedor simulado', () => {
  it('es determinista para la misma entrada y modelo', async () => {
    const first = await runProviderEvaluation('simulado', 'simulado-v1', input(7));
    const second = await runProviderEvaluation('simulado', 'simulado-v1', input(7));
    expect(second).toEqual(first);
  });

  it('produce puntuaciones distintas por modelo y respeta los máximos', async () => {
    const base = await runProviderEvaluation('simulado', 'simulado-v1', input(7));
    const other = await runProviderEvaluation('simulado', 'simulado-v3', input(7));
    expect(other.items.map((item) => item.points)).not.toEqual(
      base.items.map((item) => item.points),
    );
    for (const output of [base, other]) {
      expect(output.items).toHaveLength(2);
      for (const item of output.items) {
        expect(item.points).toBeGreaterThanOrEqual(0);
        expect(item.points).toBeLessThanOrEqual(2.5);
        expect(item.comment.length).toBeGreaterThan(0);
      }
      expect(output.reading.length).toBeGreaterThan(0);
    }
  });
});
