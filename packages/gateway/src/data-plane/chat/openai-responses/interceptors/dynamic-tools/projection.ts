import { DYNAMIC_TOOL_DISPATCHER, DYNAMIC_TOOL_SEARCH_HANDLE, DynamicToolInputError, validateDynamicToolArguments, type DynamicCallable, type DynamicToolCatalog, type PreparedDynamicTools } from './catalog.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  createRandomOpenAIResponsesItemId,
  type OpenAIResponsesApplyPatchCallItem,
  type OpenAIResponsesComputerAction,
  type OpenAIResponsesComputerCallItem,
  type OpenAIResponsesComputerSafetyCheck,
  type OpenAIResponsesLocalShellCallItem,
  type OpenAIResponsesOutputCustomToolCall,
  type OpenAIResponsesOutputFunctionCall,
  type OpenAIResponsesOutputItem,
  type OpenAIResponsesResult,
  type OpenAIResponsesShellCallItem,
  type OpenAIResponsesStreamEvent,
  type OpenAIResponsesToolSearchCallItem,
} from '@floway-dev/protocols/openai-responses';

type ProjectedToolItem = OpenAIResponsesOutputFunctionCall | OpenAIResponsesOutputCustomToolCall | OpenAIResponsesToolSearchCallItem | OpenAIResponsesShellCallItem | OpenAIResponsesLocalShellCallItem | OpenAIResponsesApplyPatchCallItem | OpenAIResponsesComputerCallItem;

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

const stringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new DynamicToolInputError(`${label} must be an array of strings.`);
  }
  return value;
};

const optionalNumber = (value: unknown, label: string): number | null | undefined => {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DynamicToolInputError(`${label} must be a finite number.`);
  return value;
};

const optionalString = (value: unknown, label: string): string | null | undefined => {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new DynamicToolInputError(`${label} must be a string.`);
  return value;
};

const computerAction = (value: unknown): OpenAIResponsesComputerAction => {
  if (!isRecord(value) || typeof value.type !== 'string') throw new DynamicToolInputError('Computer action must be an object with a type.');
  const coordinate = (entry: unknown, label: string) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) throw new DynamicToolInputError(`${label} must be a finite number.`);
  };
  const keys = (entry: unknown, required: boolean) => {
    if (entry === undefined && !required) return;
    if (entry === null && !required) return;
    stringArray(entry, 'computer action.keys');
  };
  switch (value.type) {
  case 'click':
    if (!['left', 'right', 'wheel', 'back', 'forward'].includes(String(value.button))) throw new DynamicToolInputError('Computer click has an invalid button.');
    coordinate(value.x, 'computer click.x');
    coordinate(value.y, 'computer click.y');
    keys(value.keys, false);
    break;
  case 'double_click':
    coordinate(value.x, 'computer double_click.x');
    coordinate(value.y, 'computer double_click.y');
    if (value.keys !== null) keys(value.keys, true);
    break;
  case 'drag':
    if (!Array.isArray(value.path) || value.path.some(point => !isRecord(point) || typeof point.x !== 'number' || typeof point.y !== 'number')) {
      throw new DynamicToolInputError('Computer drag.path must contain coordinate objects.');
    }
    for (const point of value.path) {
      coordinate(point.x, 'computer drag.path.x');
      coordinate(point.y, 'computer drag.path.y');
    }
    keys(value.keys, false);
    break;
  case 'keypress':
    keys(value.keys, true);
    break;
  case 'move':
    coordinate(value.x, 'computer move.x');
    coordinate(value.y, 'computer move.y');
    keys(value.keys, false);
    break;
  case 'screenshot':
  case 'wait':
    break;
  case 'scroll':
    for (const field of ['scroll_x', 'scroll_y', 'x', 'y']) coordinate(value[field], `computer scroll.${field}`);
    keys(value.keys, false);
    break;
  case 'type':
    if (typeof value.text !== 'string') throw new DynamicToolInputError('Computer type.text must be a string.');
    break;
  default:
    throw new DynamicToolInputError(`Unknown computer action '${value.type}'.`);
  }
  return value as OpenAIResponsesComputerAction;
};

const computerSafetyChecks = (value: unknown): OpenAIResponsesComputerSafetyCheck[] => {
  if (!Array.isArray(value) || value.some(check => !isRecord(check) || typeof check.id !== 'string')) {
    throw new DynamicToolInputError('Computer pending_safety_checks must be an array of checks with IDs.');
  }
  return value as OpenAIResponsesComputerSafetyCheck[];
};

