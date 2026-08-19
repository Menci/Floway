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

/** The envelope the OpenAI-shaped protocols write when a refusal is the gateway's own words.
 *
 * Which of an upstream's body, a stage's own envelope and this one a client is actually sent is
 * not decided here: that is one policy over all three tiers, and it lives with the `Failure` it
 * reads. This is only the shape those protocols state a gateway-authored refusal in. */
export const renderErrorEnvelope = (message: string): Record<string, unknown> =>
  ({ error: { message, type: 'api_error' } });
