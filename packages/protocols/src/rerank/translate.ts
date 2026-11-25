import type { ParsedRerankRequest, CanonicalRerankRequest, CanonicalRerankResponse, CanonicalRerankResult, RerankInput } from './index.ts';
import type { RerankProtocol, RerankSourceProtocol } from '../common/models.ts';
import type { Result } from '@floway-dev/pipeline';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalBoolean = (value: unknown, field: string): Result<boolean | undefined, string> => {
  if (value !== undefined && typeof value !== 'boolean') return { ok: false, error: `${field} must be a boolean` };
  return { ok: true, value };
};

const optionalFiniteNumber = (value: unknown, field: string): Result<number | undefined, string> => {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    return { ok: false, error: `${field} must be a finite number` };
  }
  return { ok: true, value };
};

const optionalPositiveInteger = (value: unknown, field: string): Result<number | undefined, string> => {
  const number = optionalFiniteNumber(value, field);
  if (number.ok && number.value !== undefined && (!Number.isInteger(number.value) || number.value < 1)) {
    return { ok: false, error: `${field} must be a positive integer` };
  }
  return number;
};

const optionalInteger = (value: unknown, field: string): Result<number | undefined, string> => {
  const number = optionalFiniteNumber(value, field);
  if (number.ok && number.value !== undefined && !Number.isInteger(number.value)) {
    return { ok: false, error: `${field} must be an integer` };
  }
  return number;
};

const stringArray = (value: unknown, field: string): Result<string[], string> => {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string')) {
    return { ok: false, error: `${field} must be a non-empty array of strings` };
  }
  return { ok: true, value: value as string[] };
};

const cohereV1Documents = (value: unknown): Result<RerankInput[], string> => {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: 'documents must be a non-empty array' };
  const documents: RerankInput[] = [];
  for (const [index, document] of value.entries()) {
    if (typeof document !== 'string' && (!isRecord(document) || Object.values(document).some(item => typeof item !== 'string'))) {
      return { ok: false, error: `documents[${index}] must be a string or an object whose values are strings` };
    }
    documents.push(document);
  }
  return { ok: true, value: documents };
};

const jinaStructuredInput = (value: unknown, field: string, keys: readonly ('text' | 'image')[]): Result<RerankInput, string> => {
  if (typeof value !== 'string' && (!isRecord(value) || !keys.some(key => typeof value[key] === 'string'))) {
    return { ok: false, error: `${field} must be a string or an object with a string ${keys.join(' or ')} field` };
  }
  return { ok: true, value };
};

const jinaDocuments = (value: unknown): Result<RerankInput[], string> => {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: 'documents must be a non-empty array' };
  const documents: RerankInput[] = [];
  for (const [index, document] of value.entries()) {
    const parsed = jinaStructuredInput(document, `documents[${index}]`, ['text', 'image']);
    if (!parsed.ok) return parsed;
    documents.push(parsed.value);
  }
  return { ok: true, value: documents };
};

const baseRequest = (body: Record<string, unknown>, sourceProtocol: RerankSourceProtocol): Omit<CanonicalRerankRequest, 'query' | 'documents'> => ({
  sourceProtocol,
  raw: body,
});

const rejectFields = (body: Record<string, unknown>, protocol: RerankSourceProtocol, fields: readonly string[]): Result<void, string> => {
  const unsupported = fields.filter(field => body[field] !== undefined);
  if (unsupported.length > 0) return { ok: false, error: `${protocol} does not support ${unsupported.join(', ')}` };
  return { ok: true, value: undefined };
};

