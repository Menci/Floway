import type { OpenAIResponsesTransport, ProtocolFrame } from '@floway-dev/protocols/common';
import { OPENAI_RESPONSES_LITE_HEADER, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import type { EventResult } from '@floway-dev/provider';

// Only these request fields change representation at the Lite boundary. Undo
// that representation on resource-bearing events without changing output items,
// usage, effective service tiers, or native same-transport responses.
// https://github.com/openai/codex/blob/315195492c80fdade38e917c18f9584efd599304/codex-rs/core/src/client.rs#L1113-L1153
const TRANSPORT_ECHO_FIELDS = ['tools', 'instructions', 'parallel_tool_calls', 'reasoning'] as const;

export const openAIResponsesTransportOutput = (
  result: EventResult<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  request: CanonicalOpenAIResponsesPayload,
  source: OpenAIResponsesTransport,
  converted: boolean,
): EventResult<ProtocolFrame<OpenAIResponsesStreamEvent>> => {
  const headers = new Headers(result.headers);
  if (source === 'lite') headers.set(OPENAI_RESPONSES_LITE_HEADER, 'true');
  else headers.delete(OPENAI_RESPONSES_LITE_HEADER);
  if (!converted) return { ...result, headers };

  // Snapshot before consuming a lazy stream: an inner shim may mutate its own
  // invocation between upstream turns, while this remains the caller's view.
  const echoes = Object.fromEntries(TRANSPORT_ECHO_FIELDS.map(field => [field, request[field]]));
  const events = async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    for await (const frame of result.events) {
      if (frame.type !== 'event' || !('response' in frame.event)) {
        yield frame;
        continue;
      }
      const response = { ...frame.event.response };
      for (const field of TRANSPORT_ECHO_FIELDS) {
        if (echoes[field] === undefined) delete response[field];
        else Object.assign(response, { [field]: echoes[field] });
      }
      yield { ...frame, event: { ...frame.event, response } };
    }
  };
  return { ...result, headers, events: events() };
};
