import { encodeHex } from '../common/base-encoding.ts';

// Anthropic identifies a message with `msg_` and a request with `req_`,
// followed by an opaque token. Bodies that no upstream produced — a
// gateway-synthesized error envelope, a turn a gateway answered itself — still
// have to carry those fields, so their ids are generated here rather than
// bridged from an upstream: by construction they name something that never
// reached one. 12 random bytes render as the 24-character token length
// Anthropic emits.
// https://platform.claude.com/docs/en/api/messages
export const generateAnthropicId = (prefix: 'msg' | 'req'): string => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${encodeHex(bytes)}`;
};
