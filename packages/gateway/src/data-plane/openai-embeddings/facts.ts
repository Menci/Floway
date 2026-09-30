import type { GatewayFacts, Failure } from '../pipeline/facts.ts';
import type { OpenAIEmbeddingsEncodingFormat, CanonicalOpenAIEmbeddingsRequest, CanonicalOpenAIEmbeddingsResponse } from '@floway-dev/protocols/openai-embeddings';

/** OpenAI Embeddings' own keys. They extend the shared space and never merge into it, so a stage
 *  written against the gateway alone cannot name one. */
export interface OpenAIEmbeddingsFacts extends GatewayFacts {
  /** Which encoding the client is able to read. It belongs to the ingress and stays put:
   *  the answer is written in it whichever encoding the upstream chose to answer in, and
   *  the two differ whenever an upstream ignores the field. */
  'ingress.openaiEmbeddings.encodingFormat': OpenAIEmbeddingsEncodingFormat;
  'request.openaiEmbeddings.canonical': CanonicalOpenAIEmbeddingsRequest;
  'response.openaiEmbeddings.canonical': CanonicalOpenAIEmbeddingsResponse | Failure;
  /** What the client is actually sent. The edge provides it, so a dump shows the bytes the
   *  client received rather than the gateway's canonical form. */
  'response.openaiEmbeddings.rendered': Record<string, unknown>;
}

export type Fields<K extends keyof OpenAIEmbeddingsFacts> = { [P in K]: OpenAIEmbeddingsFacts[P] };
