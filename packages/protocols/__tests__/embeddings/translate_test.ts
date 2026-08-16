import { describe, expect, test } from 'vitest';

import {
  parseEmbeddingsRequest,
  parseEmbeddingsResponse,
  renderEmbeddingsResponse,
  serializeEmbeddingsRequest,
} from '../../src/embeddings/translate.ts';

// The float32 little-endian packing of [0.0023064255, -0.009327292, 1, -0.0028842222],
// and the float64 values those bits denote. Produced by Float32Array + Buffer on Node 24,
// which is the encoding both official OpenAI SDKs read a base64 embedding with.
const PACKED = 'ZicXO4DRGLwAAIA/OAU9uw==';
const VECTOR = [0.002306425478309393, -0.009327292442321777, 1, -0.0028842221945524216];

describe('embeddings request ingress', () => {
  test('a single text stays a single text, so the wire shape the upstream sees is unchanged', () => {
    const parsed = parseEmbeddingsRequest({ model: 'text-embedding-3-small', input: 'a sentence' });

    expect(parsed.model).toBe('text-embedding-3-small');
    expect(parsed.request).toEqual({ input: 'a sentence' });
    expect(serializeEmbeddingsRequest(parsed.request)).toEqual({ input: 'a sentence' });
  });

  test('the four input arms each survive', () => {
    const arms = [
      'one',
      ['one', 'two'],
      [1212, 318, 257],
      [[1212, 318], [257, 1332]],
    ];
    for (const input of arms) {
      expect(parseEmbeddingsRequest({ model: 'm', input }).request.input).toEqual(input);
    }
  });

  test('an omitted encoding_format is resolved for the client and left off the wire', () => {
    const parsed = parseEmbeddingsRequest({ model: 'm', input: 'a' });

    expect(parsed.encodingFormat).toBe('float');
    expect(parsed.request.encodingFormat).toBeUndefined();
    expect(serializeEmbeddingsRequest(parsed.request)).not.toHaveProperty('encoding_format');
  });

  test('a chosen encoding_format is both what the client reads and what the upstream is asked for', () => {
    const parsed = parseEmbeddingsRequest({ model: 'm', input: 'a', encoding_format: 'base64', dimensions: 256, user: 'u' });

    expect(parsed.encodingFormat).toBe('base64');
    expect(serializeEmbeddingsRequest(parsed.request)).toEqual({
      input: 'a',
      encoding_format: 'base64',
      dimensions: 256,
      user: 'u',
    });
  });

  test('a field the protocol has no place for is named rather than dropped', () => {
    expect(() => parseEmbeddingsRequest({ model: 'm', input: 'a', truncate: true, task: 'retrieval' }))
      .toThrow('Embeddings does not support truncate, task');
  });

  // An empty array satisfies three of the specification's four input arms at once, so the
  // canonical value would be ambiguous even though the JSON is well-formed.
  test('an empty input is refused, which is what keeps the parsed arms distinguishable', () => {
    expect(() => parseEmbeddingsRequest({ model: 'm', input: [] })).toThrow('input must not be empty');
  });

  test('a mixed array is refused rather than read as whichever arm came first', () => {
    expect(() => parseEmbeddingsRequest({ model: 'm', input: ['a', 1] })).toThrow('input[1] must be a non-empty string');
    expect(() => parseEmbeddingsRequest({ model: 'm', input: [1, 'a'] })).toThrow('input[1] must be an integer');
  });

  test('a non-integer dimensions is refused', () => {
    expect(() => parseEmbeddingsRequest({ model: 'm', input: 'a', dimensions: 0 })).toThrow('dimensions must be a positive integer');
    expect(() => parseEmbeddingsRequest({ model: 'm', input: 'a', dimensions: 1.5 })).toThrow('dimensions must be an integer');
  });
});

