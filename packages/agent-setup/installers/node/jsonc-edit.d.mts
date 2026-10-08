export class JsoncRefusalError extends Error {
  constructor(message: string);
}

export function tokenizeJsonc(src: string): unknown[];
export function parseJsoncAst(src: string): unknown;
export function updateDefaultModel(src: string, modelId: string | null, provider: string): string;

export function updatePiSettings(src: string, settings: {
  modelId: string | null;
  provider: string;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  retry: { enabled: boolean | null; maxRetries: number | null };
}): string;
