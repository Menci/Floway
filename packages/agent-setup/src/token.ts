// The lease token: 32 CSPRNG bytes as unpadded base64url — exactly 43 chars of
// that alphabet, carrying 256 bits of entropy, so a collision is a practical
// impossibility. It is the lease's primary identity and is embedded verbatim in
// the public setup-script URL.

export const AGENT_SETUP_TOKEN_LENGTH = 43;

export const generateAgentSetupToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};
