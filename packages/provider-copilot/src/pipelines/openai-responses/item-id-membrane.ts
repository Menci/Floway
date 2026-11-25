import { defineCopilotStage } from '../facts.ts';
import { unwrapCopilotItemId, wrapCopilotItemId } from './item-id-carrier.ts';
import { move, type Result } from '@floway-dev/pipeline';
import { encodeHex } from '@floway-dev/protocols/common';
import { formatOpenAIResponsesError, isOpenAIResponsesCompactionItem, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesCompactionResultEx, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesOutputItemEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/provider';

export const itemIdMembrane = defineCopilotStage({
  name: 'copilot.openaiResponses.itemIdMembrane',
  through: {
    request: { needs: ['request.openaiResponses', 'copilot.modelId'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: ['response.openaiResponses'], provides: ['response.openaiResponses'], consumes: [] },
  },
  return: { provides: ['response.http', 'response.modelKey', 'response.openaiResponses'] },
  async execute(facts, scope) {
    const restored = restoreInputItemIds(facts['request.openaiResponses']);
    if (!restored.ok) {
      const { cause } = restored.error;
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        'response.http': move({ status: 400, statusText: 'Bad Request', headers: [['content-type', 'application/json']], body: null }),
        'response.modelKey': facts['copilot.modelId'],
        'response.openaiResponses': move({ kind: 'error', source: 'local', error: { error: { type: 'invalid_request_error', message } }, cause }),
      };
    }
    const back = await scope.next({ ...facts, 'request.openaiResponses': move(restored.value) });
    const outcome = back['response.openaiResponses'];
    switch (outcome.kind) {
    case 'error':
      return back;
    case 'result': {
      const result = normalizeCompactionResult(outcome.result);
      if (result.ok) return { ...back, 'response.openaiResponses': move({ kind: 'result', result: result.value }) };
      const { cause } = result.error;
      return { ...back, 'response.openaiResponses': move({ kind: 'error', source: 'upstream', error: formatOpenAIResponsesError(null, cause instanceof Error ? cause.message : String(cause)), cause }) };
    }
    case 'stream': {
      const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
        const state: StreamItemState = { items: new Map() };
        const cursor = source[Symbol.asyncIterator]();
        let stopped = false;
        for (;;) {
          const { done, value: item } = await cursor.next();
          if (done) return;
          if (stopped) continue;
          if (!item.ok) {
            yield item;
            continue;
          }
          const event = normalizeStreamEvent(item.value, state);
          yield event;
          if (!event.ok) {
            stopped = true;
            producer.abort(back);
          }
        }
      });
      return { ...back, 'response.openaiResponses': move({ kind: 'stream', stream }) };
    }
    }
  },
});

const protocolFailure = (message: string): Result<never, ProtocolStreamError> =>
  ({ ok: false, error: { kind: 'protocol', cause: new TypeError(message) } });

// OpenAI's published examples establish these item-specific prefixes. Keeping
// the Copilot output inventory closed prevents a new upstream item kind from
// leaking its raw id before we have verified its replay behavior.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L57042-L59599
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L68023-L68281
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L68333-L68748
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L74970-L75020
const COPILOT_OUTPUT_ITEM_POLICIES = {
  message: { prefix: 'msg', carrier: null },
  reasoning: { prefix: 'rs', carrier: 'encrypted_content' },
  function_call: { prefix: 'fc', carrier: null },
  custom_tool_call: { prefix: 'ctc', carrier: null },
  web_search_call: { prefix: 'ws', carrier: null },
  tool_search_call: { prefix: 'tsc', carrier: null },
  tool_search_output: { prefix: 'tso', carrier: null },
  program: { prefix: 'cm', carrier: 'fingerprint' },
  program_output: { prefix: 'cmo', carrier: null },
  agent_message: { prefix: 'amsg', carrier: 'agent_content' },
  compaction: { prefix: 'cmp', carrier: 'encrypted_content' },
  shell_call: { prefix: 'sh', carrier: null },
  shell_call_output: { prefix: 'sho', carrier: null },
  apply_patch_call: { prefix: 'apc', carrier: null },
} as const;

type CopilotOutputItemType = keyof typeof COPILOT_OUTPUT_ITEM_POLICIES;
type CarrierItem = CanonicalOpenAIResponsesInputItem | OpenAIResponsesOutputItemEx;

const copilotOutputItemType = (item: OpenAIResponsesOutputItemEx): Result<CopilotOutputItemType, ProtocolStreamError> => {
  if (isOpenAIResponsesCompactionItem(item)) return { ok: true, value: 'compaction' };
  if (Object.hasOwn(COPILOT_OUTPUT_ITEM_POLICIES, item.type)) return { ok: true, value: item.type as CopilotOutputItemType };
  return protocolFailure(`Unsupported Copilot OpenAI Responses output item type '${item.type}'`);
};

const createPublicItemId = (type: CopilotOutputItemType): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const suffix = encodeHex(bytes);
  return `${COPILOT_OUTPUT_ITEM_POLICIES[type].prefix}_${suffix}`;
};

