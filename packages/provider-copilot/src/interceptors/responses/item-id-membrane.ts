import { unwrapCopilotItemId, wrapCopilotItemId } from './item-id-carrier.ts';
import type { CopilotResponsesBoundaryInterceptor } from './types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ResponsesInputItem, ResponsesOutputItem, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

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
type CarrierItem = ResponsesInputItem | ResponsesOutputItem;

const copilotOutputItemType = (item: ResponsesOutputItem): CopilotOutputItemType => {
  if (Object.hasOwn(COPILOT_OUTPUT_ITEM_POLICIES, item.type)) return item.type as CopilotOutputItemType;
  throw new TypeError(`Unsupported Copilot Responses output item type '${item.type}'`);
};

const createPublicItemId = (type: CopilotOutputItemType): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const suffix = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${COPILOT_OUTPUT_ITEM_POLICIES[type].prefix}_${suffix}`;
};

const mapCarrierValues = <TItem extends CarrierItem>(
  item: TItem,
  transform: (value: string) => string,
): TItem => {
  if (!Object.hasOwn(COPILOT_OUTPUT_ITEM_POLICIES, item.type)) return item;
  const policy = COPILOT_OUTPUT_ITEM_POLICIES[item.type as CopilotOutputItemType];
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

const restoreInputItem = (item: ResponsesInputItem): ResponsesInputItem => {
  const upstreamIds = new Set<string>();
  const restored = mapCarrierValues(item, value => {
    const decoded = unwrapCopilotItemId(value);
    if (decoded.kind === 'foreign') return value;
    upstreamIds.add(decoded.id);
    return decoded.value;
  });

  if (upstreamIds.size === 0) return restored;
  if (upstreamIds.size > 1) {
    throw new TypeError('Copilot Responses item carries conflicting upstream ids');
  }
  return { ...restored, id: [...upstreamIds][0] } as ResponsesInputItem;
};

const restoreInputItemIds = (payload: CanonicalResponsesPayload): CanonicalResponsesPayload => ({
  ...payload,
  input: payload.input.map(restoreInputItem),
});

const carrierValueCount = (item: ResponsesOutputItem): number => {
  let count = 0;
  mapCarrierValues(item, value => {
    count += 1;
    return value;
  });
  return count;
};

const normalizeObservedItem = (item: ResponsesOutputItem, publicId: string): ResponsesOutputItem => {
  copilotOutputItemType(item);
  if (carrierValueCount(item) === 0) return { ...item, id: publicId } as ResponsesOutputItem;

  const upstreamId = 'id' in item ? item.id : undefined;
  if (typeof upstreamId !== 'string' || upstreamId.length === 0) {
    throw new TypeError(`Copilot Responses ${item.type} item has replay state but no upstream id`);
  }
  return {
    ...mapCarrierValues(item, value => wrapCopilotItemId(value, upstreamId)),
    id: publicId,
  } as ResponsesOutputItem;
};

interface TrackedItem {
  readonly type: CopilotOutputItemType;
  readonly publicId: string;
  added: boolean;
}

interface StreamItemState {
  readonly items: Map<number, TrackedItem>;
}

const trackedAt = (state: StreamItemState, outputIndex: number): TrackedItem => {
  const tracked = state.items.get(outputIndex);
  if (tracked === undefined) throw new TypeError(`Copilot Responses event references output_index ${outputIndex} before output_item.added`);
  return tracked;
};

const trackObservedItem = (
  state: StreamItemState,
  outputIndex: number,
  item: ResponsesOutputItem,
): TrackedItem => {
  const type = copilotOutputItemType(item);
  const existing = state.items.get(outputIndex);
  if (existing === undefined) {
    const tracked: TrackedItem = { type, publicId: createPublicItemId(type), added: false };
    state.items.set(outputIndex, tracked);
    return tracked;
  }
  if (existing.type !== type) {
    throw new TypeError(`Copilot Responses output_index ${outputIndex} changed type from ${existing.type} to ${item.type}`);
  }
  return existing;
};

const normalizeResponseOutput = (
  response: ResponsesResult,
  state: StreamItemState,
): ResponsesResult => {
  if (response.output.length === 0) return response;
  return {
    ...response,
    output: response.output.map((item, outputIndex) => {
      const tracked = trackObservedItem(state, outputIndex, item);
      return normalizeObservedItem(item, tracked.publicId);
    }),
  };
};

const ITEM_ID_EVENT_TYPES = new Set<ResponsesStreamEvent['type']>([
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

const NO_ITEM_ID_EVENT_TYPES = new Set<ResponsesStreamEvent['type']>([
  'response.shell_call_command.added',
  'response.shell_call_command.delta',
  'response.shell_call_command.done',
]);

const normalizeStreamEvent = (event: ResponsesStreamEvent, state: StreamItemState): ResponsesStreamEvent => {
  if (event.type === 'response.output_item.added') {
    const tracked = trackObservedItem(state, event.output_index, event.item);
    if (tracked.added) {
      throw new TypeError(`Copilot Responses emitted output_item.added twice for output_index ${event.output_index}`);
    }
    tracked.added = true;
    return { ...event, item: normalizeObservedItem(event.item, tracked.publicId) };
  }

  if (event.type === 'response.output_item.done') {
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

  if (event.type === 'error' || event.type === 'ping') return event;
  const carrier = event as ResponsesStreamEvent & { item_id?: unknown; output_index?: unknown };
  const requiresItemId = ITEM_ID_EVENT_TYPES.has(event.type);
  const permitsMissingItemId = NO_ITEM_ID_EVENT_TYPES.has(event.type);
  if (!requiresItemId && !permitsMissingItemId) {
    if (Object.hasOwn(event, 'item') || Object.hasOwn(event, 'response')) {
      throw new TypeError(`Unsupported Copilot Responses stream event type '${event.type}'`);
    }
    if (!Object.hasOwn(carrier, 'item_id')) return event;
  } else if (permitsMissingItemId && !Object.hasOwn(carrier, 'item_id')) {
    return event;
  }
  if (typeof carrier.item_id !== 'string') {
    const reason = requiresItemId ? 'is missing item_id' : 'carries an invalid item_id extension';
    throw new TypeError(`Copilot Responses event '${event.type}' ${reason}`);
  }
  if (typeof carrier.output_index !== 'number') {
    if (!requiresItemId) {
      throw new TypeError(`Copilot Responses event '${event.type}' carries an invalid item_id extension`);
    }
    throw new TypeError(`Copilot Responses event '${event.type}' carries item_id without output_index`);
  }
  return { ...carrier, item_id: trackedAt(state, carrier.output_index).publicId } as ResponsesStreamEvent;
};

const normalizeFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const state: StreamItemState = { items: new Map() };
  for await (const frame of frames) {
    yield frame.type === 'event'
      ? { ...frame, event: normalizeStreamEvent(frame.event, state) }
      : frame;
  }
};

const normalizeCompactionResult = (response: ResponsesResult): ResponsesResult => ({
  ...response,
  output: response.output.map(item => {
    if (item.type !== 'compaction') return item;
    return normalizeObservedItem(item, createPublicItemId('compaction'));
  }),
});

export const withCopilotResponsesItemIdMembrane: CopilotResponsesBoundaryInterceptor = async (ctx, _request, run) => {
  ctx.payload = restoreInputItemIds(ctx.payload);
  const result = await run();
  if (!result.ok) return result;

  return result.action === 'generate'
    ? { ...result, events: normalizeFrames(result.events) }
    : { ...result, result: normalizeCompactionResult(result.result) };
};
