import { describe, expect, test } from 'vitest';

import { parseRerankRequest, parseRerankResponse, parseRerankUsage, renderCrossDialectRerankResponse, renderRerankResponse, RerankRequestValidationError, RerankResponseValidationError, serializeRerankRequest } from '../../src/rerank/index.ts';

describe('rerank request ingress', () => {
  test.each([
    ['cohere-v1', null],
    ['cohere-v1', { model: 'm', query: 'q', documents: [{ text: 4 }] }],
    ['cohere-v2', { model: 'm', query: 'q', documents: ['one'], top_n: 0 }],
    ['cohere-v2', { model: 'm', query: 'q', documents: ['one'], return_documents: true }],
    ['jina-v1', { model: 'm', query: 'q', documents: [{ image: 3 }] }],
    ['voyage-v1', { model: 'm', query: 'q', documents: ['one'], truncation: 'false' }],
  ] as const)('uses the request validation error for malformed %s input', (protocol, value) => {
    expect(() => parseRerankRequest(protocol, value)).toThrow(RerankRequestValidationError);
  });

  test('preserves unexpected rerank request exceptions by identity', () => {
    const failure = new TypeError('unexpected document accessor failure');
    const value = { model: 'm', query: 'q', get documents() { throw failure; } };
    let caught: unknown;
    try {
      parseRerankRequest('cohere-v2', value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });

  test('Cohere v2 admits only its string-document contract', () => {
    const parsed = parseRerankRequest('cohere-v2', {
      model: 'rerank-v4.0-pro',
      query: 'query',
      documents: ['one', 'two'],
      top_n: 1,
      max_tokens_per_doc: 2048,
      priority: 2,
    });

    expect(parsed.request).toMatchObject({
      sourceProtocol: 'cohere-v2',
      topN: 1,
      maxTokensPerDocument: 2048,
      priority: 2,
    });
    expect(() => parseRerankRequest('cohere-v2', {
      model: 'rerank-v4.0-pro',
      query: 'query',
      documents: ['one'],
      return_documents: true,
    })).toThrow();
    expect(() => parseRerankRequest('cohere-v2', {
      model: 'rerank-v4.0-pro',
      query: 'query',
      documents: [{ text: 'one' }],
    })).toThrow();
  });
});

describe('rerank request egress', () => {
  const request = parseRerankRequest('jina-v1', {
    model: 'public-model',
    query: 'query',
    documents: ['one', { text: 'two' }],
    top_n: 2,
    return_documents: true,
  }).request;

  test('maps the semantic request onto every outbound dialect', () => {
    expect(serializeRerankRequest('cohere-v1', 'raw', request)).toEqual({
      model: 'raw',
      query: 'query',
      documents: ['one', { text: 'two' }],
      top_n: 2,
      return_documents: true,
    });
    expect(serializeRerankRequest('cohere-v2', 'raw', request)).toEqual({
      model: 'raw',
      query: 'query',
      documents: ['one', 'two'],
      top_n: 2,
    });
    expect(serializeRerankRequest('voyage-v1', 'raw', request)).toEqual({
      model: 'raw',
      query: 'query',
      documents: ['one', 'two'],
      top_k: 2,
      return_documents: true,
    });
    expect(serializeRerankRequest('dashscope-compatible', 'raw', request)).toEqual({
      model: 'raw',
      query: 'query',
      documents: ['one', 'two'],
      top_n: 2,
    });
    expect(serializeRerankRequest('dashscope-native', 'raw', request)).toEqual({
      model: 'raw',
      input: { query: 'query', documents: ['one', { text: 'two' }] },
      parameters: { top_n: 2, return_documents: true },
    });
  });

  test('rejects source-only controls that the target cannot represent', () => {
    const jina = parseRerankRequest('jina-v1', {
      model: 'jina', query: 'query', documents: ['one'], return_embeddings: true,
    }).request;
    expect(() => serializeRerankRequest('cohere-v2', 'raw', jina)).toThrow();

    const voyage = parseRerankRequest('voyage-v1', {
      model: 'voyage', query: 'query', documents: ['one'], truncation: false,
    }).request;
    expect(() => serializeRerankRequest('dashscope-compatible', 'raw', voyage)).toThrow();
  });

  test('permits Jina image inputs only on multimodal target protocols', () => {
    const request = parseRerankRequest('jina-v1', {
      model: 'jina-reranker-m0',
      query: { image: 'https://example.com/query.png' },
      documents: [{ image: 'https://example.com/document.png' }],
    }).request;

    for (const protocol of ['cohere-v1', 'cohere-v2', 'voyage-v1', 'dashscope-compatible'] as const) {
      expect(() => serializeRerankRequest(protocol, 'raw', request)).toThrow();
    }
    expect(serializeRerankRequest('jina-v1', 'raw', request)).toMatchObject({ query: { image: 'https://example.com/query.png' } });
    expect(serializeRerankRequest('dashscope-native', 'raw', request)).toMatchObject({
      input: {
        query: { image: 'https://example.com/query.png' },
        documents: [{ image: 'https://example.com/document.png' }],
      },
    });
  });
});

describe('rerank response translation', () => {
  test.each([
    ['body', 'cohere-v2', null],
    ['result list', 'cohere-v2', { results: {} }],
    ['result item', 'cohere-v2', { results: [null] }],
    ['index', 'cohere-v2', { results: [{ index: -1, relevance_score: 1 }] }],
    ['relevance', 'cohere-v2', { results: [{ index: 0, relevance_score: Infinity }] }],
    ['embedding', 'cohere-v2', { results: [{ index: 0, relevance_score: 1, embedding: [1, '2'] }] }],
    ['output', 'dashscope-native', { request_id: 'valid', output: [] }],
    ['request ID', 'dashscope-native', { output: { results: [] } }],
    ['usage', 'cohere-v2', { results: [], meta: { tokens: { input_tokens: '1' } } }],
  ] as const)('uses the dedicated error for malformed response %s', (_field, protocol, body) => {
    expect(() => parseRerankResponse(protocol, body)).toThrow(RerankResponseValidationError);
  });

  test('keeps request validation and unexpected response exceptions outside the response wire error class', () => {
    const parseRequest = () => parseRerankRequest('cohere-v2', { model: 4, query: 'query', documents: ['one'] });
    expect(parseRequest).toThrow(RerankRequestValidationError);
    expect(parseRequest).not.toThrow(RerankResponseValidationError);

    const body = { get results() { throw new TypeError('unexpected accessor failure'); } };
    const parseResponse = () => parseRerankResponse('cohere-v2', body);
    expect(parseResponse).toThrow(TypeError);
    expect(parseResponse).not.toThrow(RerankResponseValidationError);
  });

  test('Cohere usage accepts omitted and null optional objects but rejects malformed present objects', () => {
    for (const response of [
      { results: [] },
      { results: [], meta: null },
      { results: [], meta: { billed_units: null, tokens: null } },
    ]) {
      expect(parseRerankUsage('cohere-v2', response)).toEqual({});
      expect(parseRerankResponse('cohere-v2', response)).toMatchObject({ results: [] });
    }

    expect(parseRerankUsage('cohere-v2', {
      meta: { billed_units: null, tokens: { input_tokens: 3 } },
    })).toEqual({ totalTokens: 3 });

    expect(() => parseRerankUsage('cohere-v2', { meta: 'bad' })).toThrow();
    expect(() => parseRerankUsage('cohere-v2', { meta: { billed_units: { search_units: '2' } } })).toThrow();
    expect(() => parseRerankUsage('cohere-v2', { meta: { tokens: { input_tokens: '3' } } })).toThrow();
  });

  test('normalizes Voyage and both DashScope response envelopes', () => {
    expect(parseRerankResponse('voyage-v1', {
      object: 'list', model: 'voyage', data: [{ index: 0, relevance_score: 0.7 }], usage: { total_tokens: 10 },
    }).results[0]).toEqual({ index: 0, relevanceScore: 0.7 });
    expect(parseRerankResponse('dashscope-compatible', {
      object: 'list', model: 'qwen', id: 'request', results: [{ index: 0, relevance_score: 0.6 }], usage: { total_tokens: 11 },
    }).results[0]).toEqual({ index: 0, relevanceScore: 0.6 });
    expect(parseRerankResponse('dashscope-native', {
      request_id: 'request', output: { results: [{ index: 0, relevance_score: 0.5 }] }, usage: { total_tokens: 12 },
    }).results[0]).toEqual({ index: 0, relevanceScore: 0.5 });
  });

  test('treats omitted usage as absent and malformed present usage as an error', () => {
    const responses = [
      ['jina-v1', { object: 'list', model: 'jina', results: [] }],
      ['voyage-v1', { object: 'list', model: 'voyage', data: [] }],
      ['dashscope-compatible', { object: 'list', model: 'qwen', id: 'request', results: [] }],
      ['dashscope-native', { request_id: 'request', output: { results: [] } }],
    ] as const;
    for (const [protocol, response] of responses) {
      expect(parseRerankUsage(protocol, response)).toEqual({});
      expect(parseRerankResponse(protocol, response).totalTokens).toBeUndefined();
      expect(() => parseRerankUsage(protocol, { ...response, usage: {} })).toThrow();
    }
  });

  test('renders source-specific result containers and reconstructs requested documents', () => {
    const request = parseRerankRequest('voyage-v1', {
      model: 'public', query: 'query', documents: ['one', 'two'], return_documents: true,
    }).request;
    const canonical = parseRerankResponse('cohere-v2', {
      id: 'request', results: [{ index: 1, relevance_score: 0.9 }], meta: { billed_units: { search_units: 1 } },
    });
    const rendered = {
      object: 'list',
      model: 'public',
      data: [{ index: 1, relevance_score: 0.9, document: 'two' }],
    };
    expect(renderCrossDialectRerankResponse(request, canonical)).toEqual(rendered);
    expect(renderRerankResponse('voyage-v1', 'cohere-v2', canonical, request)).toEqual(rendered);
  });
});
