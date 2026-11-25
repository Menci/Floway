// workerd marks a disconnected network operation retryable when it becomes a JS Error.
// https://github.com/cloudflare/workerd/blob/c889d1dd2322420cb5c58740dc28ab20b6a7f681/src/workerd/jsg/util.c%2B%2B#L324-L338
export const isCloudflareNetworkFailure = (cause: unknown): boolean => cause instanceof Error
  && Object.getPrototypeOf(cause) === Error.prototype
  && cause.message === 'Network connection lost.'
  && Object.hasOwn(cause, 'retryable')
  && (cause as Error & { retryable: unknown }).retryable === true;
