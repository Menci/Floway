import type { ParsedRerankRequest, CanonicalRerankRequest, CanonicalRerankResponse, CanonicalRerankResult, RerankInput } from './types.ts';
import type { RerankProtocol } from '../common/models.ts';

type InboundRerankProtocol = Exclude<RerankProtocol, 'dashscope-compatible' | 'dashscope-native'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
};

const optionalBoolean = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
};

const optionalFiniteNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
};

const optionalPositiveInteger = (value: unknown, field: string): number | undefined => {
  const number = optionalFiniteNumber(value, field);
  if (number !== undefined && (!Number.isInteger(number) || number < 1)) throw new Error(`${field} must be a positive integer`);
  return number;
};

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

const jinaInput = (value: unknown, field: string): RerankInput => {
  if (typeof value === 'string') return value;
  if (!isRecord(value) || Object.keys(value).length === 0) throw new Error(`${field} must be a string or a non-empty input object`);
  return value;
};

const jinaDocuments = (value: unknown): RerankInput[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error('documents must be a non-empty array');
  return value.map((document, index) => jinaInput(document, `documents[${index}]`));
};

const baseRequest = (body: Record<string, unknown>, sourceProtocol: InboundRerankProtocol): Omit<CanonicalRerankRequest, 'query' | 'documents'> => ({
  sourceProtocol,
  raw: body,
});

const rejectFields = (body: Record<string, unknown>, protocol: InboundRerankProtocol, fields: readonly string[]): void => {
  const unsupported = fields.filter(field => body[field] !== undefined);
  if (unsupported.length > 0) throw new Error(`${protocol} does not support ${unsupported.join(', ')}`);
};

export const parseRerankRequest = (protocol: InboundRerankProtocol, value: unknown): ParsedRerankRequest => {
  if (!isRecord(value)) throw new Error('Rerank request body must be an object');
  const model = requiredString(value.model, 'model');
  switch (protocol) {
  case 'cohere-v1': {
    rejectFields(value, protocol, ['max_tokens_per_doc', 'priority', 'top_k']);
    const rankFields = value.rank_fields === undefined ? undefined : stringArray(value.rank_fields, 'rank_fields');
    return {
      model,
      request: {
        ...baseRequest(value, protocol),
        query: requiredString(value.query, 'query'),
        documents: cohereV1Documents(value.documents),
        ...(optionalPositiveInteger(value.top_n, 'top_n') === undefined ? {} : { topN: value.top_n as number }),
        ...(rankFields === undefined ? {} : { rankFields }),
        ...(optionalBoolean(value.return_documents, 'return_documents') === undefined ? {} : { returnDocuments: value.return_documents as boolean }),
        ...(optionalPositiveInteger(value.max_chunks_per_doc, 'max_chunks_per_doc') === undefined ? {} : { maxChunksPerDocument: value.max_chunks_per_doc as number }),
      },
    };
  }
  case 'cohere-v2':
    rejectFields(value, protocol, ['rank_fields', 'return_documents', 'max_chunks_per_doc', 'top_k']);
    return {
      model,
      request: {
        ...baseRequest(value, protocol),
        query: requiredString(value.query, 'query'),
        documents: stringArray(value.documents, 'documents'),
        ...(optionalPositiveInteger(value.top_n, 'top_n') === undefined ? {} : { topN: value.top_n as number }),
        ...(optionalPositiveInteger(value.max_tokens_per_doc, 'max_tokens_per_doc') === undefined ? {} : { maxTokensPerDocument: value.max_tokens_per_doc as number }),
        ...(optionalInteger(value.priority, 'priority') === undefined ? {} : { priority: value.priority as number }),
      },
    };
  case 'jina-v1': {
    rejectFields(value, protocol, ['top_k', 'rank_fields', 'max_chunks_per_doc', 'max_tokens_per_doc', 'priority']);
    // Jina returns documents unless explicitly disabled. Its live OpenAPI is
    // the authority for the model-discriminated text and multimodal inputs:
    // https://api.jina.ai/openapi.json
    const returnDocuments = optionalBoolean(value.return_documents, 'return_documents') ?? true;
    return {
      model,
      request: {
        ...baseRequest(value, protocol),
        query: jinaInput(value.query, 'query'),
        documents: jinaDocuments(value.documents),
        ...(optionalPositiveInteger(value.top_n, 'top_n') === undefined ? {} : { topN: value.top_n as number }),
        returnDocuments,
        ...(optionalBoolean(value.truncation, 'truncation') === undefined ? {} : { truncation: value.truncation as boolean }),
        ...(optionalPositiveInteger(value.max_doc_length, 'max_doc_length') === undefined ? {} : { maxDocumentLength: value.max_doc_length as number }),
        ...(optionalBoolean(value.return_embeddings, 'return_embeddings') === undefined ? {} : { returnEmbeddings: value.return_embeddings as boolean }),
      },
    };
  }
  case 'voyage-v1': {
    rejectFields(value, protocol, ['top_n', 'rank_fields', 'max_chunks_per_doc', 'max_tokens_per_doc', 'priority', 'max_doc_length', 'return_embeddings']);
    // Voyage REST defaults return_documents=false and truncation=true:
    // https://docs.voyageai.com/reference/reranker-api.md
    const returnDocuments = optionalBoolean(value.return_documents, 'return_documents') ?? false;
    const truncation = optionalBoolean(value.truncation, 'truncation') ?? true;
    return {
      model,
      request: {
        ...baseRequest(value, protocol),
        query: requiredString(value.query, 'query'),
        documents: stringArray(value.documents, 'documents'),
        ...(optionalPositiveInteger(value.top_k, 'top_k') === undefined ? {} : { topN: value.top_k as number }),
        returnDocuments,
        truncation,
      },
    };
  }
  }
};

