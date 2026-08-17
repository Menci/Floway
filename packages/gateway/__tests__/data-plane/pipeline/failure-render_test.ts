// What a client is sent when a turn failed.
//
// The three tiers are easy to collapse by accident — an edge that reaches for the protocol's
// default first will bury both an upstream's own words and a refusal's own envelope, and each
// family renders its own errors, so the rule is worth holding in one place and pinning here.

import { describe, it } from 'vitest';

import { renderFailure } from '../../../src/data-plane/pipeline/facts.ts';
import { assertEquals } from '@floway-dev/test-utils';

const protocolDefault = () => ({ error: { message: 'rendered from the status', type: 'api_error' } });

describe('renderFailure', () => {
  it('forwards the body the upstream sent', () => {
    const upstream = { error: { message: 'model is overloaded', type: 'overloaded_error' } };
    assertEquals(
      renderFailure({ status: 529, message: 'upstream refused', body: upstream }, protocolDefault),
      upstream,
    );
  });

  it('writes the refusal own envelope where the gateway refused', () => {
    const envelope = { error: { message: 'no route', type: 'invalid_request_error', code: 'responses_item_routing_unavailable' } };
    assertEquals(
      renderFailure({ status: 400, message: 'no route', envelope }, protocolDefault),
      envelope,
    );
  });

  it('prefers what the upstream said over what the gateway would have written', () => {
    const upstream = { error: { message: 'context length exceeded' } };
    const envelope = { error: { message: 'no route' } };
    assertEquals(
      renderFailure({ status: 400, message: 'no route', body: upstream, envelope }, protocolDefault),
      upstream,
    );
  });

  it('falls back to the protocol own rendering when neither is present', () => {
    assertEquals(renderFailure({ status: 502, message: 'dial failed' }, protocolDefault), protocolDefault());
  });

  it('renders the protocol default where the upstream body was not an object', () => {
    // A gateway that forwarded `"Bad Gateway"` verbatim would answer a JSON protocol with a
    // bare string, which no client of it can read.
    assertEquals(renderFailure({ status: 502, message: 'dial failed', body: 'Bad Gateway' }, protocolDefault), protocolDefault());
  });
});
