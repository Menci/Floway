import type { ParsedRerankRequest, CanonicalRerankRequest, CanonicalRerankResponse, CanonicalRerankResult, RerankInput } from './types.ts';
import type { RerankProtocol, RerankSourceProtocol } from '../common/models.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
};

const optionalBoolean = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
};

const optionalNullableBoolean = (value: unknown, field: string): boolean | undefined =>
  value === null ? undefined : optionalBoolean(value, field);

const optionalFiniteNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
};

const optionalNullableFiniteNumber = (value: unknown, field: string): number | undefined =>
  value === null ? undefined : optionalFiniteNumber(value, field);

const optionalPositiveInteger = (value: unknown, field: string): number | undefined => {
  const number = optionalFiniteNumber(value, field);
  if (number !== undefined && (!Number.isInteger(number) || number < 1)) throw new Error(`${field} must be a positive integer`);
  return number;
};

const optionalNullablePositiveInteger = (value: unknown, field: string): number | undefined =>
  value === null ? undefined : optionalPositiveInteger(value, field);

const optionalInteger = (value: unknown, field: string): number | undefined => {
  const number = optionalFiniteNumber(value, field);
  if (number !== undefined && !Number.isInteger(number)) throw new Error(`${field} must be an integer`);
  return number;
};

const stringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string')) {
    throw new Error(`${field} must be a non-empty array of strings`);
  }
  return value as string[];
};

const stringRecord = (value: unknown, field: string): Record<string, string> => {
  if (!isRecord(value) || Object.values(value).some(item => typeof item !== 'string')) {
    throw new Error(`${field} must be a string or an object whose values are strings`);
  }
  return value as Record<string, string>;
};

const cohereV1Documents = (value: unknown): RerankInput[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error('documents must be a non-empty array');
  return value.map((document, index) => typeof document === 'string' ? document : stringRecord(document, `documents[${index}]`));
};

const jinaStructuredInput = (value: unknown, field: string, keys: readonly ('text' | 'image')[]): RerankInput => {
  if (typeof value === 'string') return value;
  if (!isRecord(value) || !keys.some(key => typeof value[key] === 'string')) {
    throw new Error(`${field} must be a string or an object with a string ${keys.join(' or ')} field`);
  }
  return value;
};

const jinaDocuments = (value: unknown): RerankInput[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error('documents must be a non-empty array');
  return value.map((document, index) => jinaStructuredInput(document, `documents[${index}]`, ['text', 'image']));
};

const baseRequest = (body: Record<string, unknown>, sourceProtocol: RerankSourceProtocol): Omit<CanonicalRerankRequest, 'query' | 'documents'> => ({
  sourceProtocol,
  raw: body,
});

const rejectFields = (body: Record<string, unknown>, protocol: RerankSourceProtocol, fields: readonly string[]): void => {
  const unsupported = fields.filter(field => body[field] !== undefined);
  if (unsupported.length > 0) throw new Error(`${protocol} does not support ${unsupported.join(', ')}`);
};

