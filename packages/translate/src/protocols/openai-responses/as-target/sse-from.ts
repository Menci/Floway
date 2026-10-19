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
import { TextCoordinateIndex } from '../../../shared/text-coordinate-index.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  OpenAIResponsesAnnotation,
  OpenAIResponsesLogprob,
  OpenAIResponsesOutputContentBlock,
  OpenAIResponsesOutputItemEx,
  OpenAIResponsesReasoningText,
  OpenAIResponsesResultEx,
  OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';

interface ResponsesItemState {
  readonly outputIndex: number;
  readonly type: string;
  readonly id: string;
  readonly item?: IRItemHandle;
  readonly parts: Map<number, ResponsesPartState>;
  readonly reasoningLengths: Record<'summary' | 'content', number>;
  readonly logprobs: Map<number, { readonly index: number; length: number }>;
  closed: boolean;
  finalSnapshot?: OpenAIResponsesOutputItemEx;
}

interface ResponsesTextTarget {
  readonly handle: IRPartHandle;
}

interface ResponsesOutputTextPartState extends ResponsesTextTarget {
  readonly type: 'output_text';
  coordinateIndex?: TextCoordinateIndex;
  text: string;
  annotationsInitialized: boolean;
  readonly annotationOrdinals: Map<number, number | undefined>;
  nextAnnotationOrdinal: number;
}

interface ResponsesRefusalPartState extends ResponsesTextTarget { readonly type: 'refusal' }
interface ResponsesImagePartState { readonly type: 'image'; readonly handle: IRPartHandle }
type ResponsesTextPartState = ResponsesOutputTextPartState | ResponsesRefusalPartState;
type ResponsesPartState = ResponsesTextPartState | ResponsesImagePartState;

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
  const rightObject = right as Record<string, unknown>;
  return leftEntries.length === Object.keys(rightObject).length
    && leftEntries.every(([key, value]) => Object.hasOwn(rightObject, key) && deepEqual(value, rightObject[key]));
};

