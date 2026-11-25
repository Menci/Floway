import { describe, expect, test } from 'vitest';

import { parseRerankRequest, parseRerankResponse, parseRerankUsage, renderRerankResponse, serializeRerankRequest } from '../../src/rerank/translate.ts';
import { assert } from '@floway-dev/test-utils';

describe('rerank request ingress', () => {

  test('Cohere v2 admits only its string-document contract', () => {
    const parsed = parseRerankRequest('cohere-v2', {
      model: 'rerank-v4.0-pro',
      query: 'query',
      documents: ['one', 'two'],
      top_n: 1,
      max_tokens_per_doc: 2048,
      priority: 2,
    });

    assert(parsed.ok);
    expect(parsed.value.request).toMatchObject({
      sourceProtocol: 'cohere-v2',
      topN: 1,
      maxTokensPerDocument: 2048,
      priority: 2,
    });
    expect(parseRerankRequest('cohere-v2', {
      model: 'rerank-v4.0-pro',
      query: 'query',
      documents: ['one'],
      return_documents: true,
    })).toEqual({ ok: false, error: 'cohere-v2 does not support return_documents' });
    expect(parseRerankRequest('cohere-v2', {
      model: 'rerank-v4.0-pro',
      query: 'query',
      documents: [{ text: 'one' }],
    })).toEqual({ ok: false, error: 'documents must be a non-empty array of strings' });
  });

  test('propagates a defect encountered during request validation', () => {
    const defect = new TypeError('unexpected model access');
    expect(() => parseRerankRequest('cohere-v2', { get model() { throw defect; } })).toThrow(defect);
  });
});

describe('rerank request egress', () => {
  const parsed = parseRerankRequest('jina-v1', {
    model: 'public-model',
    query: 'query',
    documents: ['one', { text: 'two' }],
    top_n: 2,
    return_documents: true,
  });
  assert(parsed.ok);
  const { request } = parsed.value;

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
    });
    assert(jina.ok);
    expect(() => serializeRerankRequest('cohere-v2', 'raw', jina.value.request)).toThrow();

    const voyage = parseRerankRequest('voyage-v1', {
      model: 'voyage', query: 'query', documents: ['one'], truncation: false,
    });
    assert(voyage.ok);
    expect(() => serializeRerankRequest('dashscope-compatible', 'raw', voyage.value.request)).toThrow();
  });

  test('permits Jina image inputs only on multimodal target protocols', () => {
    const parsed = parseRerankRequest('jina-v1', {
      model: 'jina-reranker-m0',
      query: { image: 'https://example.com/query.png' },
      documents: [{ image: 'https://example.com/document.png' }],
    });
    assert(parsed.ok);
    const { request } = parsed.value;

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

  test('Cohere usage accepts omitted and null optional objects but rejects malformed present objects', () => {
    for (const response of [
      { results: [] },
      { results: [], meta: null },
      { results: [], meta: { billed_units: null, tokens: null } },
    ]) {
      expect(parseRerankUsage('cohere-v2', response)).toEqual({ ok: true, value: {} });
      expect(parseRerankResponse('cohere-v2', response)).toMatchObject({ ok: true, value: { results: [] } });
    }

    expect(parseRerankUsage('cohere-v2', {
      meta: { billed_units: null, tokens: { input_tokens: 3 } },
    })).toEqual({ ok: true, value: { totalTokens: 3 } });

    expect(parseRerankUsage('cohere-v2', { meta: 'bad' })).toEqual({ ok: false, error: 'meta must be an object or null' });
    expect(parseRerankUsage('cohere-v2', { meta: { billed_units: { search_units: '2' } } }))
      .toEqual({ ok: false, error: 'meta.billed_units.search_units must be a finite number' });
    expect(parseRerankUsage('cohere-v2', { meta: { tokens: { input_tokens: '3' } } }))
      .toEqual({ ok: false, error: 'meta.tokens.input_tokens must be a finite number' });
  });

  test('propagates a defect encountered during usage validation', () => {
    const defect = new TypeError('unexpected usage access');
    expect(() => parseRerankUsage('cohere-v2', { get meta() { throw defect; } })).toThrow(defect);
  });

  test('normalizes Voyage and both DashScope response envelopes', () => {
    expect(parseRerankResponse('voyage-v1', {
      object: 'list', model: 'voyage', data: [{ index: 0, relevance_score: 0.7 }], usage: { total_tokens: 10 },
    })).toMatchObject({ ok: true, value: { results: [{ index: 0, relevanceScore: 0.7 }] } });
    expect(parseRerankResponse('dashscope-compatible', {
      object: 'list', model: 'qwen', id: 'request', results: [{ index: 0, relevance_score: 0.6 }], usage: { total_tokens: 11 },
    })).toMatchObject({ ok: true, value: { results: [{ index: 0, relevanceScore: 0.6 }] } });
    expect(parseRerankResponse('dashscope-native', {
      request_id: 'request', output: { results: [{ index: 0, relevance_score: 0.5 }] }, usage: { total_tokens: 12 },
    })).toMatchObject({ ok: true, value: { results: [{ index: 0, relevanceScore: 0.5 }] } });
  });

  test('treats omitted usage as absent and malformed present usage as an error', () => {
    const responses = [
      ['jina-v1', { object: 'list', model: 'jina', results: [] }],
      ['voyage-v1', { object: 'list', model: 'voyage', data: [] }],
      ['dashscope-compatible', { object: 'list', model: 'qwen', id: 'request', results: [] }],
      ['dashscope-native', { request_id: 'request', output: { results: [] } }],
    ] as const;
    for (const [protocol, response] of responses) {
      expect(parseRerankUsage(protocol, response)).toEqual({ ok: true, value: {} });
      const parsed = parseRerankResponse(protocol, response);
      assert(parsed.ok);
      expect(parsed.value.totalTokens).toBeUndefined();
      expect(parseRerankUsage(protocol, { ...response, usage: {} })).toEqual({ ok: false, error: 'usage.total_tokens must be a finite number' });
    }
  });

  test('renders source-specific result containers and reconstructs requested documents', () => {
    const parsed = parseRerankRequest('voyage-v1', {
      model: 'public', query: 'query', documents: ['one', 'two'], return_documents: true,
    });
    assert(parsed.ok);
    const { request } = parsed.value;
    const canonical = parseRerankResponse('cohere-v2', {
      id: 'request', results: [{ index: 1, relevance_score: 0.9 }], meta: { billed_units: { search_units: 1 } },
    });
    assert(canonical.ok);
    expect(renderRerankResponse('voyage-v1', 'cohere-v2', canonical.value, request)).toEqual({
      object: 'list',
      model: 'public',
      data: [{ index: 1, relevance_score: 0.9, document: 'two' }],
    });
  });

  test('returns an invalid result as a failure and propagates an accessor bug', () => {
    const invalid = parseRerankResponse('cohere-v2', { results: [{ index: -1, relevance_score: 1 }] });
    expect(invalid).toEqual({ ok: false, error: new Error('results[0].index must be a non-negative integer') });
    const bug = new TypeError('results accessor bug');
    expect(() => parseRerankResponse('cohere-v2', { get results() { throw bug; } })).toThrow(bug);
  });
});