const mapCarrierValues = <TItem extends CarrierItem>(
  item: TItem,
  transform: (value: string) => Result<string, ProtocolStreamError>,
): Result<TItem, ProtocolStreamError> => {
  const type = isOpenAIResponsesCompactionItem(item) ? 'compaction' : item.type;
  if (!Object.hasOwn(COPILOT_OUTPUT_ITEM_POLICIES, type)) return { ok: true, value: item };
  const policy = COPILOT_OUTPUT_ITEM_POLICIES[type as CopilotOutputItemType];
  switch (policy.carrier) {
  case 'encrypted_content': {
    const record = item as CarrierItem & { encrypted_content?: unknown };
    if (typeof record.encrypted_content !== 'string') return { ok: true, value: item };
    const encryptedContent = transform(record.encrypted_content);
    return encryptedContent.ok ? { ok: true, value: { ...item, encrypted_content: encryptedContent.value } as TItem } : encryptedContent;
  }
  case 'fingerprint': {
    const record = item as CarrierItem & { fingerprint: string };
    const fingerprint = transform(record.fingerprint);
    return fingerprint.ok ? { ok: true, value: { ...item, fingerprint: fingerprint.value } as TItem } : fingerprint;
  }
  case 'agent_content': {
    const record = item as Extract<CarrierItem, { type: 'agent_message' }>;
    const content: (typeof record.content)[number][] = [];
    for (const part of record.content) {
      if (part.type !== 'encrypted_content' || typeof part.encrypted_content !== 'string') {
        content.push(part);
        continue;
      }
      const encryptedContent = transform(part.encrypted_content);
      if (!encryptedContent.ok) return encryptedContent;
      content.push({ ...part, encrypted_content: encryptedContent.value });
    }
    return { ok: true, value: { ...item, content } as TItem };
  }
  case null:
    return { ok: true, value: item };
  }
};

const restoreInputItem = (item: CanonicalOpenAIResponsesInputItem): Result<CanonicalOpenAIResponsesInputItem, ProtocolStreamError> => {
  let upstreamId: string | undefined;
  const restored = mapCarrierValues(item, value => {
    const decoded = unwrapCopilotItemId(value);
    if (decoded.kind === 'foreign') return { ok: true, value };
    if (upstreamId !== undefined && upstreamId !== decoded.id) return protocolFailure('Copilot OpenAI Responses item carries conflicting upstream ids');
    upstreamId = decoded.id;
    return { ok: true, value: decoded.value };
  });

  if (!restored.ok || upstreamId === undefined) return restored;
  return { ok: true, value: { ...restored.value, id: upstreamId } as CanonicalOpenAIResponsesInputItem };
};

const restoreInputItemIds = <Payload extends Pick<CanonicalOpenAIResponsesPayload, 'input'>>(payload: Payload): Result<Payload, ProtocolStreamError> => {
  const input: CanonicalOpenAIResponsesInputItem[] = [];
  for (const item of payload.input) {
    const restored = restoreInputItem(item);
    if (!restored.ok) return restored;
    input.push(restored.value);
  }
  return { ok: true, value: { ...payload, input } };
};

const normalizeObservedItem = (item: OpenAIResponsesOutputItemEx, publicId: string): Result<OpenAIResponsesOutputItemEx, ProtocolStreamError> => {
  const normalized = mapCarrierValues(item, value => {
    const upstreamId = 'id' in item ? item.id : undefined;
    if (typeof upstreamId !== 'string' || upstreamId.length === 0) {
      return protocolFailure(`Copilot OpenAI Responses ${item.type} item has replay state but no upstream id`);
    }
    const wrapped = wrapCopilotItemId(value, upstreamId);
    return wrapped.ok ? wrapped : { ok: false, error: { kind: 'protocol', cause: wrapped.error } };
  });
  return normalized.ok ? { ok: true, value: { ...normalized.value, id: publicId } as OpenAIResponsesOutputItemEx } : normalized;
};

interface TrackedItem {
  readonly type: CopilotOutputItemType;
  readonly publicId: string;
  added: boolean;
}

interface StreamItemState {
  readonly items: Map<number, TrackedItem>;
}

const trackObservedItem = (
  state: StreamItemState,
  outputIndex: number,
  item: OpenAIResponsesOutputItemEx,
): Result<TrackedItem, ProtocolStreamError> => {
  const type = copilotOutputItemType(item);
  if (!type.ok) return type;
  const existing = state.items.get(outputIndex);
  if (existing === undefined) {
    const tracked: TrackedItem = { type: type.value, publicId: createPublicItemId(type.value), added: false };
    state.items.set(outputIndex, tracked);
    return { ok: true, value: tracked };
  }
  if (existing.type !== type.value) {
    return protocolFailure(`Copilot OpenAI Responses output_index ${outputIndex} changed type from ${existing.type} to ${item.type}`);
  }
  return { ok: true, value: existing };
};

