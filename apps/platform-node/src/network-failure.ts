export interface NodeSocketFailure extends Error {
  code: string;
  syscall: string;
  errno: number;
}

export const isNodeSocketFailure = (failure: unknown): failure is NodeSocketFailure => {
  if (!(failure instanceof Error)) return false;
  const { code, syscall, errno } = failure as Partial<NodeSocketFailure>;
  if (typeof errno !== 'number') return false;
  // TCP errors retain the operation that surfaced the failure.
  // https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/lib/net.js
  // https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/lib/internal/stream_base_commons.js
  switch (syscall) {
  case 'connect': return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT'
    || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL';
  case 'read': return code === 'ECONNRESET' || code === 'ETIMEDOUT';
  case 'write': return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
  // https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/lib/dns.js
  case 'getaddrinfo': return code === 'ENOTFOUND' || code === 'EAI_AGAIN';
  default: return false;
  }
};

export const isNodeTlsFailure = (failure: unknown): boolean => {
  if (!(failure instanceof Error) || !('code' in failure)) return false;
  const { code } = failure;
  if (typeof code !== 'string') return false;
  // Node's TLS handshake exposes OpenSSL's error codes, plus Node's own
  // authentication and handshake failures.
  // https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/lib/_tls_wrap.js
  // https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/src/crypto/crypto_tls.cc
  return code.startsWith('ERR_SSL_') || code === 'ERR_TLS_CERT_ALTNAME_INVALID'
    || code === 'ERR_TLS_HANDSHAKE_TIMEOUT' || code === 'ECONNRESET'
    || code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID'
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || code === 'UNABLE_TO_GET_ISSUER_CERT' || code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
    || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'CERT_REVOKED';
};

export const isNodeConnectFailure = (failure: unknown): boolean => failure instanceof AggregateError
  ? failure.errors.length > 0 && failure.errors.every(isNodeConnectFailure)
  : isNodeSocketFailure(failure) || isNodeTlsFailure(failure);