export const parseRerankRequest = (protocol: RerankSourceProtocol, value: unknown): Result<ParsedRerankRequest, string> => {
  if (!isRecord(value)) return { ok: false, error: 'Rerank request body must be an object' };
  const { model } = value;
  if (typeof model !== 'string' || model.length === 0) return { ok: false, error: 'model must be a non-empty string' };
  switch (protocol) {
  case 'cohere-v1': {
    const supported = rejectFields(value, protocol, ['max_tokens_per_doc', 'priority', 'top_k']);
    if (!supported.ok) return supported;
    const rankFields = value.rank_fields === undefined ? { ok: true, value: undefined } as const : stringArray(value.rank_fields, 'rank_fields');
    if (!rankFields.ok) return rankFields;
    const topN = optionalPositiveInteger(value.top_n, 'top_n');
    if (!topN.ok) return topN;
    const returnDocuments = optionalBoolean(value.return_documents, 'return_documents');
    if (!returnDocuments.ok) return returnDocuments;
    const maxChunksPerDocument = optionalPositiveInteger(value.max_chunks_per_doc, 'max_chunks_per_doc');
    if (!maxChunksPerDocument.ok) return maxChunksPerDocument;
    const { query } = value;
    if (typeof query !== 'string' || query.length === 0) return { ok: false, error: 'query must be a non-empty string' };
    const documents = cohereV1Documents(value.documents);
    if (!documents.ok) return documents;
    return {
      ok: true,
      value: {
        model,
        request: {
          ...baseRequest(value, protocol),
          query,
          documents: documents.value,
          ...(topN.value === undefined ? {} : { topN: topN.value }),
          ...(rankFields.value === undefined ? {} : { rankFields: rankFields.value }),
          ...(returnDocuments.value === undefined ? {} : { returnDocuments: returnDocuments.value }),
          ...(maxChunksPerDocument.value === undefined ? {} : { maxChunksPerDocument: maxChunksPerDocument.value }),
        },
      },
    };
  }
  case 'cohere-v2': {
    const supported = rejectFields(value, protocol, ['rank_fields', 'return_documents', 'max_chunks_per_doc', 'top_k']);
    if (!supported.ok) return supported;
    const topN = optionalPositiveInteger(value.top_n, 'top_n');
    if (!topN.ok) return topN;
    const maxTokensPerDocument = optionalPositiveInteger(value.max_tokens_per_doc, 'max_tokens_per_doc');
    if (!maxTokensPerDocument.ok) return maxTokensPerDocument;
    const priority = optionalInteger(value.priority, 'priority');
    if (!priority.ok) return priority;
    const { query } = value;
    if (typeof query !== 'string' || query.length === 0) return { ok: false, error: 'query must be a non-empty string' };
    const documents = stringArray(value.documents, 'documents');
    if (!documents.ok) return documents;
    return {
      ok: true,
      value: {
        model,
        request: {
          ...baseRequest(value, protocol),
          query,
          documents: documents.value,
          ...(topN.value === undefined ? {} : { topN: topN.value }),
          ...(maxTokensPerDocument.value === undefined ? {} : { maxTokensPerDocument: maxTokensPerDocument.value }),
          ...(priority.value === undefined ? {} : { priority: priority.value }),
        },
      },
    };
  }
  case 'jina-v1': {
    const supported = rejectFields(value, protocol, ['top_k', 'rank_fields', 'max_chunks_per_doc', 'max_tokens_per_doc', 'priority']);
    if (!supported.ok) return supported;
    // Jina returns documents unless explicitly disabled. Its live OpenAPI is
    // the authority for the model-discriminated text and multimodal inputs:
    // https://api.jina.ai/openapi.json
    const returnDocuments = optionalBoolean(value.return_documents ?? undefined, 'return_documents');
    if (!returnDocuments.ok) return returnDocuments;
    const topN = optionalPositiveInteger(value.top_n ?? undefined, 'top_n');
    if (!topN.ok) return topN;
    const truncation = optionalBoolean(value.truncation ?? undefined, 'truncation');
    if (!truncation.ok) return truncation;
    const maxDocumentLength = optionalPositiveInteger(value.max_doc_length, 'max_doc_length');
    if (!maxDocumentLength.ok) return maxDocumentLength;
    const returnEmbeddings = optionalBoolean(value.return_embeddings ?? undefined, 'return_embeddings');
    if (!returnEmbeddings.ok) return returnEmbeddings;
    const query = jinaStructuredInput(value.query, 'query', ['image']);
    if (!query.ok) return query;
    const documents = jinaDocuments(value.documents);
    if (!documents.ok) return documents;
    return {
      ok: true,
      value: {
        model,
        request: {
          ...baseRequest(value, protocol),
          query: query.value,
          documents: documents.value,
          ...(topN.value === undefined ? {} : { topN: topN.value }),
          returnDocuments: returnDocuments.value ?? true,
          ...(truncation.value === undefined ? {} : { truncation: truncation.value }),
          ...(maxDocumentLength.value === undefined ? {} : { maxDocumentLength: maxDocumentLength.value }),
          ...(returnEmbeddings.value === undefined ? {} : { returnEmbeddings: returnEmbeddings.value }),
        },
      },
    };
  }
  case 'voyage-v1': {
    const supported = rejectFields(value, protocol, ['top_n', 'rank_fields', 'max_chunks_per_doc', 'max_tokens_per_doc', 'priority', 'max_doc_length', 'return_embeddings']);
    if (!supported.ok) return supported;
    // Voyage REST defaults return_documents=false and truncation=true:
    // https://docs.voyageai.com/reference/reranker-api.md
    const returnDocuments = optionalBoolean(value.return_documents, 'return_documents');
    if (!returnDocuments.ok) return returnDocuments;
    const truncation = optionalBoolean(value.truncation, 'truncation');
    if (!truncation.ok) return truncation;
    const topN = optionalPositiveInteger(value.top_k ?? undefined, 'top_k');
    if (!topN.ok) return topN;
    const { query } = value;
    if (typeof query !== 'string' || query.length === 0) return { ok: false, error: 'query must be a non-empty string' };
    const documents = stringArray(value.documents, 'documents');
    if (!documents.ok) return documents;
    return {
      ok: true,
      value: {
        model,
        request: {
          ...baseRequest(value, protocol),
          query,
          documents: documents.value,
          ...(topN.value === undefined ? {} : { topN: topN.value }),
          returnDocuments: returnDocuments.value ?? false,
          truncation: truncation.value ?? true,
        },
      },
    };
  }
  }
};

