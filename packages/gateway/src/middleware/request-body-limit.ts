// One buffered request may contain OpenAI's maximum 25 MB transcription plus
// multipart framing. A larger wire ceiling is unsafe in a 128 MB workerd
// isolate because parsing and optional dump compression hold additional full
// representations of the body.
// https://platform.openai.com/docs/guides/speech-to-text#overview
// https://github.com/cloudflare/cloudflare-docs/blob/92fc520c24383bcca242d7b91213a24d1f434506/src/content/docs/workers/platform/limits.mdx#L44-L64
// https://github.com/cloudflare/cloudflare-docs/blob/92fc520c24383bcca242d7b91213a24d1f434506/src/content/docs/workers/platform/limits.mdx#L119-L127
export const MAX_BUFFERED_REQUEST_BODY_BYTES = 26 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Request body exceeds Floway's ${maxBytes}-byte buffered request limit.`);
    this.name = 'RequestBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}
