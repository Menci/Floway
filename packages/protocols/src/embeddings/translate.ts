import type {
  CanonicalEmbedding,
  CanonicalEmbeddingsRequest,
  CanonicalEmbeddingsResponse,
  CanonicalEmbeddingsUsage,
  EmbeddingsEncodingFormat,
  EmbeddingsInput,
  EmbeddingsPayload,
  ParsedEmbeddingsRequest,
} from './index.ts';
import { decodeForgivingBase64, encodeBase64 } from '../common/base-encoding.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
};

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
};

const requiredInteger = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  return value;
};

const optionalPositiveInteger = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined;
  const integer = requiredInteger(value, field);
  if (integer < 1) throw new Error(`${field} must be a positive integer`);
  return integer;
};

const parseEncodingFormat = (value: unknown): EmbeddingsEncodingFormat | undefined => {
  if (value === undefined) return undefined;
  if (value !== 'float' && value !== 'base64') throw new Error('encoding_format must be float or base64');
  return value;
};

const parseTokenIds = (value: readonly unknown[], field: string): readonly number[] => {
  if (value.length === 0) throw new Error(`${field} must not be empty`);
  return value.map((token, index) => requiredInteger(token, `${field}[${index}]`));
};

const parseInput = (value: unknown): EmbeddingsInput => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw new Error('input must be a string or an array');
  if (value.length === 0) throw new Error('input must not be empty');
  const head: unknown = value[0];
  if (typeof head === 'string') return value.map((text, index) => requiredString(text, `input[${index}]`));
  if (!Array.isArray(head)) return parseTokenIds(value as readonly unknown[], 'input');
  return value.map((tokens, index) => {
    if (!Array.isArray(tokens)) throw new Error(`input[${index}] must be an array of integers`);
    return parseTokenIds(tokens as readonly unknown[], `input[${index}]`);
  });
};

// The request schema is `additionalProperties: false`
// (https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L34216),
// so the protocol has no extension point and a field outside this set is one the gateway
// cannot carry. Naming it beats dropping it silently and beats guessing what it meant. The
// two gateways compared against draw the same line: LiteLLM's embeddings surface is
// `user` / `encoding_format` / `dimensions`, and anything else raises unless the operator
// opts into dropping —
// https://github.com/BerriAI/litellm/blob/bc6e7df05b018eefe6c7293790ca3f4de38709ac/litellm/utils.py#L3259-L3273
// — while copilot-api's request type is narrower still, `input` and `model` alone:
// https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts#L19-L22
const EMBEDDINGS_REQUEST_FIELDS = ['model', 'input', 'encoding_format', 'dimensions', 'user'];

export const parseEmbeddingsRequest = (value: unknown): ParsedEmbeddingsRequest => {
  if (!isRecord(value)) throw new Error('Embeddings request body must be an object');
  const unsupported = Object.keys(value).filter(field => !EMBEDDINGS_REQUEST_FIELDS.includes(field));
  if (unsupported.length > 0) throw new Error(`Embeddings does not support ${unsupported.join(', ')}`);

  const encodingFormat = parseEncodingFormat(value.encoding_format);
  const dimensions = optionalPositiveInteger(value.dimensions, 'dimensions');
  const user = optionalString(value.user, 'user');
  return {
    model: requiredString(value.model, 'model'),
    encodingFormat: encodingFormat ?? 'float',
    request: {
      input: parseInput(value.input),
      ...(encodingFormat === undefined ? {} : { encodingFormat }),
      ...(dimensions === undefined ? {} : { dimensions }),
      ...(user === undefined ? {} : { user }),
    },
  };
};

export const serializeEmbeddingsRequest = (request: CanonicalEmbeddingsRequest): Omit<EmbeddingsPayload, 'model'> => ({
  input: request.input,
  ...(request.encodingFormat === undefined ? {} : { encoding_format: request.encodingFormat }),
  ...(request.dimensions === undefined ? {} : { dimensions: request.dimensions }),
  ...(request.user === undefined ? {} : { user: request.user }),
});

