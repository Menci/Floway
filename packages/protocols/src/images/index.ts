// JSON payload accepted by POST /v1/images/generations. Field set follows
// OpenAI's reference for gpt-image-* and legacy dall-e-* (dall-e is
// retired but the union shape is harmless). Kept open via an intersection
// with `Record<string, unknown>` so future OpenAI additions flow through
// without a gateway-side reject — using an interface index signature here
// would widen every typed field to `unknown` on read. /v1/images/edits is
// multipart and has no JSON payload type — its source serve handles
// `FormData` directly.
export type ImagesGenerationsPayload = {
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
} & Record<string, unknown>;
