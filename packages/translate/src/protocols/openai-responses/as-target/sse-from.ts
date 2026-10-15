import { toOpenAIResponsesInputAssistantTurn, type OpenAIResponsesItemState, type OpenAIResponsesOutputAssistantState } from './assistant-turn.ts';
import { usageToIR } from './usage.ts';
import {
  createIRBuilder,
  type IRRecord,
  type IRItemHandle,
  type IRPartHandle,
  type IRRelativePath,
  type IRWriteHandle,
} from '../../../ir/stream.ts';
import type { IRSourceCitation } from '../../../ir/types.ts';
import type { RoundTripReader } from '../../../round-trip/stream.ts';
import { appendField, createFieldState, type FieldStates } from '../../../round-trip/thin/reference-builder.ts';
import { TextCoordinateIndex } from '../../../shared/text-coordinate-index.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  OpenAIResponsesAnnotation,
  OpenAIResponsesStreamLogprobEx,
  OpenAIResponsesOutputContentBlock,
  OpenAIResponsesOutputItemEx,
  OpenAIResponsesReasoningText,
  OpenAIResponsesResultEx,
  OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';

type ReasoningFieldState = OpenAIResponsesItemState<Extract<OpenAIResponsesOutputItemEx, { type: 'reasoning' }>, FieldStates>;
type MessageFieldState = OpenAIResponsesItemState<Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>, FieldStates>;
type FunctionFieldState = OpenAIResponsesItemState<Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, FieldStates>;
type CustomFieldState = OpenAIResponsesItemState<Extract<OpenAIResponsesOutputItemEx, { type: 'custom_tool_call' }>, FieldStates>;
type TextFieldStateNode = NonNullable<NonNullable<MessageFieldState['content']>[number]>;

interface ResponsesItemStateBase {
  readonly outputIndex: number;
  readonly id: string;
  item?: IRItemHandle;
  readonly parts: Map<number, ResponsesPartState>;
  readonly reasoning: Record<'summary' | 'content', ResponsesTextTarget[]>;
  readonly logprobs: Map<number, { readonly index: number }>;
  closed: boolean;
  finalSnapshot?: OpenAIResponsesOutputItemEx;
}

type ResponsesItemState = ResponsesItemStateBase & (
      | { readonly type: 'message'; fieldState?: MessageFieldState }
      | { readonly type: 'reasoning'; fieldState?: ReasoningFieldState }
      | { readonly type: 'function_call'; fieldState?: FunctionFieldState; toolText?: ResponsesTextTarget }
      | { readonly type: 'custom_tool_call'; fieldState?: CustomFieldState; toolText?: ResponsesTextTarget }
      | { readonly type: Exclude<OpenAIResponsesOutputItemEx['type'], 'message' | 'reasoning' | 'function_call' | 'custom_tool_call'>; fieldState?: never }
    );

interface ResponsesTextPartState extends ResponsesTextTarget {
  readonly type: 'output_text' | 'refusal';
  readonly handle: IRPartHandle;
  readonly path: 'text' | 'refusal';
  coordinateIndex?: TextCoordinateIndex;
  text?: string;
  annotationsInitialized: boolean;
}
interface ResponsesImagePartState { readonly type: 'image'; readonly handle: IRPartHandle }
type ResponsesPartState = ResponsesTextPartState | ResponsesImagePartState;
interface ResponsesTextTarget extends WriteTarget {
  fieldState?: FieldStates['text'] | null;
  fieldStateNode?: TextFieldStateNode | FunctionFieldState | CustomFieldState;
}

interface WriteTarget {
  readonly handle: IRWriteHandle;
  readonly path: IRRelativePath;
}

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length
    && leftEntries.every(([key, value]) => Object.hasOwn(right, key) && deepEqual(value, Reflect.get(right, key)));
};