// A base64 embedding is the vector's float32 elements packed little-endian. Both official
// SDKs establish that by reading the decoded bytes straight into a native float32 view —
// `array.array('f', ...)` and `Float32Array`, each host-endian and each correct only
// because every platform they run on is:
// https://github.com/openai/openai-python/blob/10ee3f0da2ac6f93345c1204bd7bb1a2faa79ff2/src/openai/resources/embeddings.py#L122-L131
// https://github.com/openai/openai-node/blob/cc7dbfa9b9dd6fe0ff72141e9c0c3d82b18ba9aa/src/internal/utils/base64.ts#L45-L52
// `DataView` states the byte order rather than inheriting it.
//
// Holding a vector as numbers is exact and not an approximation: every float32 is a
// float64, so widening loses nothing and narrowing a value that came from a float32 gives
// the same bits back. A vector survives any number of trips through this pair.
const FLOAT32_BYTES = 4;

const parseEmbedding = (value: unknown, field: string): readonly number[] => {
  if (Array.isArray(value)) {
    return value.map((element, index) => {
      if (typeof element !== 'number') throw new Error(`${field}[${index}] must be a number`);
      return element;
    });
  }
  if (typeof value !== 'string') throw new Error(`${field} must be an array of numbers or a base64 string`);
  const bytes = decodeForgivingBase64(value);
  if (bytes.length % FLOAT32_BYTES !== 0) throw new Error(`${field} is not a whole number of float32 values`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / FLOAT32_BYTES }, (_, index) => view.getFloat32(index * FLOAT32_BYTES, true));
};

const renderEmbedding = (values: readonly number[]): string => {
  const bytes = new Uint8Array(values.length * FLOAT32_BYTES);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * FLOAT32_BYTES, value, true));
  return encodeBase64(bytes);
};

const parseUsage = (value: unknown): CanonicalEmbeddingsUsage | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('usage must be an object');
  return {
    promptTokens: requiredInteger(value.prompt_tokens, 'usage.prompt_tokens'),
    totalTokens: requiredInteger(value.total_tokens, 'usage.total_tokens'),
  };
};

/**
 * Reads an upstream's answer into the canonical form.
 *
 * `requestedModel` completes the record when the upstream did not name one. The schema
 * marks `model` required, and most upstreams send it; the one this gateway carries that
 * does not is GitHub Copilot's `/embeddings`. Naming the model the request asked for is
 * both what the client can correlate against and what usage is billed under.
 */
export const parseEmbeddingsResponse = (value: unknown, requestedModel: string): CanonicalEmbeddingsResponse => {
  if (!isRecord(value)) throw new Error('Embeddings response body must be an object');
  const { data } = value;
  if (!Array.isArray(data)) throw new Error('data must be an array');
  const usage = parseUsage(value.usage);
  const embeddings: CanonicalEmbedding[] = data.map((entry, position) => {
    if (!isRecord(entry)) throw new Error(`data[${position}] must be an object`);
    return {
      index: requiredInteger(entry.index, `data[${position}].index`),
      values: parseEmbedding(entry.embedding, `data[${position}].embedding`),
    };
  });
  return {
    model: value.model === undefined ? requestedModel : requiredString(value.model, 'model'),
    embeddings,
    ...(usage === undefined ? {} : { usage }),
  };
};

/**
 * Writes the answer in the encoding the client asked for, whichever one the upstream
 * answered in. `object` is `x-stainless-const` at both levels, so it is a constant of the
 * protocol rather than something an upstream varies, and it is written here rather than
 * repeated back from the body.
 */
export const renderEmbeddingsResponse = (
  format: EmbeddingsEncodingFormat,
  response: CanonicalEmbeddingsResponse,
): Record<string, unknown> => ({
  object: 'list',
  data: response.embeddings.map(embedding => ({
    object: 'embedding',
    index: embedding.index,
    embedding: format === 'base64' ? renderEmbedding(embedding.values) : embedding.values,
  })),
  model: response.model,
  ...(response.usage === undefined ? {} : {
    usage: { prompt_tokens: response.usage.promptTokens, total_tokens: response.usage.totalTokens },
  }),
});
