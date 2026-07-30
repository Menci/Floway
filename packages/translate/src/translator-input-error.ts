// A caller-input validation failure surfaced by a translator: the caller
// sent something the target protocol cannot represent (an unsupported
// content-part type, a role the target does not accept, a missing field
// the target requires, etc.). Distinct from a plain `Error` so the
// data-plane http handlers can return a protocol-shaped 400 envelope
// instead of routing the failure through the generic internal-error 502
// path. The optional `param` and `code` follow the OpenAI / Anthropic
// error-body convention.
export class TranslatorInputError extends Error {
  readonly param: string | undefined;
  readonly code: string | undefined;

  constructor(message: string, options?: { param?: string; code?: string }) {
    super(message);
    this.name = 'TranslatorInputError';
    this.param = options?.param;
    this.code = options?.code;
  }
}