const stringInput = (input: RerankInput): string => typeof input === 'string' ? input : JSON.stringify(input);

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

export const serializeRerankRequest = (
  protocol: RerankProtocol,
  model: string,
  request: CanonicalRerankRequest,
): Record<string, unknown> => {
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
      ...(request.instruct === undefined ? {} : { instruct: request.instruct }),
    };
  case 'dashscope-native':
    return {
      model,
      input: { query: request.query, documents: request.documents },
      parameters: {
        ...(request.topN === undefined ? {} : { top_n: request.topN }),
        ...(request.returnDocuments === undefined ? {} : { return_documents: request.returnDocuments }),
        ...(request.instruct === undefined ? {} : { instruct: request.instruct }),
        ...(request.fps === undefined ? {} : { fps: request.fps }),
      },
    };
  }
};

const resultItem = (value: unknown, field: string): CanonicalRerankResult => {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0) throw new Error(`${field}.index must be a non-negative integer`);
  if (typeof value.relevance_score !== 'number' || !Number.isFinite(value.relevance_score)) throw new Error(`${field}.relevance_score must be a finite number`);
  const embedding = value.embedding === undefined || value.embedding === null
    ? undefined
    : Array.isArray(value.embedding) && value.embedding.every(item => typeof item === 'number' && Number.isFinite(item))
      ? value.embedding as number[]
      : (() => { throw new Error(`${field}.embedding must be an array of finite numbers`); })();
  return {
    index: value.index,
    relevanceScore: value.relevance_score,
    ...(value.document === undefined || value.document === null ? {} : { document: jinaInput(value.document, `${field}.document`) }),
    ...(embedding === undefined ? {} : { embedding }),
  };
};

const resultsArray = (value: unknown, field: string): CanonicalRerankResult[] => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => resultItem(item, `${field}[${index}]`));
};

const totalTokensFrom = (value: unknown): number | undefined => {
  if (!isRecord(value) || value.total_tokens === undefined) return undefined;
  const tokens = optionalFiniteNumber(value.total_tokens, 'usage.total_tokens');
  if (tokens !== undefined && tokens < 0) throw new Error('usage.total_tokens must not be negative');
  return tokens;
};

