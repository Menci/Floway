import type { CopilotModelsResponse, CopilotRawModel } from './types.ts';

const KNOWN_MODEL_TTL_MS = 24 * 60 * 60 * 1000;

export interface CopilotKnownModelEntry {
  snapshot: CopilotRawModel;
  lastSeenAt: number;
}

export interface CopilotKnownModels {
  fetchedAt: number;
  models: Record<string, CopilotKnownModelEntry>;
}

export const emptyKnownModels = (): CopilotKnownModels => ({ fetchedAt: 0, models: {} });

export const projectKnownModels = (knownModels: CopilotKnownModels, now: number): CopilotRawModel[] =>
  Object.values(knownModels.models)
    .filter(entry => now - entry.lastSeenAt < KNOWN_MODEL_TTL_MS)
    .map(entry => entry.snapshot);

export const mergeKnownModels = (
  prev: CopilotKnownModels,
  response: CopilotModelsResponse,
  now: number,
): CopilotKnownModels => {
  const models: Record<string, CopilotKnownModelEntry> = { ...prev.models };
  for (const raw of response.data) {
    models[raw.id] = { snapshot: raw, lastSeenAt: now };
  }
  for (const [id, entry] of Object.entries(models)) {
    if (now - entry.lastSeenAt >= KNOWN_MODEL_TTL_MS) delete models[id];
  }
  return { fetchedAt: now, models };
};