const stringInput = (input: RerankInput): string => {
  if (typeof input === 'string') return input;
  return typeof input.text === 'string' ? input.text : JSON.stringify(input);
};

export const rerankRequestIncompatibility = (
  protocol: RerankProtocol,
  request: CanonicalRerankRequest,
): string | null => {
  const hasJinaImageInput = request.sourceProtocol === 'jina-v1'
    && [request.query, ...request.documents].some(input => typeof input !== 'string' && typeof input.image === 'string');
  if (hasJinaImageInput && protocol !== 'jina-v1' && protocol !== 'dashscope-native') {
    return 'image query/documents require a Jina or DashScope native target';
  }
  if (protocol !== 'cohere-v1' && (request.rankFields !== undefined || request.maxChunksPerDocument !== undefined)) {
    return 'rank_fields and max_chunks_per_doc require a Cohere v1 target';
  }
  if (protocol !== 'cohere-v2' && (request.maxTokensPerDocument !== undefined || request.priority !== undefined)) {
    return 'max_tokens_per_doc and priority require a Cohere v2 target';
  }
  if (protocol !== 'jina-v1' && request.maxDocumentLength !== undefined) {
    return 'max_doc_length requires a Jina target';
  }
  if (protocol !== 'jina-v1' && request.returnEmbeddings === true) {
    return 'return_embeddings=true requires a Jina target';
  }
  if (protocol !== 'jina-v1' && protocol !== 'voyage-v1' && request.truncation === false) {
    return 'truncation=false requires a Jina or Voyage target';
  }
  return null;
};

