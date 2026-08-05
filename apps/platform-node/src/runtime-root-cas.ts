import tls from 'node:tls';

// The default set includes Node's bundled roots, NODE_EXTRA_CA_CERTS, and the
// system store when the process enables --use-system-ca. This keeps userspace
// proxy TLS on the same trust policy as Node's native TLS clients.
// https://nodejs.org/api/tls.html#tlsgetcacertificatestype
export const nodeRuntimeRootCAs: readonly string[] = tls.getCACertificates('default');
