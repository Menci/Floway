import { unwrapCopilotItemId, wrapCopilotItemId } from './item-id-carrier.ts';
import type { CopilotOpenAIResponsesBoundaryInterceptor } from './types.ts';
import { encodeHex, type ProtocolFrame } from '@floway-dev/protocols/common';
import { isOpenAIResponsesCompactionItem, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesCompactionResultEx, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesOutputItemEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

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

const copilotOutputItemType = (item: OpenAIResponsesOutputItemEx): CopilotOutputItemType => {
  if (isOpenAIResponsesCompactionItem(item)) return 'compaction';
  if (Object.hasOwn(COPILOT_OUTPUT_ITEM_POLICIES, item.type)) return item.type as CopilotOutputItemType;
  throw new TypeError(`Unsupported Copilot OpenAI Responses output item type '${item.type}'`);
};

const createPublicItemId = (type: CopilotOutputItemType): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const suffix = encodeHex(bytes);
  return `${COPILOT_OUTPUT_ITEM_POLICIES[type].prefix}_${suffix}`;
};

const mapCarrierValues = <TItem extends CarrierItem>(
  item: TItem,
  transform: (value: string) => string,
): TItem => {
  const type = isOpenAIResponsesCompactionItem(item) ? 'compaction' : item.type;
  if (!Object.hasOwn(COPILOT_OUTPUT_ITEM_POLICIES, type)) return item;
  const policy = COPILOT_OUTPUT_ITEM_POLICIES[type as CopilotOutputItemType];
  switch (policy.carrier) {
  case 'encrypted_content': {
    const record = item as CarrierItem & { encrypted_content?: unknown };
    return typeof record.encrypted_content === 'string'
      ? { ...item, encrypted_content: transform(record.encrypted_content) } as TItem
      : item;
  }
  case 'fingerprint': {
    const record = item as CarrierItem & { fingerprint: string };
    return { ...item, fingerprint: transform(record.fingerprint) } as TItem;
  }
  case 'agent_content': {
    const record = item as Extract<CarrierItem, { type: 'agent_message' }>;
    return {
      ...item,
      content: record.content.map(content =>
        content.type === 'encrypted_content' && typeof content.encrypted_content === 'string'
          ? { ...content, encrypted_content: transform(content.encrypted_content) }
          : content),
    } as TItem;
  }
  case null:
    return item;
  }
};

const restoreInputItem = (item: CanonicalOpenAIResponsesInputItem): CanonicalOpenAIResponsesInputItem => {
  const upstreamItemIds = new Set<string>();
  const restored = mapCarrierValues(item, value => {
    const decoded = unwrapCopilotItemId(value);
    if (decoded.kind === 'foreign') return value;
    upstreamItemIds.add(decoded.id);
    return decoded.value;
  });

  if (upstreamItemIds.size === 0) return restored;
  if (upstreamItemIds.size > 1) {
    throw new TypeError('Copilot OpenAI Responses item carries conflicting upstream ids');
  }
  return { ...restored, id: [...upstreamItemIds][0] } as CanonicalOpenAIResponsesInputItem;
};

const restoreInputItemIds = (payload: CanonicalOpenAIResponsesPayload): CanonicalOpenAIResponsesPayload => ({
  ...payload,
  input: payload.input.map(restoreInputItem),
});

const carrierValueCount = (item: OpenAIResponsesOutputItemEx): number => {
  let count = 0;
  mapCarrierValues(item, value => {
    count += 1;
    return value;
  });
  return count;
};

const normalizeObservedItem = (item: OpenAIResponsesOutputItemEx, publicId: string): OpenAIResponsesOutputItemEx => {
  copilotOutputItemType(item);
  if (carrierValueCount(item) === 0) return { ...item, id: publicId } as OpenAIResponsesOutputItemEx;

  const upstreamId = 'id' in item ? item.id : undefined;
  if (typeof upstreamId !== 'string' || upstreamId.length === 0) {
    throw new TypeError(`Copilot OpenAI Responses ${item.type} item has replay state but no upstream id`);
  }
  return {
    ...mapCarrierValues(item, value => wrapCopilotItemId(value, upstreamId)),
    id: publicId,
  } as OpenAIResponsesOutputItemEx;
};

interface TrackedItem {
  readonly type: CopilotOutputItemType;
  readonly publicId: string;
}

interface StreamItemState {
  readonly items: Map<number, TrackedItem>;
  readonly announced: Set<number>;
}

const trackedAt = (state: StreamItemState, outputIndex: number): TrackedItem => {
  const tracked = state.items.get(outputIndex);
  if (!state.announced.has(outputIndex)) throw new TypeError(`Copilot OpenAI Responses event references output_index ${outputIndex} before output_item.added`);
  if (tracked === undefined) throw new TypeError(`Copilot OpenAI Responses cannot assign an item identity at output_index ${outputIndex} without a materialized output item`);
  return tracked;
};

const trackObservedItem = (
  state: StreamItemState,
  outputIndex: number,
  item: OpenAIResponsesOutputItemEx,
): TrackedItem => {
  const type = copilotOutputItemType(item);
  const existing = state.items.get(outputIndex);
  if (existing === undefined) {
    const tracked: TrackedItem = { type, publicId: createPublicItemId(type) };
    state.items.set(outputIndex, tracked);
    return tracked;
  }
  if (existing.type !== type) {
    throw new TypeError(`Copilot OpenAI Responses output_index ${outputIndex} changed type from ${existing.type} to ${item.type}`);
  }
  return existing;
};

