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
const COPILOT_OUTPUT_ITEM_PREFIXES = {
  message: 'msg',
  reasoning: 'rs',
  function_call: 'fc',
  custom_tool_call: 'ctc',
  web_search_call: 'ws',
  tool_search_call: 'tsc',
  program: 'cm',
  program_output: 'cmo',
  agent_message: 'amsg',
  compaction: 'cmp',
  shell_call: 'sh',
  shell_call_output: 'sho',
  apply_patch_call: 'apc',
} as const;

type CopilotOutputItemType = keyof typeof COPILOT_OUTPUT_ITEM_PREFIXES;
type CarrierItem = ResponsesInputItem | ResponsesOutputItem;

const copilotOutputItemType = (item: ResponsesOutputItem): CopilotOutputItemType => {
  if (item.type in COPILOT_OUTPUT_ITEM_PREFIXES) return item.type as CopilotOutputItemType;
  throw new TypeError(`Unsupported Copilot Responses output item type '${item.type}'`);
};

const createPublicItemId = (type: CopilotOutputItemType): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const suffix = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${COPILOT_OUTPUT_ITEM_PREFIXES[type]}_${suffix}`;
};

const mapCarrierValues = <TItem extends CarrierItem>(
  item: TItem,
  transform: (value: string) => string,
): TItem => {
  switch (item.type) {
  case 'reasoning':
  case 'compaction':
    return typeof item.encrypted_content === 'string'
      ? { ...item, encrypted_content: transform(item.encrypted_content) } as TItem
      : item;
  case 'program':
    return { ...item, fingerprint: transform(item.fingerprint) } as TItem;
  case 'agent_message':
    return {
      ...item,
      content: item.content.map(content =>
        content.type === 'encrypted_content' && typeof content.encrypted_content === 'string'
          ? { ...content, encrypted_content: transform(content.encrypted_content) }
          : content),
    } as TItem;
  default:
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
    throw new TypeError(`Copilot Responses item carries conflicting upstream ids: ${[...upstreamIds].join(', ')}`);
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

const normalizeFinalItem = (item: ResponsesOutputItem, publicId: string): ResponsesOutputItem => {
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
  finalItem?: ResponsesOutputItem;
}

interface StreamItemState {
  readonly items: Map<number, TrackedItem>;
}

const trackedAt = (state: StreamItemState, outputIndex: number): TrackedItem => {
  const tracked = state.items.get(outputIndex);
  if (tracked === undefined) throw new TypeError(`Copilot Responses event references output_index ${outputIndex} before output_item.added`);
  return tracked;
};

const normalizeResponseOutput = (
  response: ResponsesResult,
  state: StreamItemState,
  requireFinal: boolean,
): ResponsesResult => {
  if (response.output.length === 0) return response;
  return {
    ...response,
    output: response.output.map((item, outputIndex) => {
      const tracked = trackedAt(state, outputIndex);
      if (copilotOutputItemType(item) !== tracked.type) {
        throw new TypeError(`Copilot Responses output_index ${outputIndex} changed type from ${tracked.type} to ${item.type}`);
      }
      if (tracked.finalItem !== undefined) return tracked.finalItem;
      if (requireFinal) throw new TypeError(`Copilot Responses terminal event arrived before output_item.done for output_index ${outputIndex}`);
      return { ...item, id: tracked.publicId } as ResponsesOutputItem;
    }),
  };
};

const normalizeStreamEvent = (event: ResponsesStreamEvent, state: StreamItemState): ResponsesStreamEvent => {
  if (event.type === 'response.output_item.added') {
    if (state.items.has(event.output_index)) {
      throw new TypeError(`Copilot Responses emitted output_item.added twice for output_index ${event.output_index}`);
    }
    const type = copilotOutputItemType(event.item);
    const tracked: TrackedItem = { type, publicId: createPublicItemId(type) };
    state.items.set(event.output_index, tracked);
    return { ...event, item: { ...event.item, id: tracked.publicId } as ResponsesOutputItem };
  }

  if (event.type === 'response.output_item.done') {
    const tracked = trackedAt(state, event.output_index);
    if (copilotOutputItemType(event.item) !== tracked.type) {
      throw new TypeError(`Copilot Responses output_index ${event.output_index} changed type from ${tracked.type} to ${event.item.type}`);
    }
    if (tracked.finalItem !== undefined) {
      throw new TypeError(`Copilot Responses emitted output_item.done twice for output_index ${event.output_index}`);
    }
    tracked.finalItem = normalizeFinalItem(event.item, tracked.publicId);
    return { ...event, item: tracked.finalItem };
  }

  if (
    event.type === 'response.created'
    || event.type === 'response.in_progress'
    || event.type === 'response.completed'
    || event.type === 'response.incomplete'
    || event.type === 'response.failed'
  ) {
    const terminal = event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed';
    return { ...event, response: normalizeResponseOutput(event.response, state, terminal) };
  }

  const carrier = event as ResponsesStreamEvent & { item_id?: unknown; output_index?: unknown };
  if (typeof carrier.item_id !== 'string') return event;
  if (typeof carrier.output_index !== 'number') {
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
    return normalizeFinalItem(item, createPublicItemId('compaction'));
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