const requiredTotalTokensFrom = (value: unknown): number => {
  const totalTokens = totalTokensFrom(value);
  if (totalTokens === undefined) throw new Error('usage.total_tokens must be a finite number');
  return totalTokens;
};

const listEnvelopeModel = (value: Record<string, unknown>): string => {
  if (value.object !== 'list') throw new Error('object must be "list"');
  return requiredString(value.model, 'model');
};

const cohereUsage = (meta: unknown): Pick<CanonicalRerankResponse, 'totalTokens' | 'searchUnits'> => {
  if (!isRecord(meta)) return {};
  const billedUnits = isRecord(meta.billed_units) ? meta.billed_units : undefined;
  const tokens = isRecord(meta.tokens) ? meta.tokens : undefined;
  const searchUnits = billedUnits?.search_units === undefined ? undefined : optionalFiniteNumber(billedUnits.search_units, 'meta.billed_units.search_units');
  const inputTokens = tokens?.input_tokens === undefined ? undefined : optionalFiniteNumber(tokens.input_tokens, 'meta.tokens.input_tokens');
  if (searchUnits !== undefined && searchUnits < 0) throw new Error('meta.billed_units.search_units must not be negative');
  if (inputTokens !== undefined && inputTokens < 0) throw new Error('meta.tokens.input_tokens must not be negative');
  return {
    ...(inputTokens === undefined ? {} : { totalTokens: inputTokens }),
    ...(searchUnits === undefined ? {} : { searchUnits }),
  };
};

export const parseRerankResponse = (protocol: RerankProtocol, value: unknown): CanonicalRerankResponse => {
  if (!isRecord(value)) throw new Error('Rerank response body must be an object');
  switch (protocol) {
  case 'cohere-v1':
  case 'cohere-v2':
    return {
      raw: value,
      ...(typeof value.id === 'string' ? { id: value.id } : {}),
      results: resultsArray(value.results, 'results'),
      ...cohereUsage(value.meta),
    };
  case 'jina-v1': {
    const model = listEnvelopeModel(value);
    return {
      raw: value,
      model,
      results: resultsArray(value.results, 'results'),
      totalTokens: requiredTotalTokensFrom(value.usage),
    };
  }
  case 'voyage-v1': {
    const model = listEnvelopeModel(value);
    return {
      raw: value,
      model,
      results: resultsArray(value.data, 'data'),
      totalTokens: requiredTotalTokensFrom(value.usage),
    };
  }
  case 'dashscope-compatible': {
    const model = listEnvelopeModel(value);
    return {
      raw: value,
      id: requiredString(value.id, 'id'),
      model,
      results: resultsArray(value.results, 'results'),
      totalTokens: requiredTotalTokensFrom(value.usage),
    };
  }
  case 'dashscope-native': {
    if (!isRecord(value.output)) throw new Error('output must be an object');
    return {
      raw: value,
      id: requiredString(value.request_id, 'request_id'),
      results: resultsArray(value.output.results, 'output.results'),
      totalTokens: requiredTotalTokensFrom(value.usage),
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

export const renderRerankResponse = (
  sourceProtocol: InboundRerankProtocol,
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
      ...(
        response.searchUnits === undefined && response.totalTokens === undefined
          ? {}
          : { meta: {
              ...(response.searchUnits === undefined ? {} : { billed_units: { search_units: response.searchUnits } }),
              ...(response.totalTokens === undefined ? {} : { tokens: { input_tokens: response.totalTokens } }),
            } }
      ),
    };
  case 'cohere-v2':
    return {
      ...(response.id === undefined ? {} : { id: response.id }),
      results: response.results.map(result => ({ index: result.index, relevance_score: result.relevanceScore })),
      ...(
        response.searchUnits === undefined && response.totalTokens === undefined
          ? {}
          : { meta: {
              ...(response.searchUnits === undefined ? {} : { billed_units: { search_units: response.searchUnits } }),
              ...(response.totalTokens === undefined ? {} : { tokens: { input_tokens: response.totalTokens } }),
            } }
      ),
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