const normalizeResponseOutput = (
  response: OpenAIResponsesResultEx,
  state: StreamItemState,
): Result<OpenAIResponsesResultEx, ProtocolStreamError> => {
  if (response.output.length === 0) return { ok: true, value: response };
  const output: OpenAIResponsesOutputItemEx[] = [];
  for (const [outputIndex, item] of response.output.entries()) {
    const tracked = trackObservedItem(state, outputIndex, item);
    if (!tracked.ok) return tracked;
    const normalized = normalizeObservedItem(item, tracked.value.publicId);
    if (!normalized.ok) return normalized;
    output.push(normalized.value);
  }
  return { ok: true, value: { ...response, output } };
};

const ITEM_ID_EVENT_TYPES = new Set<OpenAIResponsesStreamEventEx['type']>([
  'response.content_part.added',
  'response.content_part.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.output_text.annotation.added',
  'response.web_search_call.in_progress',
  'response.web_search_call.searching',
  'response.web_search_call.completed',
  'response.image_generation_call.in_progress',
  'response.image_generation_call.generating',
  'response.image_generation_call.partial_image',
  'response.image_generation_call.completed',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.custom_tool_call_input.delta',
  'response.custom_tool_call_input.done',
  'response.apply_patch_call_operation_diff.delta',
  'response.apply_patch_call_operation_diff.done',
]);

const NO_ITEM_ID_EVENT_TYPES = new Set<OpenAIResponsesStreamEventEx['type']>([
  'response.shell_call_command.added',
  'response.shell_call_command.delta',
  'response.shell_call_command.done',
]);

const normalizeStreamEvent = (event: OpenAIResponsesStreamEventEx, state: StreamItemState): Result<OpenAIResponsesStreamEventEx, ProtocolStreamError> => {
  if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
    const tracked = trackObservedItem(state, event.output_index, event.item);
    if (!tracked.ok) return tracked;
    if (event.type === 'response.output_item.added') {
      if (tracked.value.added) return protocolFailure(`Copilot OpenAI Responses emitted output_item.added twice for output_index ${event.output_index}`);
      tracked.value.added = true;
    }
    const item = normalizeObservedItem(event.item, tracked.value.publicId);
    return item.ok ? { ok: true, value: { ...event, item: item.value } } : item;
  }

  if (
    event.type === 'response.queued'
    || event.type === 'response.created'
    || event.type === 'response.in_progress'
    || event.type === 'response.completed'
    || event.type === 'response.incomplete'
    || event.type === 'response.failed'
  ) {
    const response = normalizeResponseOutput(event.response, state);
    return response.ok ? { ok: true, value: { ...event, response: response.value } } : response;
  }

  if (event.type === 'error') return { ok: true, value: event };
  const carrier = event as OpenAIResponsesStreamEventEx & { item_id?: unknown; output_index?: unknown };
  const requiresItemId = ITEM_ID_EVENT_TYPES.has(event.type);
  const permitsMissingItemId = NO_ITEM_ID_EVENT_TYPES.has(event.type);
  if (!requiresItemId && !permitsMissingItemId) {
    if (Object.hasOwn(event, 'item') || Object.hasOwn(event, 'response')) {
      return protocolFailure(`Unsupported Copilot OpenAI Responses stream event type '${event.type}'`);
    }
    if (!Object.hasOwn(carrier, 'item_id')) return { ok: true, value: event };
  } else if (permitsMissingItemId && !Object.hasOwn(carrier, 'item_id')) {
    return { ok: true, value: event };
  }
  if (typeof carrier.item_id !== 'string') {
    const reason = requiresItemId ? 'is missing item_id' : 'carries an invalid item_id extension';
    return protocolFailure(`Copilot OpenAI Responses event '${event.type}' ${reason}`);
  }
  if (typeof carrier.output_index !== 'number') {
    if (!requiresItemId) {
      return protocolFailure(`Copilot OpenAI Responses event '${event.type}' carries an invalid item_id extension`);
    }
    return protocolFailure(`Copilot OpenAI Responses event '${event.type}' carries item_id without output_index`);
  }
  const tracked = state.items.get(carrier.output_index);
  if (tracked === undefined) return protocolFailure(`Copilot OpenAI Responses event references output_index ${carrier.output_index} before output_item.added`);
  return { ok: true, value: { ...carrier, item_id: tracked.publicId } as OpenAIResponsesStreamEventEx };
};

const normalizeCompactionResult = (response: OpenAIResponsesCompactionResultEx): Result<OpenAIResponsesCompactionResultEx, ProtocolStreamError> => {
  const output: OpenAIResponsesCompactionResultEx['output'] = [];
  for (const item of response.output) {
    if (!isOpenAIResponsesCompactionItem(item)) {
      output.push(item);
      continue;
    }
    const normalized = normalizeObservedItem(item, createPublicItemId('compaction'));
    if (!normalized.ok) return normalized;
    output.push(normalized.value);
  }
  return { ok: true, value: { ...response, output } };
};