export const parseRerankRequest = (protocol: RerankSourceProtocol, value: unknown): ParsedRerankRequest => {
  if (!isRecord(value)) throw new Error('Rerank request body must be an object');
  const model = requiredString(value.model, 'model');
  switch (protocol) {
  case 'cohere-v1': {
    rejectFields(value, protocol, ['max_tokens_per_doc', 'priority', 'top_k']);
    const rankFields = value.rank_fields === undefined ? undefined : stringArray(value.rank_fields, 'rank_fields');
    const topN = optionalPositiveInteger(value.top_n, 'top_n');
    const returnDocuments = optionalBoolean(value.return_documents, 'return_documents');
    const maxChunksPerDocument = optionalPositiveInteger(value.max_chunks_per_doc, 'max_chunks_per_doc');
    return {
      model,
      request: {
        ...baseRequest(value, protocol),
        query: requiredString(value.query, 'query'),
        documents: cohereV1Documents(value.documents),
        ...(topN === undefined ? {} : { topN }),
        ...(rankFields === undefined ? {} : { rankFields }),
        ...(returnDocuments === undefined ? {} : { returnDocuments }),
        ...(maxChunksPerDocument === undefined ? {} : { maxChunksPerDocument }),
      },
    };
  }
  case 'cohere-v2': {
    rejectFields(value, protocol, ['rank_fields', 'return_documents', 'max_chunks_per_doc', 'top_k']);
    const topN = optionalPositiveInteger(value.top_n, 'top_n');
    const maxTokensPerDocument = optionalPositiveInteger(value.max_tokens_per_doc, 'max_tokens_per_doc');
    const priority = optionalInteger(value.priority, 'priority');
    return {
      model,
      request: {
        ...baseRequest(value, protocol),
        query: requiredString(value.query, 'query'),
        documents: stringArray(value.documents, 'documents'),
        ...(topN === undefined ? {} : { topN }),
        ...(maxTokensPerDocument === undefined ? {} : { maxTokensPerDocument }),
        ...(priority === undefined ? {} : { priority }),
      },
    };
  }
  case 'jina-v1': {
    rejectFields(value, protocol, ['top_k', 'rank_fields', 'max_chunks_per_doc', 'max_tokens_per_doc', 'priority']);
    // Jina returns documents unless explicitly disabled. Its live OpenAPI is
    // the authority for the model-discriminated text and multimodal inputs:
    // https://api.jina.ai/openapi.json
    const returnDocuments = optionalNullableBoolean(value.return_documents, 'return_documents') ?? true;
    const topN = optionalNullablePositiveInteger(value.top_n, 'top_n');
    const truncation = optionalNullableBoolean(value.truncation, 'truncation');
    const maxDocumentLength = optionalPositiveInteger(value.max_doc_length, 'max_doc_length');
    const returnEmbeddings = optionalNullableBoolean(value.return_embeddings, 'return_embeddings');
    return {
      model,
      request: {
        ...baseRequest(value, protocol),
        query: jinaStructuredInput(value.query, 'query', ['image']),
        documents: jinaDocuments(value.documents),
        ...(topN === undefined ? {} : { topN }),
        returnDocuments,
        ...(truncation === undefined ? {} : { truncation }),
        ...(maxDocumentLength === undefined ? {} : { maxDocumentLength }),
        ...(returnEmbeddings === undefined ? {} : { returnEmbeddings }),
      },
    };
  }
  case 'voyage-v1': {
    rejectFields(value, protocol, ['top_n', 'rank_fields', 'max_chunks_per_doc', 'max_tokens_per_doc', 'priority', 'max_doc_length', 'return_embeddings']);
    // Voyage REST defaults return_documents=false and truncation=true:
    // https://docs.voyageai.com/reference/reranker-api.md
    const returnDocuments = optionalBoolean(value.return_documents, 'return_documents') ?? false;
    const truncation = optionalBoolean(value.truncation, 'truncation') ?? true;
    const topN = optionalNullablePositiveInteger(value.top_k, 'top_k');
    return {
      model,
      request: {
        ...baseRequest(value, protocol),
        query: requiredString(value.query, 'query'),
        documents: stringArray(value.documents, 'documents'),
        ...(topN === undefined ? {} : { topN }),
        returnDocuments,
        truncation,
      },
    };
  }
  }
};

const stringInput = (input: RerankInput): string => {
  if (typeof input === 'string') return input;
  return typeof input.text === 'string' ? input.text : JSON.stringify(input);
};

export const DEFAULT_RERANK_PATHS: Readonly<Record<RerankProtocol, string>> = {
  // Cohere SDK source: https://github.com/cohere-ai/cohere-python/blob/41f344bde2b195e0a7e51d259f4b3701e62605b5/src/cohere/raw_base_client.py#L1837-L1908
  'cohere-v1': '/v1/rerank',
  // Cohere SDK source: https://github.com/cohere-ai/cohere-python/blob/41f344bde2b195e0a7e51d259f4b3701e62605b5/src/cohere/v2/raw_client.py#L985-L1048
  'cohere-v2': '/v2/rerank',
  // Jina live OpenAPI: https://api.jina.ai/openapi.json
  'jina-v1': '/v1/rerank',
  // Voyage REST reference: https://docs.voyageai.com/reference/reranker-api.md
  'voyage-v1': '/v1/rerank',
  // DashScope compatible and native structures are deliberately separate:
  // https://help.aliyun.com/zh/model-studio/text-rerank-api
  'dashscope-compatible': '/compatible-api/v1/reranks',
  // DashScope SDK test pins both this path and the nested request body:
  // https://github.com/dashscope/dashscope-sdk-python/blob/f974f108526e87326b2b755b1586054d77a26679/tests/unit/test_rerank.py#L48-L65
  'dashscope-native': '/api/v1/services/rerank/text-rerank/text-rerank',
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

const optionalEmbedding = (value: unknown, field: string): number[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new Error(`${field} must be an array of finite numbers`);
  }
  return value as number[];
};

const resultDocument = (value: unknown, field: string): RerankInput => {
  if (typeof value === 'string' || isRecord(value)) return value;
  throw new Error(`${field} must be a string or an object`);
};