const annotationToIR = (coordinateIndex: () => TextCoordinateIndex, annotation: OpenAIResponsesAnnotation): IRSourceCitation | undefined => {
  if (annotation.type === 'url_citation') {
    return {
      type: 'source_citation',
      source_kind: 'url',
      source: annotation.url,
      source_label: annotation.title,
      output_text_range: coordinateIndex().codePointRangeToIR(annotation.start_index, annotation.end_index),
    };
  }
  if (annotation.type === 'file_citation') {
    return { type: 'source_citation', source_kind: 'document', source: annotation.file_id, source_label: annotation.filename };
  }
  if (annotation.type === 'container_file_citation') {
    return {
      type: 'source_citation',
      source_kind: 'document',
      source: annotation.file_id,
      source_label: annotation.filename,
      output_text_range: coordinateIndex().codePointRangeToIR(annotation.start_index, annotation.end_index),
    };
  }
  if (annotation.type === 'file_path') return { type: 'source_citation', source_kind: 'document', source: annotation.file_id };
  return undefined;
};

// The IR item an output item opens as; other item types have no IR counterpart.
const irItemSeed = (item: OpenAIResponsesOutputItemEx): Record<string, unknown> | undefined => {
  switch (item.type) {
  case 'message':
  case 'image_generation_call':
    return { type: 'message', content: [] };
  case 'reasoning':
    return undefined;
  case 'function_call':
    return { type: 'function_call', ...(item.call_id === undefined ? {} : { call_id: item.call_id }), name: item.name, arguments: '' };
  case 'custom_tool_call':
    return { type: 'custom_tool_call', ...(item.call_id === undefined ? {} : { call_id: item.call_id }), name: item.name, input: '' };
  default:
    return undefined;
  }
};

const itemId = (item: OpenAIResponsesOutputItemEx): unknown => 'id' in item ? item.id : undefined;