describe('embeddings response egress', () => {
  test('a base64 vector is read as the numbers it denotes', () => {
    const parsed = parseEmbeddingsResponse({
      object: 'list',
      model: 'text-embedding-3-small',
      data: [{ object: 'embedding', index: 0, embedding: PACKED }],
      usage: { prompt_tokens: 8, total_tokens: 8 },
    }, 'm');

    expect(parsed.embeddings).toEqual([{ index: 0, values: VECTOR }]);
    expect(parsed.usage).toEqual({ promptTokens: 8, totalTokens: 8 });
  });

  test('a truncated base64 vector is refused rather than read as a shorter one', () => {
    expect(() => parseEmbeddingsResponse({
      model: 'm',
      data: [{ index: 0, embedding: PACKED.slice(0, 8) }],
    }, 'm')).toThrow('data[0].embedding is not a whole number of float32 values');
  });

  // The schema marks `model` required and most upstreams send it; Copilot's `/embeddings`
  // does not. An answer the gateway understands is one it can write again, so the record is
  // completed with the model the request named rather than refused.
  test('an upstream that names no model is read as having answered for the requested one', () => {
    const parsed = parseEmbeddingsResponse(
      { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.5] }] },
      'text-embedding-real',
    );

    expect(parsed.model).toBe('text-embedding-real');
    expect(renderEmbeddingsResponse('float', parsed)).toMatchObject({ model: 'text-embedding-real' });
  });

  // A model the upstream *did* name is its own answer, and the request's id never overrides it.
  test('a model the upstream named is kept', () => {
    expect(parseEmbeddingsResponse({ model: 'upstream-id', data: [] }, 'requested-id').model).toBe('upstream-id');
  });

  // An upstream that reports no usage is a fact the gateway has to be able to carry: the
  // billed entity is present with no quantities, which is not the same as reporting zero.
  test('a missing usage block leaves the answer intact and reports nothing', () => {
    const parsed = parseEmbeddingsResponse({ model: 'm', data: [{ index: 0, embedding: [0.5] }] }, 'm');

    expect(parsed.usage).toBeUndefined();
    expect(renderEmbeddingsResponse('float', parsed)).not.toHaveProperty('usage');
  });

  // The case the encoding split exists for. An OpenAI SDK client asked for base64 without
  // saying so and will decode whatever it is handed; an upstream that ignores the field
  // and answers with float arrays would otherwise hand it noise.
  test('the answer is written in the encoding the client asked for, not the one it arrived in', () => {
    const arrived = parseEmbeddingsResponse({ model: 'm', data: [{ index: 0, embedding: VECTOR }] }, 'm');

    expect(renderEmbeddingsResponse('base64', arrived)).toMatchObject({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: PACKED }],
    });
    expect(renderEmbeddingsResponse('float', parseEmbeddingsResponse({
      model: 'm',
      data: [{ index: 0, embedding: PACKED }],
    }, 'm'))).toMatchObject({ data: [{ embedding: VECTOR }] });
  });

  // Every float32 is a float64, so widening loses nothing and narrowing a value that came
  // from a float32 gives the same bits back. Holding vectors as numbers is therefore exact
  // and not an approximation, however many times a vector crosses the gateway.
  test('a vector survives any number of trips through the two encodings', () => {
    const once = parseEmbeddingsResponse({ model: 'm', data: [{ index: 0, embedding: PACKED }] }, 'm');
    const twice = parseEmbeddingsResponse(renderEmbeddingsResponse('base64', once), 'm');
    const thrice = parseEmbeddingsResponse(renderEmbeddingsResponse('base64', twice), 'm');

    expect(renderEmbeddingsResponse('base64', thrice)).toMatchObject({ data: [{ embedding: PACKED }] });
    expect(thrice.embeddings).toEqual(once.embeddings);
  });

  test('object is written by the gateway at both levels rather than repeated back', () => {
    const rendered = renderEmbeddingsResponse('float', parseEmbeddingsResponse({
      object: 'not-a-list',
      model: 'm',
      data: [{ object: 'not-an-embedding', index: 0, embedding: [0.5] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }, 'm'));

    expect(rendered).toEqual({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.5] }],
      model: 'm',
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  });
});