export const serializeRerankRequest = (
  protocol: RerankProtocol,
  model: string,
  request: CanonicalRerankRequest,
): Record<string, unknown> => {
  const incompatibility = rerankRequestIncompatibility(protocol, request);
  if (incompatibility !== null) throw new Error(incompatibility);
  if (protocol === request.sourceProtocol) return { ...request.raw, model };
  const strings = request.documents.map(stringInput);
  switch (protocol) {
  case 'cohere-v1':
    return {
      model,
      query: stringInput(request.query),
      documents: request.documents.every(document => typeof document === 'string' || Object.values(document).every(value => typeof value === 'string'))
        ? request.documents
        : strings,
      ...(request.topN === undefined ? {} : { top_n: request.topN }),
      ...(request.rankFields === undefined ? {} : { rank_fields: request.rankFields }),
      ...(request.returnDocuments === undefined ? {} : { return_documents: request.returnDocuments }),
      ...(request.maxChunksPerDocument === undefined ? {} : { max_chunks_per_doc: request.maxChunksPerDocument }),
    };
  case 'cohere-v2':
    return {
      model,
      query: stringInput(request.query),
      documents: strings,
      ...(request.topN === undefined ? {} : { top_n: request.topN }),
      ...(request.maxTokensPerDocument === undefined ? {} : { max_tokens_per_doc: request.maxTokensPerDocument }),
      ...(request.priority === undefined ? {} : { priority: request.priority }),
    };
  case 'jina-v1':
    return {
      model,
      query: request.query,
      documents: request.documents,
      ...(request.topN === undefined ? {} : { top_n: request.topN }),
      ...(request.returnDocuments === undefined ? {} : { return_documents: request.returnDocuments }),
      ...(request.truncation === undefined ? {} : { truncation: request.truncation }),
      ...(request.maxDocumentLength === undefined ? {} : { max_doc_length: request.maxDocumentLength }),
      ...(request.returnEmbeddings === undefined ? {} : { return_embeddings: request.returnEmbeddings }),
    };
  case 'voyage-v1':
    return {
      model,
      query: stringInput(request.query),
      documents: strings,
      ...(request.topN === undefined ? {} : { top_k: request.topN }),
      ...(request.returnDocuments === undefined ? {} : { return_documents: request.returnDocuments }),
      ...(request.truncation === undefined ? {} : { truncation: request.truncation }),
    };
  case 'dashscope-compatible':
    return {
      model,
      query: stringInput(request.query),
      documents: strings,
      ...(request.topN === undefined ? {} : { top_n: request.topN }),
    };
  case 'dashscope-native': {
    const parameters = {
      ...(request.topN === undefined ? {} : { top_n: request.topN }),
      ...(request.returnDocuments === undefined ? {} : { return_documents: request.returnDocuments }),
    };
    return {
      model,
      input: { query: request.query, documents: request.documents },
      ...(Object.keys(parameters).length === 0 ? {} : { parameters }),
    };
  }
  }
};

const invalidResponse = (message: string): Result<never, Error> => ({ ok: false, error: new Error(message) });

const resultItem = (value: unknown, field: string): Result<CanonicalRerankResult, Error> => {
  if (!isRecord(value)) return invalidResponse(`${field} must be an object`);
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0) return invalidResponse(`${field}.index must be a non-negative integer`);
  if (typeof value.relevance_score !== 'number' || !Number.isFinite(value.relevance_score)) return invalidResponse(`${field}.relevance_score must be a finite number`);
  const { document, embedding } = value;
  if (embedding != null && (!Array.isArray(embedding) || embedding.some(item => typeof item !== 'number' || !Number.isFinite(item)))) {
    return invalidResponse(`${field}.embedding must be an array of finite numbers`);
  }
  if (document != null && typeof document !== 'string' && !isRecord(document)) return invalidResponse(`${field}.document must be a string or an object`);
  return {
    ok: true,
    value: {
      index: value.index,
      relevanceScore: value.relevance_score,
      ...(document == null ? {} : { document }),
      ...(embedding == null ? {} : { embedding: embedding as number[] }),
    },
  };
};

