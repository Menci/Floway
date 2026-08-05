// One buffered request may contain OpenAI's maximum 25 MB transcription or a
// sub-50 MB image plus its sub-4 MB mask and multipart framing:
// https://platform.openai.com/docs/guides/speech-to-text#overview
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L44762-L44774
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L44783-L44790
// Keep that surface within a fixed allocation substantially below workerd's
// 128 MB per-isolate ceiling; Cloudflare's edge request limit alone is at least
// 100 MB and therefore does not protect the isolate from buffering:
// https://github.com/cloudflare/cloudflare-docs/blob/92fc520c24383bcca242d7b91213a24d1f434506/src/content/docs/workers/platform/limits.mdx#L44-L64
// https://github.com/cloudflare/cloudflare-docs/blob/92fc520c24383bcca242d7b91213a24d1f434506/src/content/docs/workers/platform/limits.mdx#L119-L127
export const MAX_BUFFERED_REQUEST_BODY_BYTES = 56 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Request body exceeds Floway's ${maxBytes}-byte buffered request limit.`);
    this.name = 'RequestBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}
