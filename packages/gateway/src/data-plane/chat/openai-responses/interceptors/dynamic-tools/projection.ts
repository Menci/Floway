import { DYNAMIC_TOOL_DISPATCHER, DYNAMIC_TOOL_SEARCH_HANDLE, DynamicToolInputError, validateDynamicToolArguments, type DynamicToolCatalog, type PreparedDynamicTools } from './catalog.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  createRandomOpenAIResponsesItemId,
  type OpenAIResponsesOutputCustomToolCall,
  type OpenAIResponsesOutputFunctionCall,
  type OpenAIResponsesOutputItem,
  type OpenAIResponsesResult,
  type OpenAIResponsesStreamEvent,
  type OpenAIResponsesToolSearchCallItem,
} from '@floway-dev/protocols/openai-responses';

type ProjectedToolItem = OpenAIResponsesOutputFunctionCall | OpenAIResponsesOutputCustomToolCall | OpenAIResponsesToolSearchCallItem;

type ProjectedCall = {
  item: ProjectedToolItem;
  itemId: string;
  input: string | Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseDispatcherArguments = (raw: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DynamicToolInputError(`Dispatcher returned invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new DynamicToolInputError('Dispatcher arguments must be a JSON object.');
  return parsed;
};

const projectCall = (
  call: OpenAIResponsesOutputFunctionCall,
  catalog: DynamicToolCatalog,
  allowedHandles?: ReadonlySet<string>,
): ProjectedCall => {
  const args = parseDispatcherArguments(call.arguments);
  const handle = args.handle;
  if (typeof handle !== 'string') throw new DynamicToolInputError('Dispatcher handle must be a string.');
  if (allowedHandles !== undefined && !allowedHandles.has(handle)) {
    throw new DynamicToolInputError(`Dispatcher handle '${handle}' is excluded by tool_choice.`);
  }
  if (handle === DYNAMIC_TOOL_SEARCH_HANDLE) {
    if (catalog.searchDefinition === undefined) throw new DynamicToolInputError('Client tool search was not declared.');
    if (!isRecord(args.arguments) || args.text !== undefined) {
      throw new DynamicToolInputError('Tool search requires arguments as a JSON object.');
    }
    const itemId = call.id ?? `tsc_${crypto.randomUUID().replaceAll('-', '')}`;
    return {
      itemId,
      input: args.arguments,
      item: {
        type: 'tool_search_call',
        id: itemId,
        call_id: call.call_id,
        execution: 'client',
        arguments: args.arguments,
        status: call.status,
      },
    };
  }

  const tool = catalog.activeByHandle.get(handle);
  if (tool === undefined) throw new DynamicToolInputError(`Dispatcher handle '${handle}' is not available at this point in the conversation.`);
  if (tool.type === 'function') {
    if (!isRecord(args.arguments) || args.text !== undefined) {
      throw new DynamicToolInputError(`Function tool '${tool.name}' requires arguments as a JSON object.`);
    }
    validateDynamicToolArguments(catalog, tool, args.arguments);
    const itemId = call.id ?? createRandomOpenAIResponsesItemId('function_call');
    return {
      itemId,
      input: args.arguments,
      item: {
        ...call,
        id: itemId,
        name: tool.name,
        ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
        arguments: JSON.stringify(args.arguments),
      },
    };
  }
  if (typeof args.text !== 'string' || args.arguments !== undefined) {
    throw new DynamicToolInputError(`Custom tool '${tool.name}' requires raw text input.`);
  }
  const itemId = call.id ?? createRandomOpenAIResponsesItemId('custom_tool_call');
  return {
    itemId,
    input: args.text,
    item: {
      type: 'custom_tool_call',
      id: itemId,
      call_id: call.call_id,
      name: tool.name,
      ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
      input: args.text,
      status: call.status,
    },
  };
};

const hasDispatcherCall = (item: OpenAIResponsesOutputItem): item is OpenAIResponsesOutputFunctionCall =>
  item.type === 'function_call' && item.name === DYNAMIC_TOOL_DISPATCHER;

const projectResponse = (
  response: OpenAIResponsesResult,
  prepared: PreparedDynamicTools,
  projectedByCallId: Map<string, ProjectedCall>,
): OpenAIResponsesResult => ({
  ...response,
  ...(prepared.clientTools === undefined ? { tools: undefined } : { tools: prepared.clientTools ?? undefined }),
  tool_choice: prepared.clientToolChoice,
  output: response.output.flatMap<OpenAIResponsesOutputItem>(item => {
    if (!hasDispatcherCall(item)) return [item];
    const projected = projectedByCallId.get(item.call_id);
    if (projected !== undefined) return [projected.item];
    if (item.status === 'completed') {
      const complete = projectCall(item, prepared.catalog, prepared.allowedHandles);
      projectedByCallId.set(item.call_id, complete);
      return [complete.item];
    }
    return [];
  }),
});

const projectArgumentEvents = (outputIndex: number, projected: ProjectedCall): OpenAIResponsesStreamEvent[] => {
  const { item, itemId } = projected;
  if (item.type === 'function_call') {
    return [
      { type: 'response.function_call_arguments.delta', item_id: itemId, output_index: outputIndex, delta: item.arguments },
      { type: 'response.function_call_arguments.done', item_id: itemId, output_index: outputIndex, arguments: item.arguments },
    ];
  }
  if (item.type === 'custom_tool_call') {
    return [
      { type: 'response.custom_tool_call_input.delta', item_id: itemId, output_index: outputIndex, delta: item.input },
      { type: 'response.custom_tool_call_input.done', item_id: itemId, output_index: outputIndex, input: item.input },
    ];
  }
  return [];
};

export const projectDynamicToolEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  prepared: PreparedDynamicTools,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const pendingIndices = new Set<number>();
  const dispatcherIndices = new Set<number>();
  const projectedByIndex = new Map<number, ProjectedCall>();
  const projectedByCallId = new Map<string, ProjectedCall>();
  const emittedArgumentIndices = new Set<number>();
  let queue: OpenAIResponsesStreamEvent[] = [];
  let sequenceNumber = 0;

  const transform = (event: OpenAIResponsesStreamEvent): OpenAIResponsesStreamEvent[] => {
    if ('response' in event) {
      return [{ ...event, response: projectResponse(event.response, prepared, projectedByCallId) }];
    }
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const projected = projectedByIndex.get(event.output_index);
      if (projected === undefined) return [event];
      if (event.type === 'response.output_item.added') {
        const item = projected.item;
        return [{
          ...event,
          item: item.type === 'function_call'
            ? { ...item, arguments: '', status: 'in_progress' }
            : item.type === 'custom_tool_call'
              ? { ...item, input: '', status: 'in_progress' }
              : { ...item, status: 'in_progress' },
        }];
      }
      const events = emittedArgumentIndices.has(event.output_index) ? [] : projectArgumentEvents(event.output_index, projected);
      emittedArgumentIndices.add(event.output_index);
      return [...events, { ...event, item: projected.item }];
    }
    if (
      event.type === 'response.function_call_arguments.delta'
      || event.type === 'response.custom_tool_call_input.delta'
    ) {
      return dispatcherIndices.has(event.output_index) ? [] : [event];
    }
    if (
      event.type === 'response.function_call_arguments.done'
      || event.type === 'response.custom_tool_call_input.done'
    ) {
      const projected = projectedByIndex.get(event.output_index);
      if (projected === undefined) return dispatcherIndices.has(event.output_index) ? [] : [event];
      emittedArgumentIndices.add(event.output_index);
      return projectArgumentEvents(event.output_index, projected);
    }
    return [event];
  };

  const flush = function* (): Generator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    for (const event of queue) {
      for (const projected of transform(event)) {
        yield eventFrame({ ...projected, sequence_number: ++sequenceNumber });
      }
    }
    queue = [];
  };

  for await (const frame of frames) {
    if (frame.type === 'done') {
      if (pendingIndices.size > 0) throw new DynamicToolInputError('Dispatcher stream ended before its tool call completed.');
      yield* flush();
      yield frame;
      continue;
    }
    const event = frame.event;
    if (event.type === 'response.output_item.added' && hasDispatcherCall(event.item)) {
      pendingIndices.add(event.output_index);
      dispatcherIndices.add(event.output_index);
    }
    if (event.type === 'response.output_item.done' && hasDispatcherCall(event.item)) {
      const projected = projectCall(event.item, prepared.catalog, prepared.allowedHandles);
      projectedByIndex.set(event.output_index, projected);
      projectedByCallId.set(event.item.call_id, projected);
      dispatcherIndices.add(event.output_index);
      pendingIndices.delete(event.output_index);
    }
    queue.push(event);
    if (pendingIndices.size === 0) yield* flush();
  }
  if (pendingIndices.size > 0) throw new DynamicToolInputError('Dispatcher stream ended before its tool call completed.');
};
