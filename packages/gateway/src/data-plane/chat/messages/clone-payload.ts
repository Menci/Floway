import type { MessagesPayload } from '@floway-dev/protocols/messages';

// Messages payloads are JSON-shaped trees. Candidate and provider transforms
// need private containers, while immutable primitive leaves can stay shared
// without creating a mutation channel between attempts.
const cloneContainerTree = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(cloneContainerTree) as T;
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(source)) cloned[key] = cloneContainerTree(source[key]);
  return cloned as T;
};

export const cloneMessagesPayload = (payload: MessagesPayload): MessagesPayload => cloneContainerTree(payload);
