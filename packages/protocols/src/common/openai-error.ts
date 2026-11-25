import { isJsonObject } from './json.ts';

export interface OpenAIErrorFields {
  readonly type?: string;
  readonly code?: string | null;
  readonly param?: string | null;
  readonly provider_specific_fields?: Readonly<Record<string, unknown>>;
}

// https://developers.openai.com/api/docs/guides/error-codes#api-errors
export const formatOpenAIError = (
  _status: number | null,
  message: string,
  fields: OpenAIErrorFields = { type: 'api_error' },
) => ({ error: { message, ...fields } });

export const isOpenAIErrorPayload = (value: unknown): value is { readonly error: { readonly message: string } } =>
  isJsonObject(value) && isJsonObject(value.error) && typeof value.error.message === 'string';