const closedSnapshotEqual = (left: OpenAIResponsesOutputItemEx, right: OpenAIResponsesOutputItemEx): boolean => {
  if (left.type !== 'reasoning' || right.type !== 'reasoning') return deepEqual(left, right);
  // Replay state is owned by the completed output_item.done snapshot. A later
  // terminal envelope may carry a differently encrypted copy of the same item.
  // https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/responses/responses.ts#L7292-L7298
  const { encrypted_content: _leftEncryptedContent, ...leftSnapshot } = left;
  const { encrypted_content: _rightEncryptedContent, ...rightSnapshot } = right;
  return deepEqual(leftSnapshot, rightSnapshot);
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
    return { type: 'reasoning', id: item.id };
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
): AsyncGenerator<IRRecord> {
  const ir = createIRBuilder();
  const items = new Map<number, ResponsesItemState>();
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
      if (response.model !== responseIdentity.model) {
        throw new TypeError(`Responses response model changed from ${responseIdentity.model} to ${response.model}`);
      }
    }
    if (typeof response.service_tier === 'string') ir.assign(['service_tier'], response.service_tier);
    if (response.usage != null) ir.usage(usageToIR(response.usage));
  };

  const requireOutputIndex = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new RangeError(`Responses output_index must be a nonnegative safe integer: ${String(value)}`);
    }
    return value as number;
  };

  const openItem = (outputIndex: number, item: OpenAIResponsesOutputItemEx): ResponsesItemState => {
    outputIndex = requireOutputIndex(outputIndex);
    if (items.has(outputIndex)) throw new Error(`Duplicate Responses output_item.added at index ${outputIndex}`);
    const id = itemId(item);
    if (typeof id !== 'string') throw new TypeError('Responses output items require an id');
    const seed = irItemSeed(item);
    const handle = seed === undefined ? undefined : ir.item(0, seed);
    const state: ResponsesItemState = {
      outputIndex,
      type: item.type,
      id,
      item: handle,
      parts: new Map(),
      reasoningLengths: { summary: 0, content: 0 },
      logprobs: new Map(),
      closed: false,
    };
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

  const reconcileAppend = ({ handle, path }: WriteTarget, snapshot: unknown): string => {
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
      if (snapshot !== '') handle.append(path, snapshot);
      return snapshot;
    }
    if (!snapshot.startsWith(current)) {
      throw new TypeError(`Responses snapshot cannot replace streamed text at ${JSON.stringify(absolutePath)}`);
    }
    const suffix = snapshot.slice(current.length);
    if (suffix !== '') handle.append(path, suffix);
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

  const ensureReasoningText = (state: ResponsesItemState, field: 'summary' | 'content', index: number): WriteTarget => {
    if (state.item === undefined || state.type !== 'reasoning') throw new TypeError('Responses reasoning text requires a reasoning item');
    state.item.ensure(field, []);
    const length = state.reasoningLengths[field];
    if (index > length) throw new TypeError(`Responses ${field} index is not contiguous`);
    if (index === length) {
      state.item.initialize([field, index], '');
      state.reasoningLengths[field]++;
    }
    return { handle: state.item, path: [field, index] };
  };

  const ensureMessagePartSlot = (
    state: ResponsesItemState,
    contentIndex: number,
    create: (item: IRItemHandle) => ResponsesTextPartState,
  ): ResponsesTextPartState => {
    if (state.item === undefined || state.type !== 'message') throw new TypeError('Responses content part requires a message item');
    if (contentIndex > state.parts.size) throw new TypeError('Responses content indexes must be contiguous');
    if (contentIndex === state.parts.size) state.parts.set(contentIndex, create(state.item));
    const partState = state.parts.get(contentIndex);
    if (partState === undefined || partState.type === 'image') throw new TypeError('Responses content indexes must be contiguous');
    return partState;
  };

  const ensureOutputTextPart = (
    state: ResponsesItemState,
    contentIndex: number,
    annotations: readonly unknown[] | undefined,
  ): ResponsesOutputTextPartState => {
    const part = ensureMessagePartSlot(state, contentIndex, item => ({
      type: 'output_text',
      handle: item.part({ type: 'text', text: '', ...(annotations === undefined ? {} : { annotations: [] }) }),
      text: '',
      annotationsInitialized: annotations !== undefined,
      annotationOrdinals: new Map(),
      nextAnnotationOrdinal: 0,
    }));
    if (part.type !== 'output_text') throw new TypeError(`Responses content part type changed from ${part.type} to output_text`);
    return part;
  };

  const ensureRefusalPart = (state: ResponsesItemState, contentIndex: number): ResponsesRefusalPartState => {
    const part = ensureMessagePartSlot(state, contentIndex, item => ({
      type: 'refusal',
      handle: item.part({ type: 'refusal', refusal: '' }),
    }));
    if (part.type !== 'refusal') throw new TypeError(`Responses content part type changed from ${part.type} to refusal`);
    return part;
  };

  const ensureLogprobGroup = (state: ResponsesItemState, contentIndex: number, part: IRPartHandle): { readonly index: number; length: number } => {
    let group = state.logprobs.get(contentIndex);
    if (group !== undefined) return group;
    const choice = ir.choice(0);
    choice.ensure('logprobs', []);
    if (state.item === undefined) throw new TypeError('Responses content part requires a message item');
    group = { index: nextLogprobGroup++, length: 0 };
    choice.initialize(['logprobs', group.index], {
      scope: 'text_part',
      item_index: state.item.index,
      content_index: part.index,
      tokens: [],
    });
    state.logprobs.set(contentIndex, group);
    return group;
  };

  const appendLogprobs = (
    state: ResponsesItemState,
    contentIndex: number,
    part: ResponsesOutputTextPartState,
    tokens: readonly OpenAIResponsesLogprob[] | undefined,
  ): void => {
    if (tokens === undefined || tokens.length === 0) return;
    const group = ensureLogprobGroup(state, contentIndex, part.handle);
    const choice = ir.choice(0);
    for (const token of tokens) choice.assign(['logprobs', group.index, 'tokens', group.length++], token);
  };

  const reconcileLogprobs = (
    state: ResponsesItemState,
    contentIndex: number,
    part: ResponsesOutputTextPartState,
    tokens: readonly OpenAIResponsesLogprob[] | undefined,
  ): void => {
    if (tokens === undefined || tokens.length === 0) return;
    const group = ensureLogprobGroup(state, contentIndex, part.handle);
    const choice = ir.choice(0);
    tokens.forEach((token, index) => reconcileAssign({ handle: choice, path: ['logprobs', group.index, 'tokens', index] }, token));
    group.length = Math.max(group.length, tokens.length);
  };

  const reconcileAnnotation = (
    part: ResponsesOutputTextPartState,
    text: string,
    nativeIndex: number,
    annotation: OpenAIResponsesAnnotation | null,
  ): void => {
    if (!Number.isSafeInteger(nativeIndex) || nativeIndex < 0) throw new RangeError(`Responses annotation_index must be a nonnegative safe integer: ${nativeIndex}`);
    const converted = annotation === null ? undefined : annotationToIR(() => {
      part.coordinateIndex ??= TextCoordinateIndex.codePointsToUTF16(text);
      part.coordinateIndex.assertUTF16Length(text.length);
      return part.coordinateIndex;
    }, annotation);
    let ordinal: number | undefined;
    if (part.annotationOrdinals.has(nativeIndex)) {
      ordinal = part.annotationOrdinals.get(nativeIndex);
      if ((ordinal === undefined) !== (converted === undefined)) throw new TypeError(`Responses annotation changed projection at index ${nativeIndex}`);
    } else {
      if (nativeIndex !== part.annotationOrdinals.size) throw new TypeError('Responses annotation indexes must be contiguous');
      ordinal = converted === undefined ? undefined : part.nextAnnotationOrdinal++;
      part.annotationOrdinals.set(nativeIndex, ordinal);
    }
    if (converted === undefined || ordinal === undefined) return;
    if (!part.annotationsInitialized) {
      part.handle.assign('annotations', []);
      part.annotationsInitialized = true;
    }
    reconcileAssign({ handle: part.handle, path: ['annotations', ordinal] }, converted);
  };

  const reconcileAnnotations = (
    part: ResponsesOutputTextPartState,
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
    if (part.annotationOrdinals.size === 0) {
      let ordinal = 0;
      for (const [index, annotation] of annotations.entries()) {
        const projected = annotation === null ? undefined : ordinal++;
        part.annotationOrdinals.set(index, projected);
      }
      part.nextAnnotationOrdinal = ordinal;
    }
  };

  const reconcilePartText = (part: ResponsesOutputTextPartState, snapshot: string): string => {
    const previous = part.text;
    const text = reconcileAppend({ handle: part.handle, path: 'text' }, snapshot);
    if (!text.startsWith(previous)) throw new TypeError('Responses output text state cannot move backwards');
    part.coordinateIndex?.append(text.slice(previous.length));
    part.text = text;
    return text;
  };

  const reconcilePart = (state: ResponsesItemState, contentIndex: number, part: OpenAIResponsesOutputContentBlock | OpenAIResponsesReasoningText): void => {
    if (state.type === 'message') {
      if (part.type === 'output_text') {
        const partState = ensureOutputTextPart(state, contentIndex, part.annotations);
        reconcilePartText(partState, part.text);
        reconcileAnnotations(partState, part.text, part.annotations);
        reconcileLogprobs(state, contentIndex, partState, part.logprobs);
      } else if (part.type === 'refusal') {
        reconcileAppend({ handle: ensureRefusalPart(state, contentIndex).handle, path: 'refusal' }, part.refusal);
      } else throw new TypeError(`Responses message cannot contain ${part.type}`);
    } else if (state.type === 'reasoning') {
      if (part.type !== 'reasoning_text') throw new TypeError(`Responses reasoning cannot contain ${part.type}`);
      reconcileAppend(ensureReasoningText(state, 'content', contentIndex), part.text);
    }
  };

  const reconcileItem = (state: ResponsesItemState, item: OpenAIResponsesOutputItemEx, includeEncrypted: boolean): void => {
    validateSnapshotIdentity(state, item);
    if (state.item === undefined) return;
    if (item.type === 'message') {
      if (!Array.isArray(item.content)) throw new TypeError('Responses message snapshot requires content');
      item.content.forEach((part, index) => reconcilePart(state, index, part));
    } else if (item.type === 'reasoning') {
      if (!Array.isArray(item.summary)) throw new TypeError('Responses reasoning snapshot requires summary');
      item.summary.forEach((part, index) => reconcileAppend(ensureReasoningText(state, 'summary', index), part.text));
      item.content?.forEach((part, index) => reconcileAppend(ensureReasoningText(state, 'content', index), part.text));
      if (includeEncrypted) reconcileAssign({ handle: state.item, path: 'encrypted_content' }, item.encrypted_content);
    } else if (item.type === 'function_call') {
      reconcileAssign({ handle: state.item, path: 'call_id' }, item.call_id);
      reconcileAssign({ handle: state.item, path: 'name' }, item.name);
      reconcileAppend({ handle: state.item, path: 'arguments' }, item.arguments);
    } else if (item.type === 'custom_tool_call') {
      reconcileAssign({ handle: state.item, path: 'call_id' }, item.call_id);
      reconcileAssign({ handle: state.item, path: 'name' }, item.name);
      reconcileAppend({ handle: state.item, path: 'input' }, item.input);
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
        ir.choice(0);
        ir.event({ type: 'start', id: responseIdentity!.id, ...(response.created_at === undefined ? {} : { created: response.created_at }) });
        started = true;
      }
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(e.type)) {
        if (response.output != null && !Array.isArray(response.output)) throw new TypeError('Responses terminal envelope output must be an array');
        const reportedOutput = response.output ?? [];
        const terminalOutput = reportedOutput.length === 0
          ? [...items.entries()].toSorted(([left], [right]) => left - right).map(([outputIndex, state]) => {
              if (!state.closed || state.finalSnapshot === undefined) {
                throw new Error(`Responses terminal envelope omitted output indexes: ${outputIndex}`);
              }
              return state.finalSnapshot;
            })
          : reportedOutput;
        for (let outputIndex = 0; outputIndex < terminalOutput.length; outputIndex++) {
          const item = terminalOutput[outputIndex];
          let state = items.get(outputIndex);
          state ??= openItem(outputIndex, item);
          if (state.closed) {
            validateSnapshotIdentity(state, item);
            if (state.finalSnapshot === undefined || !closedSnapshotEqual(state.finalSnapshot, item)) {
              throw new TypeError(`Responses terminal snapshot conflicts with closed output item ${outputIndex}`);
            }
          } else {
            reconcileItem(state, item, true);
            closeItem(state, item);
          }
        }
        const omitted = [...items.keys()].filter(index => index >= terminalOutput.length);
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
      reconcileItem(state, e.item, false);
    } else if (e.type === 'response.output_item.done') {
      const state = requireItem(e.output_index);
      reconcileItem(state, e.item, true);
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
      if (state.item !== undefined) {
        if (e.type === 'response.content_part.added' || e.type === 'response.content_part.done') {
          reconcilePart(state, e.content_index, e.part);
          if (e.type === 'response.content_part.done' && state.type === 'message') {
            const part = state.parts.get(e.content_index);
            if (part === undefined) throw new TypeError('Responses content part state is invalid');
            part.handle.end();
          }
        } else if (e.type === 'response.reasoning_summary_part.added' || e.type === 'response.reasoning_summary_part.done') {
          reconcileAppend(ensureReasoningText(state, 'summary', e.summary_index), e.part.text);
        } else if (e.type === 'response.output_text.delta') {
          const part = ensureOutputTextPart(state, e.content_index, []);
          if (e.delta !== '') reconcilePartText(part, `${part.text}${e.delta}`);
          if (e.logprobs !== undefined) appendLogprobs(state, e.content_index, part, e.logprobs);
        } else if (e.type === 'response.refusal.delta') {
          const part = ensureRefusalPart(state, e.content_index);
          if (e.delta !== '') part.handle.append('refusal', e.delta);
        } else if (e.type === 'response.output_text.done') {
          const part = ensureOutputTextPart(state, e.content_index, []);
          reconcilePartText(part, e.text);
          if (e.logprobs !== undefined) reconcileLogprobs(state, e.content_index, part, e.logprobs);
        } else if (e.type === 'response.refusal.done') {
          reconcileAppend({ handle: ensureRefusalPart(state, e.content_index).handle, path: 'refusal' }, e.refusal);
        } else if (e.type === 'response.output_text.annotation.added') {
          const part = state.parts.get(e.content_index);
          if (part?.type !== 'output_text') throw new TypeError('Responses output-text annotation requires an output-text part');
          reconcileAnnotation(part, part.text, e.annotation_index, e.annotation);
        } else if (e.type === 'response.function_call_arguments.delta' || e.type === 'response.custom_tool_call_input.delta') {
          if (e.delta !== '') state.item.append(e.type === 'response.function_call_arguments.delta' ? 'arguments' : 'input', e.delta);
        } else if (e.type === 'response.function_call_arguments.done' || e.type === 'response.custom_tool_call_input.done') {
          const field = e.type === 'response.function_call_arguments.done' ? 'arguments' : 'input';
          reconcileAppend({ handle: state.item, path: field }, e.type === 'response.function_call_arguments.done' ? e.arguments : e.input);
        } else if (e.type === 'response.reasoning_summary_text.delta' || e.type === 'response.reasoning_text.delta' || e.type === 'response.reasoning.delta') {
          const summary = e.type === 'response.reasoning_summary_text.delta';
          const index = e.type === 'response.reasoning_summary_text.delta' ? e.summary_index : e.content_index;
          const target = ensureReasoningText(state, summary ? 'summary' : 'content', index);
          if (e.delta !== '') target.handle.append(target.path, e.delta);
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