const resultItem = (value: unknown, field: string): CanonicalRerankResult => {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0) throw new Error(`${field}.index must be a non-negative integer`);
  if (typeof value.relevance_score !== 'number' || !Number.isFinite(value.relevance_score)) throw new Error(`${field}.relevance_score must be a finite number`);
  const embedding = optionalEmbedding(value.embedding, `${field}.embedding`);
  return {
    index: value.index,
    relevanceScore: value.relevance_score,
    ...(value.document === undefined || value.document === null ? {} : { document: resultDocument(value.document, `${field}.document`) }),
    ...(embedding === undefined ? {} : { embedding }),
  };
};

const resultsArray = (value: unknown, field: string): CanonicalRerankResult[] => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => resultItem(item, `${field}[${index}]`));
};

const requiredTotalTokensFrom = (value: unknown): number => {
  if (!isRecord(value) || typeof value.total_tokens !== 'number' || !Number.isFinite(value.total_tokens)) {
    throw new Error('usage.total_tokens must be a finite number');
  }
  const totalTokens = value.total_tokens;
  if (totalTokens < 0) throw new Error('usage.total_tokens must not be negative');
  return totalTokens;
};

const optionalUsage = (
  value: Record<string, unknown>,
  parser: (usage: unknown) => number,
): Pick<CanonicalRerankResponse, 'totalTokens'> =>
  value.usage === undefined ? {} : { totalTokens: parser(value.usage) };

const listEnvelopeModel = (value: Record<string, unknown>): string => {
  if (value.object !== 'list') throw new Error('object must be "list"');
  return requiredString(value.model, 'model');
};

const optionalRecord = (value: unknown, field: string): Record<string, unknown> | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object or null`);
  return value;
};

const cohereUsage = (meta: unknown): Pick<CanonicalRerankResponse, 'totalTokens' | 'searchUnits'> => {
  const metadata = optionalRecord(meta, 'meta');
  if (metadata === undefined) return {};
  const billedUnits = optionalRecord(metadata.billed_units, 'meta.billed_units');
  const tokens = optionalRecord(metadata.tokens, 'meta.tokens');
  const searchUnits = optionalNullableFiniteNumber(billedUnits?.search_units, 'meta.billed_units.search_units');
  const inputTokens = optionalNullableFiniteNumber(tokens?.input_tokens, 'meta.tokens.input_tokens');
  if (searchUnits !== undefined && searchUnits < 0) throw new Error('meta.billed_units.search_units must not be negative');
  if (inputTokens !== undefined && inputTokens < 0) throw new Error('meta.tokens.input_tokens must not be negative');
  return {
    ...(inputTokens === undefined ? {} : { totalTokens: inputTokens }),
    ...(searchUnits === undefined ? {} : { searchUnits }),
  };
};

export const parseRerankUsage = (
  protocol: RerankProtocol,
  value: unknown,
): Pick<CanonicalRerankResponse, 'totalTokens' | 'searchUnits'> => {
  if (!isRecord(value)) return {};
  switch (protocol) {
  case 'cohere-v1':
  case 'cohere-v2':
    return cohereUsage(value.meta);
  case 'jina-v1':
  case 'voyage-v1':
  case 'dashscope-compatible':
  case 'dashscope-native':
    return optionalUsage(value, requiredTotalTokensFrom);
  }
};

export const parseRerankResponse = (protocol: RerankProtocol, value: unknown): CanonicalRerankResponse => {
  if (!isRecord(value)) throw new Error('Rerank response body must be an object');
  const usage = parseRerankUsage(protocol, value);
  switch (protocol) {
  case 'cohere-v1':
  case 'cohere-v2':
    return {
      raw: value,
      ...(typeof value.id === 'string' ? { id: value.id } : {}),
      results: resultsArray(value.results, 'results'),
      ...usage,
    };
  case 'jina-v1': {
    const model = listEnvelopeModel(value);
    return {
      raw: value,
      model,
      results: resultsArray(value.results, 'results'),
      ...usage,
    };
  }
  case 'voyage-v1': {
    const model = listEnvelopeModel(value);
    return {
      raw: value,
      model,
      results: resultsArray(value.data, 'data'),
      ...usage,
    };
  }
  case 'dashscope-compatible': {
    const model = listEnvelopeModel(value);
    return {
      raw: value,
      id: requiredString(value.id, 'id'),
      model,
      results: resultsArray(value.results, 'results'),
      ...usage,
    };
  }
  case 'dashscope-native': {
    if (!isRecord(value.output)) throw new Error('output must be an object');
    return {
      raw: value,
      id: requiredString(value.request_id, 'request_id'),
      results: resultsArray(value.output.results, 'output.results'),
      ...usage,
    };
  }
  }
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
