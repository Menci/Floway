// Anthropic-shaped opaque ids (`msg_` / `req_` + 24 hex chars) for bodies no
// upstream produced: the synthetic `request_id` on a gateway-synthesized error
// envelope, and the message id on a gateway-answered turn. 24 chars off
// crypto.randomUUID carry ~90 bits of entropy (the UUIDv4 version nibble is
// fixed and the variant nibble constrained), plenty for an opaque per-request
// id. We never bridge these to an upstream id — by construction they name
// something that never reached one.
export const mintAnthropicId = (prefix: 'msg' | 'req'): string =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
