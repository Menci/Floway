import type { Fields } from './facts.ts';
import type { Narrowing } from '../pipeline/resolve-candidates.ts';

/** A candidate that cannot serve *this* request is not a candidate. Saying why is what
 *  turns an empty list into a 400 a client can act on. */
export const narrowing: Narrowing<Fields<'response.openaiEmbeddings.canonical'>> = {
  kind: 'embedding',
  reject: candidate => candidate.model.endpoints.openaiEmbeddings === undefined
    ? 'the upstream does not expose an OpenAI Embeddings endpoint'
    : null,
  unsupported: model => `Model ${model} does not support the /embeddings endpoint.`,
  refuse: (status, message) => ({ 'response.openaiEmbeddings.canonical': { status, message } }),
  refuses: ['response.openaiEmbeddings.canonical'],
};