const normalizeResponseOutput = (
  response: OpenAIResponsesResultEx,
  state: StreamItemState,
): OpenAIResponsesResultEx => {
  if (response.output.length === 0) return response;
  return {
    ...response,
    output: response.output.map((item, outputIndex) => {
      const tracked = trackObservedItem(state, outputIndex, item);
      return normalizeObservedItem(item, tracked.publicId);
    }),
  };
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

const normalizeStreamEvent = (event: OpenAIResponsesStreamEventEx, state: StreamItemState): OpenAIResponsesStreamEventEx => {
  if (event.type === 'response.output_item.added') {
    if (state.announced.has(event.output_index)) {
      throw new TypeError(`Copilot OpenAI Responses emitted output_item.added twice for output_index ${event.output_index}`);
    }
    state.announced.add(event.output_index);
    if (event.item === null) return event;
    const tracked = trackObservedItem(state, event.output_index, event.item);
    return { ...event, item: normalizeObservedItem(event.item, tracked.publicId) };
  }

  if (event.type === 'response.output_item.done') {
    if (event.item === null) return event;
    const tracked = trackObservedItem(state, event.output_index, event.item);
    return { ...event, item: normalizeObservedItem(event.item, tracked.publicId) };
  }

  if (
    event.type === 'response.queued'
    || event.type === 'response.created'
    || event.type === 'response.in_progress'
    || event.type === 'response.completed'
    || event.type === 'response.incomplete'
    || event.type === 'response.failed'
  ) {
    return { ...event, response: normalizeResponseOutput(event.response, state) };
  }

  if (event.type === 'error') return event;
  const carrier = event as OpenAIResponsesStreamEventEx & { item_id?: unknown; output_index?: unknown };
  const requiresItemId = ITEM_ID_EVENT_TYPES.has(event.type);
  const permitsMissingItemId = NO_ITEM_ID_EVENT_TYPES.has(event.type);
  if (!requiresItemId && !permitsMissingItemId) {
    if (Object.hasOwn(event, 'item') || Object.hasOwn(event, 'response')) {
      throw new TypeError(`Unsupported Copilot OpenAI Responses stream event type '${event.type}'`);
    }
    if (!Object.hasOwn(carrier, 'item_id')) return event;
  } else if (permitsMissingItemId && !Object.hasOwn(carrier, 'item_id')) {
    return event;
  }
  if (typeof carrier.item_id !== 'string') {
    const reason = requiresItemId ? 'is missing item_id' : 'carries an invalid item_id extension';
    throw new TypeError(`Copilot OpenAI Responses event '${event.type}' ${reason}`);
  }
  if (typeof carrier.output_index !== 'number') {
    if (!requiresItemId) {
      throw new TypeError(`Copilot OpenAI Responses event '${event.type}' carries an invalid item_id extension`);
    }
    throw new TypeError(`Copilot OpenAI Responses event '${event.type}' carries item_id without output_index`);
  }
  return { ...carrier, item_id: trackedAt(state, carrier.output_index).publicId } as OpenAIResponsesStreamEventEx;
};

const normalizeFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const state: StreamItemState = { items: new Map(), announced: new Set() };
  const buffered: ProtocolFrame<OpenAIResponsesStreamEventEx>[] = [];
  for await (const frame of frames) {
    if (frame.type === 'event') {
      const event = frame.event;
      if (event.type === 'error') {
        // An upstream failure can end a segment before its item type arrives.
        // Those undecidable frames have no valid public identity; discard them
        // so the original protocol error survives without leaking raw item IDs.
        buffered.length = 0;
        yield frame;
        continue;
      }
      if ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && event.item !== null) {
        trackObservedItem(state, event.output_index, event.item);
      } else if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
        event.response.output.forEach((item, index) => trackObservedItem(state, index, item));
      }
    }
    buffered.push(frame);
    while (buffered.length > 0) {
      const next = buffered[0]!;
      if (next.type === 'event') {
        const carrier = next.event as OpenAIResponsesStreamEventEx & { item_id?: unknown; output_index?: unknown };
        if (typeof carrier.item_id === 'string' && typeof carrier.output_index === 'number'
          && state.announced.has(carrier.output_index) && !state.items.has(carrier.output_index)) break;
      }
      buffered.shift();
      yield next.type === 'event' ? { ...next, event: normalizeStreamEvent(next.event, state) } : next;
    }
  }
  for (const frame of buffered) {
    yield frame.type === 'event' ? { ...frame, event: normalizeStreamEvent(frame.event, state) } : frame;
  }
};

const normalizeCompactionResult = (response: OpenAIResponsesCompactionResultEx): OpenAIResponsesCompactionResultEx => ({
  ...response,
  output: response.output.map(item => {
    if (!isOpenAIResponsesCompactionItem(item)) return item;
    return normalizeObservedItem(item, createPublicItemId('compaction'));
  }),
});

export const withCopilotOpenAIResponsesItemIdMembrane: CopilotOpenAIResponsesBoundaryInterceptor = async (ctx, _env, run) => {
  ctx.payload = restoreInputItemIds(ctx.payload);
  const result = await run();
  if (!result.ok) return result;

  return result.action === 'generate'
    ? { ...result, events: normalizeFrames(result.events) }
    : { ...result, result: normalizeCompactionResult(result.result) };
};
