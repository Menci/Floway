// OpenAI's `/v1/embeddings` contract, and the canonical form the gateway holds it in.
// Specification: https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L34214-L34331
//
// There is one embeddings protocol, so the canonical form and the wire differ in one
// substantive place: `encoding_format` decides how a vector is *written*, and a vector is
// the same vector either way — so the canonical response holds numbers, and the encoding
// is a rendering decision the edge makes from what the client asked for.
//
// That divergence is load-bearing rather than tidy. Both official OpenAI SDKs send
// `encoding_format: base64` when the caller did not choose one, so base64 is the common
// case on the wire and not an exotic one:
// https://github.com/openai/openai-python/blob/10ee3f0da2ac6f93345c1204bd7bb1a2faa79ff2/src/openai/resources/embeddings.py#L111-L112
// https://github.com/openai/openai-node/blob/cc7dbfa9b9dd6fe0ff72141e9c0c3d82b18ba9aa/src/resources/embeddings.ts#L36-L42
// An upstream that ignores the field and answers with float arrays hands such a client a
// body it will decode as base64 and turn into noise. Parsing whatever arrived and
// rendering what the client asked for is what closes that.

/** How a vector is written on the wire. Under `base64` an embedding is one string, not an
 *  array of numbers.
 *  https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L34272-L34280 */
export type EmbeddingsEncodingFormat = 'float' | 'base64';

/** One text, a batch of texts, one pre-tokenized text, or a batch of those — the
 *  specification's own four-armed `oneOf`:
 *  https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L34218-L34254
 *
 *  The arms are told apart by reading an element, which works only because every array arm
 *  is `minItems: 1` there — an empty array would belong to three of them at once. Parsing
 *  rejects it, so a value of this type is always unambiguous. */
export type EmbeddingsInput = string | readonly string[] | readonly number[] | readonly (readonly number[])[];

export interface CanonicalEmbeddingsRequest {
  input: EmbeddingsInput;
  /** What the upstream is asked for, absent included — a client that did not ask must not
   *  grow a field on the wire it never sent. */
  encodingFormat?: EmbeddingsEncodingFormat;
  /** Only `text-embedding-3` and later models honour it
   *  (https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L34281-L34286),
   *  and which models those are is the upstream's knowledge and not the catalog's — so it
   *  travels to whichever upstream is chosen and that upstream answers for it. */
  dimensions?: number;
  /** https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L34287-L34293 */
  user?: string;
}

export interface ParsedEmbeddingsRequest {
  model: string;
  /** What the client will be able to read: `encoding_format` resolved against the
   *  protocol's own default of `float`
   *  (https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L34276).
   *  Concrete, because the answer has to be written in one encoding or the other — and
   *  distinct from the request's own field, which stays absent when the client omitted it. */
  encodingFormat: EmbeddingsEncodingFormat;
  request: CanonicalEmbeddingsRequest;
}

export interface CanonicalEmbedding {
  /** Which input this vector answers, carried by the specification as a field rather than
   *  left to array position:
   *  https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L38168-L38170 */
  index: number;
  values: readonly number[];
}

export interface CanonicalEmbeddingsUsage {
  promptTokens: number;
  totalTokens: number;
}

export interface CanonicalEmbeddingsResponse {
  /** What the upstream says it generated with, which need not be the id the client
   *  addressed — an upstream is free to answer under a dated or internal name. */
  model: string;
  embeddings: readonly CanonicalEmbedding[];
  /** The specification requires it
   *  (https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L34327-L34331)
   *  and it is optional here regardless, because an upstream that reports nothing is a
   *  situation the gateway has to be able to state: the billed entity is then present with
   *  no quantities, which is a different fact from reporting zero. Rejecting the body
   *  instead would turn an answered call into a 502 and throw away the vectors it
   *  returned. */
  usage?: CanonicalEmbeddingsUsage;
}

/** The request as it goes out. `model` is the upstream's own id and the provider
 *  substitutes it, so what the gateway hands a provider is everything but that. */
export interface EmbeddingsPayload {
  model: string;
  input: EmbeddingsInput;
  encoding_format?: EmbeddingsEncodingFormat;
  dimensions?: number;
  user?: string;
}

export {
  parseEmbeddingsRequest,
  parseEmbeddingsResponse,
  renderEmbeddingsResponse,
  serializeEmbeddingsRequest,
} from './translate.ts';
