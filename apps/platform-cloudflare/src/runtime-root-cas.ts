// workerd does not expose its trust store to userspace — the runtime's
// own `cloudflare:sockets` TLS consults Cloudflare's internal CA list but
// nothing about that set is reachable from a Worker, so this list is empty.
export const cloudflareRuntimeRootCAs: readonly string[] = [];