export const irFromOpenAIResponses = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  options: { roundTrip: RoundTripReader<'openaiResponses'> },
): AsyncGenerator<IRRecord> {
  const ir = createIRBuilder();
  const items = new Map<number, ResponsesItemState>();
  const outputState: OpenAIResponsesOutputAssistantState<FieldStates> = [];
  let started = false;
  let finished = false;
  let responseIdentity: { id: string; model: string } | undefined;
  let audioItem: IRItemHandle | undefined;
  let audioPart: IRPartHandle | undefined;
  const audioFields = new Set<'data' | 'transcript'>();
  const audioDone = new Set<'data' | 'transcript'>();
  let hasTools = false;
  let nextLogprobGroup = 0;

  const responseMetadata = (response: OpenAIResponsesResultEx): void => {
    if (typeof response.id !== 'string') throw new TypeError('Responses response envelope requires an id');
    if (typeof response.model !== 'string') throw new TypeError('Responses response envelope requires a model');
    if (responseIdentity === undefined) {
      responseIdentity = { id: response.id, model: response.model };
      ir.assign(['model'], response.model);
    } else {
      if (response.id !== responseIdentity.id) throw new TypeError(`Responses response id changed from ${responseIdentity.id} to ${response.id}`);
      if (response.model !== responseIdentity.model) {
        throw new TypeError(`Responses response model changed from ${responseIdentity.model} to ${response.model}`);
      }
    }
    if (typeof response.service_tier === 'string') ir.assign(['service_tier'], response.service_tier);
    if (response.usage != null) ir.usage(usageToIR(response.usage));
  };

  const requireOutputIndex = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Responses output_index must be a nonnegative safe integer: ${String(value)}`);
    }
    return value;
  };

  const openItem = (outputIndex: number, item: OpenAIResponsesOutputItemEx): ResponsesItemState => {
    outputIndex = requireOutputIndex(outputIndex);
    if (items.has(outputIndex)) throw new Error(`Duplicate Responses output_item.added at index ${outputIndex}`);
    const id = itemId(item);
    if (typeof id !== 'string') throw new TypeError('Responses output items require an id');
    const seed = irItemSeed(item);
    const handle = seed === undefined ? undefined : ir.item(0, seed);
    const base: ResponsesItemStateBase = {
      outputIndex,
      id,
      item: handle,
      parts: new Map(),
      reasoning: { summary: [], content: [] },
      logprobs: new Map(),
      closed: false,
    };
    const state: ResponsesItemState = item.type === 'message' ? { ...base, type: item.type, fieldState: { content: [] } }
      : item.type === 'reasoning' ? { ...base, type: item.type, fieldState: { summary: [] } }
        : item.type === 'function_call' ? { ...base, type: item.type, fieldState: {} }
          : item.type === 'custom_tool_call' ? { ...base, type: item.type, fieldState: {} }
            : { ...base, type: item.type };
    if (state.type === 'message' || state.type === 'reasoning' || state.type === 'function_call' || state.type === 'custom_tool_call') outputState[outputIndex] = state.fieldState;
    if (item.type === 'function_call' || item.type === 'custom_tool_call') hasTools = true;
    items.set(outputIndex, state);
    return state;
  };

  const requireItem = (outputIndex: number): ResponsesItemState => {
    outputIndex = requireOutputIndex(outputIndex);
    const item = items.get(outputIndex);
    if (item === undefined) throw new Error(`Responses event arrived before its output item at index ${outputIndex}`);
    if (item.closed) throw new Error(`Responses event arrived after output item ${outputIndex} closed`);
    return item;
  };

  const validateSnapshotIdentity = (state: ResponsesItemState, item: OpenAIResponsesOutputItemEx): void => {
    if (item.type !== state.type) throw new TypeError(`Responses output item type changed from ${state.type} to ${item.type}`);
    const id = itemId(item);
    if (id !== state.id) throw new TypeError(`Responses output item id changed from ${state.id} to ${String(id)}`);
  };

  const ensureToolText = (state: ResponsesItemState): ResponsesTextTarget => {
    if (state.item === undefined || (state.type !== 'function_call' && state.type !== 'custom_tool_call')) throw new TypeError('Responses tool text requires a tool item');
    if (state.toolText !== undefined) return state.toolText;
    const fieldState = createFieldState('text');
    if (state.type === 'function_call') {
      const node = state.fieldState ??= {};
      node.arguments = fieldState;
      state.toolText = { handle: state.item, path: 'arguments', fieldState, fieldStateNode: node };
    } else {
      const node = state.fieldState ??= {};
      node.input = fieldState;
      state.toolText = { handle: state.item, path: 'input', fieldState, fieldStateNode: node };
    }
    outputState[state.outputIndex] = state.fieldState;
    return state.toolText;
  };

  const appendTextAtom = (target: ResponsesTextTarget, text: string): void => {
    if (target.fieldState === undefined || target.fieldState === null) target.handle.append(target.path, text);
    else target.handle.append(target.path, text, [appendField(options.roundTrip.builder, target.fieldState, text)]);
  };
  const reconcileAppend = (target: ResponsesTextTarget, snapshot: unknown): string => {
    const { handle, path } = target;
    const absolutePath = handle.resolve(path);
    if (typeof snapshot !== 'string') throw new TypeError(`Responses text snapshot must be a string at ${JSON.stringify(absolutePath)}`);
    const current = handle.current<string>(path);
    // Responses done events are final snapshots in the official SDK. Downstream
    // reports show both missing suffixes and empty snapshots after streamed text.
    // https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/internal/responses/response-accumulator.ts#L836-L858
    // https://github.com/langchain-ai/langchain/issues/37625
    // An empty snapshot therefore carries no replacement value.
    // https://github.com/can1357/oh-my-pi/issues/5146
    // https://github.com/can1357/oh-my-pi/pull/5149
    if (snapshot === '' && current !== undefined && current !== '') return current;
    if (current === snapshot) return snapshot;
    if (current === undefined) {
      handle.initialize(path, '');
      if (snapshot !== '') appendTextAtom(target, snapshot);
      return snapshot;
    }
    if (!snapshot.startsWith(current)) {
      throw new TypeError(`Responses snapshot cannot replace streamed text at ${JSON.stringify(absolutePath)}`);
    }
    const suffix = snapshot.slice(current.length);
    if (suffix !== '') {
      if (current === '') appendTextAtom(target, suffix);
      else {
        if (target.fieldState !== undefined) {
          target.fieldState = null;
          if (target.fieldStateNode !== undefined) for (const key of Object.keys(target.fieldStateNode)) Reflect.deleteProperty(target.fieldStateNode, key);
        }
        handle.append(path, suffix);
      }
    }
    return snapshot;
  };

  const reconcileAssign = ({ handle, path }: WriteTarget, snapshot: unknown): void => {
    if (snapshot === undefined) return;
    const current = handle.current(path);
    if (current === undefined) handle.assign(path, snapshot);
    else if (!deepEqual(current, snapshot)) {
      throw new TypeError(`Responses snapshot conflicts with streamed value at ${JSON.stringify(handle.resolve(path))}`);
    }
  };

  const ensureReasoningText = (state: ResponsesItemState, field: 'summary' | 'content', index: number): ResponsesTextTarget => {
    if (state.type !== 'reasoning') throw new TypeError('Responses reasoning text requires a reasoning item');
    state.item ??= ir.item(0, { type: 'reasoning' });
    state.item.ensure(field, []);
    const targets = state.reasoning[field];
    const length = targets.length;
    if (index > length) throw new TypeError(`Responses ${field} index is not contiguous`);
    if (index === length) {
      state.item.initialize([field, index], '');
      const fieldState = createFieldState('text');
      const fieldStateNode = { text: fieldState };
      const nativeState = state.fieldState ??= {};
      const parts = nativeState[field] ??= [];
      parts[index] = fieldStateNode;
      outputState[state.outputIndex] = nativeState;
      targets.push({ handle: state.item, path: [field, index], fieldState, fieldStateNode });
    }
    return targets[index];
  };

  const ensureMessagePart = (
    state: ResponsesItemState,
    contentIndex: number,
    part: { readonly type: string; readonly annotations?: readonly unknown[] },
  ): ResponsesTextPartState => {
    if (state.item === undefined || state.type !== 'message') throw new TypeError('Responses content part requires a message item');
    if (contentIndex > state.parts.size) throw new TypeError('Responses content indexes must be contiguous');
    if (contentIndex === state.parts.size) {
      let partState: ResponsesTextPartState;
      if (part.type === 'output_text') {
        const fieldState = createFieldState('text');
        const fieldStateNode = { text: fieldState };
        const nativeState = state.fieldState ??= { content: [] };
        const content = nativeState.content ??= [];
        content[contentIndex] = fieldStateNode;
        outputState[state.outputIndex] = nativeState;
        partState = {
          path: 'text', fieldState, fieldStateNode,
          type: part.type,
          handle: state.item.part({ type: 'text', text: '', ...(part.annotations === undefined ? {} : { annotations: [] }) }),
          text: '',
          annotationsInitialized: part.annotations !== undefined,
        };
      } else if (part.type === 'refusal') {
        const fieldState = createFieldState('text');
        const fieldStateNode = { refusal: fieldState };
        const nativeState = state.fieldState ??= {};
        const content = nativeState.content ??= [];
        content[contentIndex] = fieldStateNode;
        outputState[state.outputIndex] = nativeState;
        partState = { type: part.type, path: 'refusal', handle: state.item.part({ type: 'refusal', refusal: '' }), annotationsInitialized: false, fieldState, fieldStateNode };
      } else throw new TypeError(`Responses message cannot contain ${part.type}`);
      state.parts.set(contentIndex, partState);
    }
    const partState = state.parts.get(contentIndex);
    if (partState === undefined || partState.type === 'image') throw new TypeError('Responses content indexes must be contiguous');
    return partState;
  };

  const ensureLogprobGroup = (state: ResponsesItemState, contentIndex: number, part: IRPartHandle): number => {
    let group = state.logprobs.get(contentIndex);
    if (group !== undefined) return group.index;
    const choice = ir.choice(0);
    choice.ensure('logprobs', []);
    if (state.item === undefined) throw new TypeError('Responses content part requires a message item');
    group = { index: nextLogprobGroup++ };
    choice.initialize(['logprobs', group.index], {
      scope: 'text_part',
      item_index: state.item.index,
      content_index: part.index,
      tokens: [],
    });
    state.logprobs.set(contentIndex, group);
    return group.index;
  };

  const reconcileLogprobs = (
    state: ResponsesItemState,
    contentIndex: number,
    part: ResponsesTextPartState,
    tokens: readonly OpenAIResponsesStreamLogprobEx[] | undefined,
  ): void => {
    if (tokens === undefined || tokens.length === 0) return;
    const group = ensureLogprobGroup(state, contentIndex, part.handle);
    const choice = ir.choice(0);
    tokens.forEach((token, index) => reconcileAssign({ handle: choice, path: ['logprobs', group, 'tokens', index] }, token));
  };

  const reconcileAnnotations = (
    part: ResponsesTextPartState,
    text: string,
    annotations: readonly (OpenAIResponsesAnnotation | null)[] | undefined,
  ): void => {
    if (annotations === undefined) return;
    if (!part.annotationsInitialized) {
      part.handle.assign('annotations', []);
      part.annotationsInitialized = true;
    }
    const converted = annotations.flatMap(annotation => {
      if (annotation === null) return [];
      const value = annotationToIR(() => {
        part.coordinateIndex ??= TextCoordinateIndex.codePointsToUTF16(text);
        part.coordinateIndex.assertUTF16Length(text.length);
        return part.coordinateIndex;
      }, annotation);
      return value === undefined ? [] : [value];
    });
    converted.forEach((annotation, index) => reconcileAssign({ handle: part.handle, path: ['annotations', index] }, annotation));
  };

  const reconcilePartText = (part: ResponsesTextPartState, snapshot: string): string => {
    const previous = part.text;
    if (previous === undefined) throw new TypeError('Responses output text state is invalid');
    const text = reconcileAppend(part, snapshot);
    if (!text.startsWith(previous)) throw new TypeError('Responses output text state cannot move backwards');
    part.coordinateIndex?.append(text.slice(previous.length));
    part.text = text;
    return text;
  };

  const reconcilePart = (state: ResponsesItemState, contentIndex: number, part: OpenAIResponsesOutputContentBlock | OpenAIResponsesReasoningText): void => {
    if (state.type === 'message') {
      const partState = ensureMessagePart(state, contentIndex, part);
      if (part.type === 'output_text') {
        reconcilePartText(partState, part.text);
        reconcileAnnotations(partState, part.text, part.annotations);
        reconcileLogprobs(state, contentIndex, partState, part.logprobs);
      } else if (part.type === 'refusal') reconcileAppend(partState, part.refusal);
    } else if (state.type === 'reasoning') {
      if (part.type !== 'reasoning_text') throw new TypeError(`Responses reasoning cannot contain ${part.type}`);
      reconcileAppend(ensureReasoningText(state, 'content', contentIndex), part.text);
    }
  };

  const reconcileItem = (state: ResponsesItemState, item: OpenAIResponsesOutputItemEx): void => {
    validateSnapshotIdentity(state, item);
    if (item.type === 'reasoning') {
      if (!Array.isArray(item.summary)) throw new TypeError('Responses reasoning snapshot requires summary');
      item.summary.forEach((part, index) => reconcileAppend(ensureReasoningText(state, 'summary', index), part.text));
      item.content?.forEach((part, index) => reconcileAppend(ensureReasoningText(state, 'content', index), part.text));
      return;
    }
    if (state.item === undefined) return;
    if (item.type === 'message') {
      if (!Array.isArray(item.content)) throw new TypeError('Responses message snapshot requires content');
      item.content.forEach((part, index) => reconcilePart(state, index, part));
    } else if (item.type === 'function_call') {
      reconcileAssign({ handle: state.item, path: 'call_id' }, item.call_id);
      reconcileAssign({ handle: state.item, path: 'name' }, item.name);
      reconcileAppend(ensureToolText(state), item.arguments);
    } else if (item.type === 'custom_tool_call') {
      reconcileAssign({ handle: state.item, path: 'call_id' }, item.call_id);
      reconcileAssign({ handle: state.item, path: 'name' }, item.name);
      reconcileAppend(ensureToolText(state), item.input);
    } else if (item.type === 'image_generation_call' && item.result != null) {
      if (state.parts.size === 0) {
        const handle = state.item.part({
          type: 'image',
          image: { data: item.result, ...(item.output_format == null ? {} : { mime_type: `image/${item.output_format}` }) },
        });
        state.parts.set(0, { type: 'image', handle });
      } else {
        const part = state.parts.get(0);
        if (part === undefined) throw new TypeError('Responses image state is invalid');
        const { handle } = part;
        reconcileAssign({ handle, path: ['image', 'data'] }, item.result);
        if (item.output_format != null) {
          reconcileAssign({ handle, path: ['image', 'mime_type'] }, `image/${item.output_format}`);
        }
      }
    }
  };

  const closeItem = (state: ResponsesItemState, snapshot: OpenAIResponsesOutputItemEx): void => {
    if (state.item !== undefined) {
      const status = 'status' in snapshot ? snapshot.status : undefined;
      state.item.end(status === 'incomplete' ? 'incomplete' : undefined);
    }
    if (snapshot.type === 'message' && state.type === 'message' && state.fieldState?.content !== undefined) state.fieldState.content.length = snapshot.content.length;
    if (snapshot.type === 'reasoning' && state.type === 'reasoning' && state.fieldState !== undefined) {
      if (state.fieldState.summary !== undefined) state.fieldState.summary.length = snapshot.summary.length;
      if (snapshot.content === undefined) delete state.fieldState.content;
      else if (state.fieldState.content !== undefined) state.fieldState.content.length = snapshot.content.length;
    }
    state.closed = true;
    state.finalSnapshot = snapshot;
  };

  for await (const frame of frames) {
    if (frame.type === 'done') throw new Error('Responses done arrived without a terminal response');
    const e = frame.event;
    if (e.type === 'error') { ir.event({ type: 'error', error: 'error' in e ? e.error ?? e : e }); yield* ir.drain(); return; }
    if (e.type === 'response.failed' && e.response.error?.code !== 'bio_policy' && e.response.error?.code !== 'cyber_policy') {
      // `error` is nullable on a Response, so a failure may carry no description.
      ir.event({ type: 'error', error: e.response.error ?? { message: 'Response failed due to unknown error.' } });
      yield* ir.drain();
      return;
    }
    if (!started && !('response' in e)) throw new Error('Responses event arrived before the initial response envelope');

    if ('response' in e) {
      const response = e.response;
      responseMetadata(response);
      if (!started) {
        if (responseIdentity === undefined) throw new Error('Responses metadata did not establish response identity');
        ir.choice(0);
        ir.event({ type: 'start', id: responseIdentity.id, ...(response.created_at === undefined ? {} : { created: response.created_at }) });
        started = true;
      }
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(e.type)) {
        if (!Array.isArray(response.output)) throw new TypeError('Responses terminal envelope requires output');
        for (let outputIndex = 0; outputIndex < response.output.length; outputIndex++) {
          const item = response.output[outputIndex];
          let state = items.get(outputIndex);
          state ??= openItem(outputIndex, item);
          if (state.closed) {
            validateSnapshotIdentity(state, item);
            if (state.finalSnapshot === undefined || !deepEqual(state.finalSnapshot, item)) {
              throw new TypeError(`Responses terminal snapshot conflicts with closed output item ${outputIndex}`);
            }
          } else {
            reconcileItem(state, item);
            closeItem(state, item);
          }
        }
        const omitted = [...items.keys()].filter(index => index >= response.output.length);
        if (omitted.length > 0) throw new Error(`Responses terminal envelope omitted output indexes: ${omitted.join(', ')}`);
        if (audioItem !== undefined) {
          if (audioPart === undefined) throw new TypeError('Responses audio state is invalid');
          for (const field of ['data', 'transcript'] as const) {
            if (audioFields.has(field) && !audioDone.has(field)) throw new Error('Responses audio stream ended without its done event');
          }
          audioItem.end();
        }
        const policy = response.error?.code === 'cyber_policy' ? 'cyber' : response.error?.code === 'bio_policy' ? 'bio' : undefined;
        if (policy !== undefined) ir.choice(0).assign('refusal', { category: policy, explanation: response.error?.message });
        outputState.length = response.output.length;
        const input = toOpenAIResponsesInputAssistantTurn<FieldStates>(response.output, outputState);
        options.roundTrip.onAssistantTurn(0, input.turn, input.state);
        const incompleteReason = response.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length';
        const finishReason = policy !== undefined ? 'content_filter'
          : e.type === 'response.incomplete' ? incompleteReason
            : hasTools ? 'tool_calls' : 'stop';
        ir.choice(0).end(finishReason);
        ir.event({ type: 'finish', status: e.type === 'response.incomplete' ? 'incomplete' : 'completed' });
        finished = true;
      }
    } else if (e.type === 'response.output_item.added') {
      const state = openItem(e.output_index, e.item);
      reconcileItem(state, e.item);
    } else if (e.type === 'response.output_item.done') {
      const state = requireItem(e.output_index);
      reconcileItem(state, e.item);
      closeItem(state, e.item);
    } else if (e.type === 'response.audio.delta' || e.type === 'response.audio.transcript.delta') {
      const field = e.type === 'response.audio.delta' ? 'data' : 'transcript';
      if (audioItem === undefined) {
        audioItem = ir.item(0, { type: 'message', content: [] });
        audioPart = audioItem.part({ type: 'audio', audio: {} });
      }
      const part = audioPart;
      if (part === undefined) throw new TypeError('Responses audio state is invalid');
      part.ensure(['audio', field], '');
      audioFields.add(field);
      if (e.delta !== '') part.append(['audio', field], e.delta);
    } else if (e.type === 'response.audio.done' || e.type === 'response.audio.transcript.done') {
      audioDone.add(e.type === 'response.audio.done' ? 'data' : 'transcript');
    } else if ('output_index' in e) {
      const state = requireItem(e.output_index);
      if (state.item !== undefined || state.type === 'reasoning') {
        if (e.type === 'response.content_part.added' || e.type === 'response.content_part.done') {
          reconcilePart(state, e.content_index, e.part);
          if (e.type === 'response.content_part.done' && state.type === 'message') {
            const part = state.parts.get(e.content_index);
            if (part === undefined) throw new TypeError('Responses content part state is invalid');
            part.handle.end();
          }
        } else if (e.type === 'response.reasoning_summary_part.added' || e.type === 'response.reasoning_summary_part.done') {
          reconcileAppend(ensureReasoningText(state, 'summary', e.summary_index), e.part.text);
        } else if (e.type === 'response.output_text.delta' || e.type === 'response.refusal.delta') {
          const part = ensureMessagePart(state, e.content_index, { type: e.type === 'response.refusal.delta' ? 'refusal' : 'output_text', annotations: [] });
          const field = e.type === 'response.refusal.delta' ? 'refusal' : 'text';
          if (e.delta !== '') {
            if (field === 'text') {
              appendTextAtom(part, e.delta);
              part.coordinateIndex?.append(e.delta);
              part.text = `${part.text ?? ''}${e.delta}`;
            } else appendTextAtom(part, e.delta);
          }
          if (e.type === 'response.output_text.delta' && e.logprobs !== undefined) reconcileLogprobs(state, e.content_index, part, e.logprobs);
        } else if (e.type === 'response.output_text.done' || e.type === 'response.refusal.done') {
          const part = ensureMessagePart(state, e.content_index, { type: e.type === 'response.refusal.done' ? 'refusal' : 'output_text', annotations: [] });
          if (e.type === 'response.output_text.done') reconcilePartText(part, e.text);
          else reconcileAppend(part, e.refusal);
          if (e.type === 'response.output_text.done' && e.logprobs !== undefined) reconcileLogprobs(state, e.content_index, part, e.logprobs);
        } else if (e.type === 'response.output_text.annotation.added') {
          if (e.annotation !== null) {
            const part = state.parts.get(e.content_index);
            if (part?.type !== 'output_text') throw new TypeError('Responses output-text annotation requires an output-text part');
            if (part.text === undefined) throw new TypeError('Responses output-text annotation requires an output-text part');
            const annotation = annotationToIR(() => {
              part.coordinateIndex ??= TextCoordinateIndex.codePointsToUTF16(part.text!);
              part.coordinateIndex.assertUTF16Length(part.text!.length);
              return part.coordinateIndex;
            }, e.annotation);
            if (annotation !== undefined) {
              if (!part.annotationsInitialized) {
                part.handle.assign('annotations', []);
                part.annotationsInitialized = true;
              }
              reconcileAssign({ handle: part.handle, path: ['annotations', e.annotation_index] }, annotation);
            }
          }
        } else if (e.type === 'response.function_call_arguments.delta' || e.type === 'response.custom_tool_call_input.delta') {
          const target = ensureToolText(state);
          const field = e.type === 'response.function_call_arguments.delta' ? 'arguments' : 'input';
          if (target.path !== field) throw new TypeError('Responses tool delta does not match its native item');
          if (e.delta !== '') appendTextAtom(target, e.delta);
        } else if (e.type === 'response.function_call_arguments.done' || e.type === 'response.custom_tool_call_input.done') {
          const target = ensureToolText(state);
          const field = e.type === 'response.function_call_arguments.done' ? 'arguments' : 'input';
          if (target.path !== field) throw new TypeError('Responses tool completion does not match its native item');
          reconcileAppend(target, e.type === 'response.function_call_arguments.done' ? e.arguments : e.input);
        } else if (e.type === 'response.reasoning_summary_text.delta' || e.type === 'response.reasoning_text.delta' || e.type === 'response.reasoning.delta') {
          const summary = e.type === 'response.reasoning_summary_text.delta';
          const index = e.type === 'response.reasoning_summary_text.delta' ? e.summary_index : e.content_index;
          const target = ensureReasoningText(state, summary ? 'summary' : 'content', index);
          if (e.delta !== '') appendTextAtom(target, e.delta);
        } else if (e.type === 'response.reasoning_summary_text.done' || e.type === 'response.reasoning_text.done' || e.type === 'response.reasoning.done') {
          const summary = e.type === 'response.reasoning_summary_text.done';
          const index = e.type === 'response.reasoning_summary_text.done' ? e.summary_index : e.content_index;
          reconcileAppend(ensureReasoningText(state, summary ? 'summary' : 'content', index), e.text);
        }
      }
    }
    yield* ir.drain();
    if (finished) return;
  }
  throw new Error('Responses stream ended without a terminal response');
};
