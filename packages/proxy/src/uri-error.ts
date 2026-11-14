/**
 * URI parser failures. Distinct from `ProxyDialError` because URI parsing
 * runs ahead of any dial — there is no stage taxonomy that applies.
 */
export class ProxyUriError extends Error {
  override readonly name = 'ProxyUriError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
