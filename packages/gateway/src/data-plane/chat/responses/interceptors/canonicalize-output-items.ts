import type { ResponsesInterceptor } from './types.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';

// Some upstreams re-encrypt the per-output-item `id` and/or
// `encrypted_content` on every SSE frame: the same semantic item carries a
// different blob at `response.output_item.done` than at the terminal
// `response.completed` / `response.incomplete` envelope (same plaintext,
// fresh IV — and on some upstreams a fresh id too).
//
// Azure was the first observed case (id stable, encrypted_content drifts).
// Copilot was found later — both fields drift, so an id-keyed lookup never
// matched and the canonicalization missed entirely; the duplicate ids then
// flowed into the storage layer and inflated stored snapshots' item lists.
//
// Canonicalize on `output_index`, which is positionally stable across the
// streamed `output_item.done` events and the terminal envelope's `output[]`
// array on every upstream we have observed. Pin the `output_item.done` view
// as canonical and rewrite the matching terminal-frame item's `id` and
// `encrypted_content` to it, so the streamed view and the envelope view
// share a single (id, encrypted_content) pair downstream — independent of
// provider and transport.
//
// Consumers disagree on which frame they trust: Codex keeps
// `output_item.done`, the OpenAI SDKs and LiteLLM keep `response.completed`.
// Pinning to the done frame is consistent with the Codex precedent and
// keeps the id a client echoes (after a `output_item.done` round-trip)
// matching the one the storage layer hashed.
//
// An item that only appears at the terminal envelope (the non-streaming
// `/responses` path or the `/responses/compact` response shape) has no
// `output_item.done` entry to pin to, so it passes through unchanged.

interface CanonicalItem {
  readonly id: string | undefined;
  readonly encryptedContent: string | undefined;
}

const canonicalizeOutputItems = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const canonical = new Map<number, CanonicalItem>();

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;

    if (event.type === 'response.output_item.done') {
      canonical.set(event.output_index, {
        id: typeof event.item.id === 'string' ? event.item.id : undefined,
        encryptedContent: (event.item as { encrypted_content?: string }).encrypted_content,
      });
      yield frame;
      continue;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const output = event.response.output.map((item, index) => {
        const replacement = canonical.get(index);
        if (replacement === undefined) return item;
        const next: Record<string, unknown> = { ...item };
        if (replacement.id !== undefined) next.id = replacement.id;
        if (replacement.encryptedContent !== undefined) next.encrypted_content = replacement.encryptedContent;
        return next;
      });
      yield eventFrame({ ...event, response: { ...event.response, output: output as typeof event.response.output } });
      continue;
    }

    yield frame;
  }
};

export const withResponsesOutputItemsCanonicalized: ResponsesInterceptor = async (_ctx, _request, run) => {
  const result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> = await run();
  if (result.type !== 'events') return result;

  return eventResult(canonicalizeOutputItems(result.events), result.modelIdentity, {
    performance: result.performance,
    finalMetadata: result.finalMetadata,
    headers: result.headers,
  });
};
