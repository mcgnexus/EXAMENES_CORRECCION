import type { RubricItem, ScanResult, Subject } from '../../shared/types';

export interface ImagePart {
  label: string;
  mime: string;
  base64: string;
}

export interface ScanInput {
  esperado: 'auto' | 'examen' | 'lista';
  images: ImagePart[];
  /** Texto adicional (enunciado, solución o rúbrica) para proponer apartados. */
  contexto?: string;
}

export interface ReadInput {
  subject: Subject;
  images: ImagePart[];
  /** Server-owned task instructions for structured answer-key extraction. */
  instructions?: string;
  context?: string;
}

export interface ReadOutput {
  text: string;
}

export interface SolveInput {
  subject: Subject;
  enunciado: string;
  images: ImagePart[];
  apartados: { title: string; maxPoints: number }[];
}

export interface SolveOutput {
  respuestas: string;
}

export interface GradingInput {
  subject: Subject;
  activityTitle: string;
  activityDescription: string;
  rubric: Pick<RubricItem, 'id' | 'title' | 'description' | 'maxPoints'>[];
  documentText: string;
  solutionText: string;
  images: ImagePart[];
  seed: number;
  /** Exclusive student answer source in bubble-sheet mode. Never attach student images. */
  detectedAnswers?: {question:number;answer:string|null}[];
}

export interface GradingItemOutput {
  itemId: number;
  points: number;
  comment: string;
  confidence: number | null;
}

export interface GradingOutput {
  reading: string;
  overallComment: string;
  items: GradingItemOutput[];
}

export interface ProviderCallContext {
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}

export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'simulado';

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  requiresKey: boolean;
  keyVariable: string | null;
  defaultModel: string;
  evaluate(input: GradingInput, ctx: ProviderCallContext): Promise<GradingOutput>;
  scan(input: ScanInput, ctx: ProviderCallContext): Promise<ScanResult>;
  read(input: ReadInput, ctx: ProviderCallContext): Promise<ReadOutput>;
  solve(input: SolveInput, ctx: ProviderCallContext): Promise<SolveOutput>;
  ping(ctx: ProviderCallContext): Promise<string>;
}
