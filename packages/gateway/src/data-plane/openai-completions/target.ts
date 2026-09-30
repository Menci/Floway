import type { Fields } from './facts.ts';
import type { ModelCandidate } from '@floway-dev/provider';

/** A candidate that cannot serve this endpoint is not a candidate. The resolver's own filter
 *  is by kind, and a text-completion model is a chat-kind model, so what is left to say is
 *  whether the upstream exposes the endpoint at all. */
export const narrowing = {
  kind: 'chat' as const,
  reject: (candidate: ModelCandidate): string | null =>
    candidate.model.endpoints.openaiCompletions === undefined ? 'the upstream does not expose an OpenAI Completions endpoint' : null,
  unsupported: (model: string) => `Model ${model} does not support the /completions endpoint.`,
  refuse: (status: number, message: string): Fields<'response.openaiCompletions.payload' | 'response.openaiCompletions.streamedUsage'> => ({
    'response.openaiCompletions.payload': { status, message },
    'response.openaiCompletions.streamedUsage': null,
  }),
  refuses: ['response.openaiCompletions.payload', 'response.openaiCompletions.streamedUsage'] as const,
};
