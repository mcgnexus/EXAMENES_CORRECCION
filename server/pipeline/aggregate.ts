import type { RubricItem } from '../../shared/types';

export interface ScoreLike {
  rubricItemId: number;
  points: number;
  comment: string;
}

export interface EvaluationLike {
  role: 'primary' | 'independent';
  status: string;
  overallComment: string | null;
  items: ScoreLike[];
}

export interface ProposedItem {
  rubricItemId: number;
  points: number;
  comment: string;
  source: 'proposal';
  divergent: boolean;
}

export interface ProposedGrade {
  items: ProposedItem[];
  total: number;
  overallComment: string;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Umbral efectivo: el configurado, pero nunca más del 20% del máximo del apartado. */
export function effectiveThreshold(configured: number, maxPoints: number): number {
  return Math.min(configured, Math.max(0.2, maxPoints * 0.2));
}

export function isDivergent(points: number[], configured: number, maxPoints: number): boolean {
  if (points.length < 2) return false;
  const spread = Math.max(...points) - Math.min(...points);
  return spread > effectiveThreshold(configured, maxPoints) + 1e-9;
}

export function proposeGrade(
  rubric: Pick<RubricItem, 'id' | 'maxPoints'>[],
  evaluations: EvaluationLike[],
  threshold: number,
): ProposedGrade {
  const usable = evaluations.filter((evaluation) => evaluation.status === 'done');
  const primary = usable.find((evaluation) => evaluation.role === 'primary') ?? null;

  const items: ProposedItem[] = rubric.map((rubricItem) => {
    const scores = usable
      .map((evaluation) =>
        evaluation.items.find((item) => item.rubricItemId === rubricItem.id),
      )
      .filter((score): score is ScoreLike => Boolean(score));

    const points = scores.length
      ? round1(Math.min(rubricItem.maxPoints, Math.max(0, median(scores.map((s) => s.points)))))
      : 0;

    const primaryScore = primary?.items.find((item) => item.rubricItemId === rubricItem.id);
    const fallback = [...scores].sort((a, b) => b.comment.length - a.comment.length)[0];
    const comment = (primaryScore?.comment || fallback?.comment || '').trim();

    return {
      rubricItemId: rubricItem.id,
      points,
      comment,
      source: 'proposal' as const,
      divergent: isDivergent(scores.map((s) => s.points), threshold, rubricItem.maxPoints),
    };
  });

  return {
    items,
    total: round1(items.reduce((sum, item) => sum + item.points, 0)),
    overallComment: (primary?.overallComment ?? '').trim(),
  };
}
