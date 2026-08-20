// Reading what an upstream answered with, for the families whose protocol is JSON.
//
// Every protocol the gateway carries is one it fully understands, so a body it cannot read
// is not handed on unread: the family synthesizes an error from what it did see. That is
// also why the text is kept alongside the parse — a dump reader is owed what actually came
// back, and a message that quotes the body is the only thing a client can act on when the
// upstream answered with something the protocol does not admit.

import type { Failure } from './facts.ts';

export interface UpstreamBody {
  readonly text: string;
  /** Absent when the body was not JSON at all, which is itself the answer to a protocol that
   *  requires JSON. */
  readonly json?: unknown;
}

export const readUpstreamBody = async (response: Response): Promise<UpstreamBody> => {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) as unknown };
  } catch {
    return { text };
  }
};

/**
 * What an upstream that answered in something other than this protocol is worth to a client.
 *
 * A gateway that cannot read the answer has not served the request, whatever status came with
 * it, so this is 502 rather than the upstream's own — and it is a value, because the fork
 * above has another candidate to try and an answer nobody can read is exactly the outcome it
 * exists to move past.
 */
export const unreadableBody = (response: Response, body: UpstreamBody, protocolName: string): Failure => ({
  status: 502,
  message: `The upstream answered ${response.status} with a body ${protocolName} cannot read: ${body.text.slice(0, 200)}`,
});

/**
 * What the platform raised while dialling, as a value.
 *
 * Nothing in the domain throws. A connection that was refused, timed out or was reset is an
 * outcome failover has to be able to see — a run that ends there has more candidates to try —
 * so the ending catches whatever the platform raised and hands it up like any other failure.
 * The status says what happened rather than what the error was: the gateway reached no
 * upstream at all, which is what 502 states.
 */
export const dialFailure = (error: unknown): Failure => ({
  status: 502,
  message: error instanceof Error ? error.message : String(error),
});
