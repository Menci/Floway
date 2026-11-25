export interface NodeSocketFailure extends Error {
  code: string;
  syscall: string;
  errno: number;
}

export const isNodeSocketFailure = (failure: unknown): failure is NodeSocketFailure => {
  if (!(failure instanceof Error)) return false;
  const { code, syscall, errno } = failure as Partial<NodeSocketFailure>;
  if (typeof errno !== 'number' || typeof code !== 'string') return false;
  // Node TCP system errors retain the operation that surfaced the failure.
  // https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/lib/net.js
  // https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/lib/internal/stream_base_commons.js
  switch (syscall) {
  case 'connect': return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT';
  case 'read': return code === 'ECONNRESET';
  case 'write': return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
  // https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/lib/dns.js
  case 'getaddrinfo': return code === 'ENOTFOUND' || code === 'EAI_AGAIN';
  default: return false;
  }
};
