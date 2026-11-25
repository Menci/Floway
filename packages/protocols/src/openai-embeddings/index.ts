export interface OpenAIEmbeddingsPayload {
  model: string;
  input?: unknown;
  [key: string]: unknown;
}

export { formatOpenAIError as formatOpenAIEmbeddingsError } from '../common/openai-error.ts';
