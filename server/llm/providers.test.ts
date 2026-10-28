import { describe, expect, it } from 'vitest';
import { isTransientProviderError, ProviderHttpError, runProviderEvaluation } from './providers';
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

describe('clasificación de errores de proveedor', () => {
  it('los 503/429/5xx y los timeouts son transitorios', () => {
    expect(isTransientProviderError(new ProviderHttpError(503, 'alta demanda'))).toBe(true);
    expect(isTransientProviderError(new ProviderHttpError(429, 'límite de tasa'))).toBe(true);
    expect(isTransientProviderError(new ProviderHttpError(500, 'error interno'))).toBe(true);
    const timeout = new Error('La operación expiró');
    timeout.name = 'TimeoutError';
    expect(isTransientProviderError(timeout)).toBe(true);
    const abort = new Error('abortada');
    abort.name = 'AbortError';
    expect(isTransientProviderError(abort)).toBe(true);
  });

  it('los errores de cliente y otros no son transitorios', () => {
    expect(isTransientProviderError(new ProviderHttpError(400, 'petición inválida'))).toBe(false);
    expect(isTransientProviderError(new ProviderHttpError(401, 'clave inválida'))).toBe(false);
    expect(isTransientProviderError(new ProviderHttpError(404, 'modelo inexistente'))).toBe(false);
    expect(isTransientProviderError(new Error('error cualquiera'))).toBe(false);
  });
});
