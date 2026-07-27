import tls from 'node:tls';

// `tls.rootCertificates` is Node's bundled Mozilla CA list, shipped in
// lockstep with the Node release. It excludes certificates loaded through
// `NODE_EXTRA_CA_CERTS`.
export const nodeRuntimeRootCAs: readonly string[] = tls.rootCertificates;
