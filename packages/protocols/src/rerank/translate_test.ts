import { describe, expect, test } from 'vitest';

import { DEFAULT_RERANK_PATHS, parseRerankRequest, parseRerankResponse, parseRerankUsage, renderRerankResponse, serializeRerankRequest } from './translate.ts';

describe('rerank request ingress', () => {
  test('Cohere v1 retains structured documents and v1-only options', () => {
    const parsed = parseRerankRequest('cohere-v1', {
      model: 'rerank-v3.5',
      query: 'query',
      documents: ['one', { title: 'Two', text: 'body' }],
      top_n: 1,
      rank_fields: ['title', 'text'],
      return_documents: true,
      max_chunks_per_doc: 8,
    });

    expect(parsed.model).toBe('rerank-v3.5');
    expect(parsed.request).toMatchObject({
      sourceProtocol: 'cohere-v1',
      query: 'query',
      documents: ['one', { title: 'Two', text: 'body' }],
      topN: 1,
      rankFields: ['title', 'text'],
      returnDocuments: true,
      maxChunksPerDocument: 8,
    });
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
    })).toThrow('cohere-v2 does not support return_documents');
    expect(() => parseRerankRequest('cohere-v2', {
      model: 'rerank-v4.0-pro',
      query: 'query',
      documents: [{ text: 'one' }],
    })).toThrow('documents must be a non-empty array of strings');
  });

  test('Jina and Voyage apply their documented response-document defaults', () => {
    const jina = parseRerankRequest('jina-v1', {
      model: 'jina-reranker-m0',
      query: { image: 'https://example.com/query.png' },
      documents: [{ text: 'one' }, { image: 'https://example.com/two.png' }],
    });
    expect(jina.request.returnDocuments).toBe(true);

    const voyage = parseRerankRequest('voyage-v1', {
      model: 'rerank-2.5',
      query: 'query',
      documents: ['one'],
    });
    expect(voyage.request.returnDocuments).toBe(false);
    expect(voyage.request.truncation).toBe(true);
  });

  test('Jina accepts its documented nullable controls', () => {
    const jina = parseRerankRequest('jina-v1', {
      model: 'jina-reranker-v3',
      query: 'query',
      documents: ['one'],
      top_n: null,
      return_documents: null,
      truncation: null,
      return_embeddings: null,
    });
    expect(jina.request.topN).toBeUndefined();
    expect(jina.request.returnDocuments).toBe(true);
    expect(jina.request.truncation).toBeUndefined();
    expect(jina.request.returnEmbeddings).toBeUndefined();
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

  test('same-dialect egress preserves opaque request fields while replacing model', () => {
    const source = parseRerankRequest('jina-v1', {
      model: 'public',
      query: 'query',
      documents: ['one'],
      vendor_extension: { enabled: true },
    }).request;
    expect(serializeRerankRequest('jina-v1', 'raw', source)).toEqual({
      model: 'raw',
      query: 'query',
      documents: ['one'],
      vendor_extension: { enabled: true },
    });
  });

  test('canonical paths keep compatible and native DashScope wires distinct', () => {
    expect(DEFAULT_RERANK_PATHS).toEqual({
      'cohere-v1': '/v1/rerank',
      'cohere-v2': '/v2/rerank',
      'jina-v1': '/v1/rerank',
      'voyage-v1': '/v1/rerank',
      'dashscope-compatible': '/compatible-api/v1/reranks',
      'dashscope-native': '/api/v1/services/rerank/text-rerank/text-rerank',
    });
  });

  test('rejects source-only controls that the target cannot represent', () => {
    const jina = parseRerankRequest('jina-v1', {
      model: 'jina', query: 'query', documents: ['one'], return_embeddings: true,
    }).request;
    expect(() => serializeRerankRequest('cohere-v2', 'raw', jina)).toThrow('return_embeddings=true requires a Jina target');

    const voyage = parseRerankRequest('voyage-v1', {
      model: 'voyage', query: 'query', documents: ['one'], truncation: false,
    }).request;
    expect(() => serializeRerankRequest('dashscope-compatible', 'raw', voyage)).toThrow('truncation=false requires a Jina or Voyage target');
  });

  test('permits Jina image inputs only on multimodal target protocols', () => {
    const request = parseRerankRequest('jina-v1', {
      model: 'jina-reranker-m0',
      query: { image: 'https://example.com/query.png' },
      documents: [{ image: 'https://example.com/document.png' }],
    }).request;

    for (const protocol of ['cohere-v1', 'cohere-v2', 'voyage-v1', 'dashscope-compatible'] as const) {
      expect(() => serializeRerankRequest(protocol, 'raw', request)).toThrow('image query/documents require a Jina or DashScope native target');
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
  test('extracts search units only from Cohere meta', () => {
    const cohere = parseRerankResponse('cohere-v2', {
      id: 'id-1',
      results: [{ index: 1, relevance_score: 0.9 }],
      meta: { billed_units: { search_units: 2 }, tokens: { input_tokens: 30 } },
    });
    expect(cohere.searchUnits).toBe(2);
    expect(cohere.totalTokens).toBe(30);

    const jina = parseRerankResponse('jina-v1', {
      model: 'jina',
      object: 'list',
      results: [{ index: 0, relevance_score: 0.8 }],
      usage: { total_tokens: 40, search_units: 999 },
    });
    expect(jina.totalTokens).toBe(40);
    expect(jina.searchUnits).toBeUndefined();
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
    expect(parseRerankUsage('cohere-v2', {
      meta: { billed_units: { search_units: 2 }, tokens: null },
    })).toEqual({ searchUnits: 2 });
    expect(parseRerankUsage('cohere-v2', {
      meta: { billed_units: { search_units: null }, tokens: { input_tokens: null } },
    })).toEqual({});
    expect(parseRerankUsage('cohere-v2', {
      meta: { billed_units: { search_units: null }, tokens: { input_tokens: 3 } },
    })).toEqual({ totalTokens: 3 });

    expect(() => parseRerankUsage('cohere-v2', { meta: 'bad' })).toThrow('meta must be an object or null');
    expect(() => parseRerankUsage('cohere-v2', { meta: { billed_units: 1 } })).toThrow('meta.billed_units must be an object or null');
    expect(() => parseRerankUsage('cohere-v2', { meta: { tokens: [] } })).toThrow('meta.tokens must be an object or null');
    expect(() => parseRerankUsage('cohere-v2', { meta: { billed_units: { search_units: '2' } } })).toThrow('meta.billed_units.search_units must be a finite number');
    expect(() => parseRerankUsage('cohere-v2', { meta: { tokens: { input_tokens: '3' } } })).toThrow('meta.tokens.input_tokens must be a finite number');
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
      expect(() => parseRerankUsage(protocol, { ...response, usage: {} })).toThrow('usage.total_tokens must be a finite number');
    }
  });

  test('accepts protocol-specific returned document objects without narrowing their fields', () => {
    expect(parseRerankResponse('cohere-v1', {
      results: [{ index: 0, relevance_score: 0.8, document: { title: 'A' } }],
    }).results[0]?.document).toEqual({ title: 'A' });
    expect(parseRerankResponse('dashscope-native', {
      request_id: 'request',
      output: { results: [{ index: 0, relevance_score: 0.7, document: { video: 'https://example.com/a.mp4' } }] },
    }).results[0]?.document).toEqual({ video: 'https://example.com/a.mp4' });
  });

  test('renders source-specific result containers and reconstructs requested documents', () => {
    const request = parseRerankRequest('voyage-v1', {
      model: 'public', query: 'query', documents: ['one', 'two'], return_documents: true,
    }).request;
    const canonical = parseRerankResponse('cohere-v2', {
      id: 'request', results: [{ index: 1, relevance_score: 0.9 }], meta: { billed_units: { search_units: 1 } },
    });
    expect(renderRerankResponse('voyage-v1', 'cohere-v2', canonical, request)).toEqual({
      object: 'list',
      model: 'public',
      data: [{ index: 1, relevance_score: 0.9, document: 'two' }],
    });
  });
});
