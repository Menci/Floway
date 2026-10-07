export class JsoncRefusalError extends Error {
  constructor(message: string);
}

export function tokenizeJsonc(src: string): unknown[];
export function parseJsoncAst(src: string): unknown;
export function upsertFlowayProvider(src: string, providerInput: string | Record<string, unknown>): string;
export function updateDefaultModel(src: string, modelId: string | null): string;
