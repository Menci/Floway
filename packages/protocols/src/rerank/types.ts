import type { RerankSourceProtocol } from '../common/models.ts';

export type RerankInput = string | Record<string, unknown>;

export interface CanonicalRerankRequest {
  sourceProtocol: RerankSourceProtocol;
  raw: Record<string, unknown>;
  query: RerankInput;
  documents: RerankInput[];
  topN?: number;
  returnDocuments?: boolean;
  rankFields?: string[];
  maxChunksPerDocument?: number;
  maxTokensPerDocument?: number;
  priority?: number;
  truncation?: boolean;
  maxDocumentLength?: number;
  returnEmbeddings?: boolean;
}

export interface CanonicalRerankResult {
  index: number;
  relevanceScore: number;
  document?: RerankInput;
  embedding?: number[];
}

export interface CanonicalRerankResponse {
  raw: Record<string, unknown>;
  id?: string;
  model?: string;
  results: CanonicalRerankResult[];
  totalTokens?: number;
  searchUnits?: number;
}

export interface ParsedRerankRequest {
  model: string;
  request: CanonicalRerankRequest;
}
