// What a client is sent when a turn failed, and the status it is sent with.
//
// The three tiers are easy to collapse by accident — an edge that reaches for the protocol's
// default first will bury both an upstream's own words and a refusal's own envelope, and each
// family renders its own errors, so the rule is worth holding in one place and pinning here.
//
// The status travels with the body because only the third tier may change it, and one protocol
// must: a Google-RPC envelope states its code inside the body, so an edge free to pick a status
// separately can state two different things about one failure.

import { describe, it } from 'vitest';

import { mintGeminiGenerateContentFailure } from '../../../src/data-plane/chat/gemini-generate-content/errors.ts';
import { mintedAs, renderFailure } from '../../../src/data-plane/pipeline/facts.ts';
import { assertEquals } from '@floway-dev/test-utils';

const protocolDefault = mintedAs(() => ({ error: { message: 'rendered from the status', type: 'api_error' } }));

describe('renderFailure', () => {
  it('forwards the body the upstream sent', () => {
    const upstream = { error: { message: 'model is overloaded', type: 'overloaded_error' } };
    assertEquals(
      renderFailure({ status: 529, message: 'upstream refused', body: upstream }, protocolDefault),
      { body: upstream, status: 529 },
    );
  });

  it('writes the refusal own envelope where the gateway refused', () => {
    const envelope = { error: { message: 'no route', type: 'invalid_request_error', code: 'responses_item_routing_unavailable' } };
    assertEquals(
      renderFailure({ status: 400, message: 'no route', envelope }, protocolDefault),
      { body: envelope, status: 400 },
    );
  });

  it('prefers what the upstream said over what the gateway would have written', () => {
    const upstream = { error: { message: 'context length exceeded' } };
    const envelope = { error: { message: 'no route' } };
    assertEquals(
      renderFailure({ status: 400, message: 'no route', body: upstream, envelope }, protocolDefault),
      { body: upstream, status: 400 },
    );
  });

  it('falls back to the protocol own rendering when neither is present', () => {
    assertEquals(
      renderFailure({ status: 502, message: 'dial failed' }, protocolDefault),
      { body: { error: { message: 'rendered from the status', type: 'api_error' } }, status: 502 },
    );
  });

  it('renders the protocol default where the upstream body was not an object', () => {
    // A gateway that forwarded `"Bad Gateway"` verbatim would answer a JSON protocol with a
    // bare string, which no client of it can read.
    assertEquals(
      renderFailure({ status: 502, message: 'dial failed', body: 'Bad Gateway' }, protocolDefault),
      { body: { error: { message: 'rendered from the status', type: 'api_error' } }, status: 502 },
    );
  });
});

// Gemini generateContent is the reason the status is the third tier's to decide, so the rule
// is pinned on the protocol that exercises it rather than only on the helper.
describe('the Gemini generateContent third tier', () => {
  it('sends a code it has no name for as the one INTERNAL belongs to', () => {
    // 418 maps to `INTERNAL`, and `INTERNAL` is 500's name. Sending it as a 418 would answer
    // with `code: 418` beside `status: "INTERNAL"` — two statements about one failure.
    assertEquals(
      renderFailure({ status: 418, message: 'upstream was a teapot' }, mintGeminiGenerateContentFailure),
      { body: { error: { code: 500, message: 'upstream was a teapot', status: 'INTERNAL' } }, status: 500 },
    );
  });

  it('leaves a code it can name alone', () => {
    assertEquals(
      renderFailure({ status: 429, message: 'slow down' }, mintGeminiGenerateContentFailure),
      { body: { error: { code: 429, message: 'slow down', status: 'RESOURCE_EXHAUSTED' } }, status: 429 },
    );
  });

  it('does not reword an upstream body or a refusal envelope', () => {
    // Neither tier is this gateway's to restate, so a 418 survives both ways when someone
    // else already answered with it.
    const upstream = { error: { code: 418, message: 'upstream said so', status: 'WHATEVER' } };
    assertEquals(
      renderFailure({ status: 418, message: 'ignored', body: upstream }, mintGeminiGenerateContentFailure),
      { body: upstream, status: 418 },
    );
    const envelope = { error: { code: 418, message: 'we said so', status: 'INVALID_ARGUMENT' } };
    assertEquals(
      renderFailure({ status: 418, message: 'ignored', envelope }, mintGeminiGenerateContentFailure),
      { body: envelope, status: 418 },
    );
  });
});