const projectStructuredClientCall = (
  call: OpenAIResponsesOutputFunctionCall,
  tool: DynamicCallable,
  args: Record<string, unknown>,
): ProjectedCall => {
  const kind = tool.type;
  if (kind !== 'shell' && kind !== 'local_shell' && kind !== 'apply_patch') {
    throw new DynamicToolInputError(`Tool '${tool.name}' is not a structured client tool.`);
  }
  const input = args.arguments;
  if (!isRecord(input) || args.text !== undefined) throw new DynamicToolInputError(`${kind} requires structured arguments.`);
  const itemId = call.id ?? `${kind}_${crypto.randomUUID().replaceAll('-', '')}`;
  if (kind === 'apply_patch') {
    const operation = input.operation;
    if (!isRecord(operation) || typeof operation.path !== 'string') throw new DynamicToolInputError('apply_patch requires an operation with a path.');
    if (operation.type !== 'create_file' && operation.type !== 'update_file' && operation.type !== 'delete_file') {
      throw new DynamicToolInputError('apply_patch has an unknown operation type.');
    }
    if (operation.type !== 'delete_file' && typeof operation.diff !== 'string') {
      throw new DynamicToolInputError('apply_patch create/update operations require a diff string.');
    }
    const item: OpenAIResponsesApplyPatchCallItem = {
      type: 'apply_patch_call', id: itemId, call_id: call.call_id,
      operation: operation.type === 'delete_file'
        ? { type: 'delete_file', path: operation.path }
        : { type: operation.type, path: operation.path, diff: operation.diff as string },
      status: 'completed',
    };
    return { item, itemId, input };
  }
  const action = input.action;
  if (!isRecord(action)) throw new DynamicToolInputError(`${kind} requires an action object.`);
  if (kind === 'shell') {
    const environment = input.environment === undefined ? tool.environment : input.environment;
    if (environment !== undefined && environment !== null && (!isRecord(environment)
      || (environment.type !== 'local' && (environment.type !== 'container_reference' || typeof environment.container_id !== 'string')))) {
      throw new DynamicToolInputError('shell environment must be local or a container reference.');
    }
    const item: OpenAIResponsesShellCallItem = {
      type: 'shell_call', id: itemId, call_id: call.call_id,
      action: {
        commands: stringArray(action.commands, 'shell action.commands'),
        ...(action.max_output_length === undefined ? {} : { max_output_length: optionalNumber(action.max_output_length, 'shell action.max_output_length') }),
        ...(action.timeout_ms === undefined ? {} : { timeout_ms: optionalNumber(action.timeout_ms, 'shell action.timeout_ms') }),
      },
      ...(environment === undefined ? {} : {
        environment: environment === null
          ? null
          : environment.type === 'local'
            ? { type: 'local' as const }
            : { type: 'container_reference' as const, container_id: environment.container_id as string },
      }),
      status: 'completed',
    };
    return { item, itemId, input };
  }
  if (action.type !== 'exec') throw new DynamicToolInputError('local_shell action.type must be exec.');
  const env = action.env;
  if (!isRecord(env) || Object.values(env).some(value => typeof value !== 'string')) {
    throw new DynamicToolInputError('local_shell action.env must map strings to strings.');
  }
  const item: OpenAIResponsesLocalShellCallItem = {
    type: 'local_shell_call', id: itemId, call_id: call.call_id,
    action: {
      type: 'exec', command: stringArray(action.command, 'local_shell action.command'), env: env as Record<string, string>,
      ...(action.timeout_ms === undefined ? {} : { timeout_ms: optionalNumber(action.timeout_ms, 'local_shell action.timeout_ms') }),
      ...(action.user === undefined ? {} : { user: optionalString(action.user, 'local_shell action.user') }),
      ...(action.working_directory === undefined ? {} : { working_directory: optionalString(action.working_directory, 'local_shell action.working_directory') }),
    },
    status: 'completed',
  };
  return { item, itemId, input };
};

const projectComputerCall = (
  call: OpenAIResponsesOutputFunctionCall,
  tool: DynamicCallable,
  args: Record<string, unknown>,
): ProjectedCall => {
  if (!isRecord(args.arguments) || args.text !== undefined) throw new DynamicToolInputError('Computer tools require structured arguments.');
  const itemId = call.id ?? `cu_${crypto.randomUUID().replaceAll('-', '')}`;
  const input = args.arguments;
  let item: OpenAIResponsesComputerCallItem;
  if (tool.type === 'computer') {
    if (!Array.isArray(input.actions) || input.actions.length === 0) {
      throw new DynamicToolInputError('Computer actions must be a nonempty array.');
    }
    item = {
      type: 'computer_call', id: itemId, call_id: call.call_id,
      actions: input.actions.map(computerAction),
      status: 'completed',
    };
  } else {
    item = {
      type: 'computer_call', id: itemId, call_id: call.call_id,
      action: computerAction(input.action),
      pending_safety_checks: computerSafetyChecks(input.pending_safety_checks),
      status: 'completed',
    };
  }
  return { item, itemId, input };
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
  if (tool.type === 'shell' || tool.type === 'local_shell' || tool.type === 'apply_patch') {
    return projectStructuredClientCall(call, tool, args);
  }
  if (tool.type === 'computer' || tool.type === 'computer_use_preview') {
    return projectComputerCall(call, tool, args);
  }
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
  item.type === 'function_call' && item.namespace === undefined && item.name === DYNAMIC_TOOL_DISPATCHER;

const projectResponse = (
  response: OpenAIResponsesResult,
  prepared: PreparedDynamicTools,
  projectedByCallId: Map<string, ProjectedCall>,
): OpenAIResponsesResult => ({
  ...response,
  tools: prepared.clientTools ?? [],
  tool_choice: prepared.clientToolChoice ?? 'auto',
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
