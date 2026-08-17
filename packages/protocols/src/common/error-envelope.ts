// What a client is sent when a run produced no answer, and how an upstream's own words are
// read out of what it sent.
//
// An upstream that refused in its own words is handed on in them — a client reads the code and
// type inside, and the gateway has nothing truer to say than what the upstream said. The test
// is only that the upstream sent a JSON object, because the families that reach here differ in
// what that object looks like — an OpenAI family's error is `{error:{...}}` and a rerank
// client's is `{message}` — and a body that is not an object at all is one no JSON protocol's
// client can read, so it falls through to the envelope.
//
// The test is deliberately not "is this the client's own protocol". It cannot be, here: this
// function is shared and does not know which client is reading. Where a body can be the *wrong*
// protocol's — a translated wire, where the upstream spoke to a different protocol than the
// client did — the handoff drops it before it ever arrives, so what reaches here is only ever a
// body the client's own protocol produced.
//
// A refusal that never reached an upstream has only the gateway's own words, and those go in
// the envelope every protocol here writes errors in.

import { isJsonObject } from './json.ts';

export const upstreamErrorMessage = (body: unknown): string | undefined => {
  if (!isJsonObject(body) || !isJsonObject(body.error)) return undefined;
  return typeof body.error.message === 'string' ? body.error.message : undefined;
};

/**
 * The rule, with the envelope left to the protocol that writes it.
 *
 * An upstream that refused in its own words is handed on in them whatever protocol it spoke,
 * because those words are already the shape its own client reads. Only a refusal the gateway
 * itself produced has no body to forward, and that is the one case where which protocol the
 * *client* speaks decides the shape.
 */
export const renderProtocolError = (
  upstreamBody: unknown,
  envelope: () => Record<string, unknown>,
): Record<string, unknown> => isJsonObject(upstreamBody) ? upstreamBody : envelope();

/** The envelope the OpenAI-shaped protocols write. */
export const renderErrorEnvelope = (message: string, upstreamBody?: unknown): Record<string, unknown> =>
  renderProtocolError(upstreamBody, () => ({ error: { message, type: 'api_error' } }));