const resultsArray = (value: unknown, field: string): Result<CanonicalRerankResult[], Error> => {
  if (!Array.isArray(value)) return invalidResponse(`${field} must be an array`);
  const results: CanonicalRerankResult[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = resultItem(item, `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    results.push(parsed.value);
  }
  return { ok: true, value: results };
};

const requiredTotalTokensFrom = (value: unknown): Result<number, string> => {
  if (!isRecord(value) || typeof value.total_tokens !== 'number' || !Number.isFinite(value.total_tokens)) {
    return { ok: false, error: 'usage.total_tokens must be a finite number' };
  }
  const totalTokens = value.total_tokens;
  if (totalTokens < 0) return { ok: false, error: 'usage.total_tokens must not be negative' };
  return { ok: true, value: totalTokens };
};

const optionalRecord = (value: unknown, field: string): Result<Record<string, unknown> | undefined, string> => {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!isRecord(value)) return { ok: false, error: `${field} must be an object or null` };
  return { ok: true, value };
};

const cohereUsage = (meta: unknown): Result<Pick<CanonicalRerankResponse, 'totalTokens' | 'searchUnits'>, string> => {
  const metadata = optionalRecord(meta, 'meta');
  if (!metadata.ok) return metadata;
  if (metadata.value === undefined) return { ok: true, value: {} };
  const billedUnits = optionalRecord(metadata.value.billed_units, 'meta.billed_units');
  if (!billedUnits.ok) return billedUnits;
  const tokens = optionalRecord(metadata.value.tokens, 'meta.tokens');
  if (!tokens.ok) return tokens;
  const searchUnits = optionalFiniteNumber(billedUnits.value?.search_units ?? undefined, 'meta.billed_units.search_units');
  if (!searchUnits.ok) return searchUnits;
  const inputTokens = optionalFiniteNumber(tokens.value?.input_tokens ?? undefined, 'meta.tokens.input_tokens');
  if (!inputTokens.ok) return inputTokens;
  if (searchUnits.value !== undefined && searchUnits.value < 0) return { ok: false, error: 'meta.billed_units.search_units must not be negative' };
  if (inputTokens.value !== undefined && inputTokens.value < 0) return { ok: false, error: 'meta.tokens.input_tokens must not be negative' };
  return {
    ok: true,
    value: {
      ...(inputTokens.value === undefined ? {} : { totalTokens: inputTokens.value }),
      ...(searchUnits.value === undefined ? {} : { searchUnits: searchUnits.value }),
    },
  };
};

export const parseRerankUsage = (
  protocol: RerankProtocol,
  value: unknown,
): Result<Pick<CanonicalRerankResponse, 'totalTokens' | 'searchUnits'>, string> => {
  if (!isRecord(value)) return { ok: true, value: {} };
  switch (protocol) {
  case 'cohere-v1':
  case 'cohere-v2':
    return cohereUsage(value.meta);
  case 'jina-v1':
  case 'voyage-v1':
  case 'dashscope-compatible':
  case 'dashscope-native': {
    if (value.usage === undefined) return { ok: true, value: {} };
    const totalTokens = requiredTotalTokensFrom(value.usage);
    if (!totalTokens.ok) return totalTokens;
    return { ok: true, value: { totalTokens: totalTokens.value } };
  }
  }
};

export const parseRerankResponse = (protocol: RerankProtocol, value: unknown): Result<CanonicalRerankResponse, Error> => {
  if (!isRecord(value)) return invalidResponse('Rerank response body must be an object');
  const usage = parseRerankUsage(protocol, value);
  if (!usage.ok) return invalidResponse(usage.error);
  let model: string | undefined;
  let id: string | undefined;
  let results: Result<CanonicalRerankResult[], Error>;
  switch (protocol) {
  case 'cohere-v1':
  case 'cohere-v2':
    if (typeof value.id === 'string') id = value.id;
    results = resultsArray(value.results, 'results');
    break;
  case 'jina-v1':
  case 'voyage-v1':
  case 'dashscope-compatible':
    if (value.object !== 'list') return invalidResponse('object must be "list"');
    if (typeof value.model !== 'string' || value.model.length === 0) return invalidResponse('model must be a non-empty string');
    model = value.model;
    if (protocol === 'dashscope-compatible') {
      if (typeof value.id !== 'string' || value.id.length === 0) return invalidResponse('id must be a non-empty string');
      id = value.id;
    }
    results = protocol === 'voyage-v1' ? resultsArray(value.data, 'data') : resultsArray(value.results, 'results');
    break;
  case 'dashscope-native':
    if (!isRecord(value.output)) return invalidResponse('output must be an object');
    if (typeof value.request_id !== 'string' || value.request_id.length === 0) return invalidResponse('request_id must be a non-empty string');
    id = value.request_id;
    results = resultsArray(value.output.results, 'output.results');
    break;
  }
  if (!results.ok) return results;
  return {
    ok: true,
    value: {
      targetProtocol: protocol,
      raw: value,
      ...usage.value,
      ...(id === undefined ? {} : { id }),
      ...(model === undefined ? {} : { model }),
      results: results.value,
    },
  };
};

const sourceDocument = (request: CanonicalRerankRequest, result: CanonicalRerankResult): RerankInput => {
  const source = request.documents[result.index];
  if (source === undefined) throw new Error(`Rerank response result index ${result.index} is outside the request documents array`);
  return source;
};

const cohereDocument = (document: RerankInput): Record<string, unknown> =>
  typeof document === 'string' ? { text: document } : document;

const renderedCohereMeta = (response: CanonicalRerankResponse): Record<string, unknown> =>
  response.searchUnits === undefined && response.totalTokens === undefined
    ? {}
    : {
        meta: {
          ...(response.searchUnits === undefined ? {} : { billed_units: { search_units: response.searchUnits } }),
          ...(response.totalTokens === undefined ? {} : { tokens: { input_tokens: response.totalTokens } }),
        },
      };

export const renderRerankResponse = (
  sourceProtocol: RerankSourceProtocol,
  targetProtocol: RerankProtocol,
  response: CanonicalRerankResponse,
  request: CanonicalRerankRequest,
): Record<string, unknown> => {
  if (sourceProtocol === targetProtocol) return response.raw;
  switch (sourceProtocol) {
  case 'cohere-v1':
    return {
      ...(response.id === undefined ? {} : { id: response.id }),
      results: response.results.map(result => ({
        index: result.index,
        relevance_score: result.relevanceScore,
        ...(request.returnDocuments === true ? { document: cohereDocument(sourceDocument(request, result)) } : {}),
      })),
      ...renderedCohereMeta(response),
    };
  case 'cohere-v2':
    return {
      ...(response.id === undefined ? {} : { id: response.id }),
      results: response.results.map(result => ({ index: result.index, relevance_score: result.relevanceScore })),
      ...renderedCohereMeta(response),
    };
  case 'jina-v1':
    return {
      model: response.model ?? request.raw.model,
      object: 'list',
      ...(response.totalTokens === undefined ? {} : { usage: { total_tokens: response.totalTokens } }),
      results: response.results.map(result => ({
        index: result.index,
        relevance_score: result.relevanceScore,
        ...(request.returnDocuments === true ? { document: sourceDocument(request, result) } : {}),
        ...(result.embedding === undefined ? {} : { embedding: result.embedding }),
      })),
    };
  case 'voyage-v1':
    return {
      object: 'list',
      model: response.model ?? request.raw.model,
      ...(response.totalTokens === undefined ? {} : { usage: { total_tokens: response.totalTokens } }),
      data: response.results.map(result => ({
        index: result.index,
        relevance_score: result.relevanceScore,
        ...(request.returnDocuments === true ? { document: stringInput(sourceDocument(request, result)) } : {}),
      })),
    };
  }
};
