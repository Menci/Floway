// JSON payload accepted by POST /v1/images/generations. Field set follows
// OpenAI's reference for gpt-image-* and legacy dall-e-* (dall-e is
// retired but the union shape is harmless). Declared as an interface with
// a trailing index signature so future OpenAI additions flow through
// without a gateway-side reject while named fields keep their narrow
// types when accessed directly — the `T & Record<string, unknown>`
// intersection form would widen every typed field to `unknown` on read.
export interface ImagesGenerationsPayload {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  output_format?: 'png' | 'jpeg' | 'webp';
  output_compression?: number;
  background?: 'transparent' | 'opaque' | 'auto';
  moderation?: 'low' | 'auto';
  response_format?: 'url' | 'b64_json';
  stream?: boolean;
  partial_images?: number;
  user?: string;
  [key: string]: unknown;
}

// POST /v1/images/edits accepts JSON references that point at a URL/data URL
// or an uploaded file.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L12558-L12620
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L47542-L47673
export type ImageEditReference =
  | { image_url: string; file_id?: never; [key: string]: unknown }
  | { file_id: string; image_url?: never; [key: string]: unknown };
