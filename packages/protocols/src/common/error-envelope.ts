// What a client is sent when a run produced no answer, and how an upstream's own words are
// read out of what it sent.
//
// An upstream that refused in its own words is handed on in them — a client reads the code
// and type inside, and the gateway has nothing truer to say than what the upstream said. This
// is why the test is whether an upstream answered at all rather than which shape it answered
// in: an OpenAI family's error is `{error:{...}}` and a rerank client's is `{message}`, and
// both are already the shape that client reads.
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
