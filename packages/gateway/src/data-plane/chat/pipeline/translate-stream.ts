import type { ChatOperation } from './facts.ts';
import type { GatewayDump } from '../../pipeline/services.ts';
import type { ManagedStream, Result } from '@floway-dev/pipeline';
import { doneFrame, eventFrame, isJsonObject, type JsonObject, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProtocolStreamError } from '@floway-dev/upstream';

type Stream<T> = ManagedStream<T, ProtocolStreamError>;

interface Reader {
  read<T>(stream: Stream<T>): AsyncIterableIterator<Result<T, ProtocolStreamError>>;
  discard(stream: Stream<unknown>): void;
}

interface StreamWrapper {
  wrapStream<I, O>(stream: Stream<I>, factory: (
    inner: Stream<I>, producer: Reader,
  ) => AsyncGenerator<Result<O, ProtocolStreamError>, void, unknown>): Stream<O>;
}

const isFailureEvent = (value: unknown): value is JsonObject =>
  isJsonObject(value) && ('error' in value || value.type === 'error' || value.type === 'response.failed');

const protocolFailureEvent = (operation: ChatOperation, event: JsonObject): JsonObject | undefined => {
  if (operation === 'openaiResponses') {
    const failed = isJsonObject(event.failed) ? event.failed : undefined;
    const resource = failed?.response;
    if (isJsonObject(resource) && isJsonObject(resource.error)
      && (resource.error.code === 'bio_policy' || resource.error.code === 'cyber_policy')) return failed;
    if (isJsonObject(event.notification)) return event.notification;
    if (failed !== undefined) return failed;
  }
  return isFailureEvent(event) ? event : undefined;
};

const isResponsesPolicyFailure = (operation: ChatOperation, event: JsonObject): boolean => {
  if (operation !== 'openaiResponses' || event.type !== 'response.failed') return false;
  const { response } = event;
  return isJsonObject(response) && isJsonObject(response.error)
    && (response.error.code === 'bio_policy' || response.error.code === 'cyber_policy');
};

const translatedFailureEvent = (source: ChatOperation, event: JsonObject): JsonObject =>
  source === 'openaiResponses'
    ? event.type === 'response.failed' ? { failed: event } : { notification: event }
    : event;

export const translateChatStream = <In, Out>(
  stream: Stream<In>,
  scope: StreamWrapper,
  { source, target, dump }: { source: ChatOperation; target: ChatOperation; dump: GatewayDump | null },
  translate: (frames: AsyncIterable<ProtocolFrame<In>>) => AsyncIterable<ProtocolFrame<Out>>,
): Stream<Out> => scope.wrapStream(stream, async function* (inner, producer) {
  const cursor = producer.read(inner);
  const state: {
    open: boolean;
    error?: ProtocolStreamError;
    policyFailure?: boolean;
  } = { open: true };
  dump?.setUpstreamTargetApi(target);
  const record = <Value>(frame: ProtocolFrame<Value>) => {
    dump?.upstreamFrame(frame);
    return { done: false as const, value: frame };
  };
  const input: AsyncIterableIterator<ProtocolFrame<In>> = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (!state.open) return { done: true, value: undefined };
      const item = await cursor.next();
      if (item.done) {
        state.open = false;
        return record(doneFrame());
      }
      if (item.value.ok) return record(eventFrame(item.value.value));
      const { error } = item.value;
      state.open = false;
      state.error = error;
      producer.discard(inner);
      if (error.kind !== 'protocol' || error.event === undefined) return { done: true, value: undefined };
      const event = protocolFailureEvent(target, error.event);
      if (event === undefined) return { done: true, value: undefined };
      state.policyFailure = isResponsesPolicyFailure(target, event);
      return record(eventFrame(event as In));
    },
  };

  let translatedError: JsonObject | undefined;
  let producedPolicyResult = false;
  for await (const frame of translate(input)) {
    if (frame.type === 'done') continue;
    if (state.error === undefined || state.policyFailure && !isFailureEvent(frame.event)) {
      if (state.policyFailure) producedPolicyResult = true;
      yield { ok: true, value: frame.event };
    } else if (isFailureEvent(frame.event)) {
      if (translatedError !== undefined) throw new Error('Chat translation emitted multiple terminal errors');
      translatedError = frame.event;
    }
  }
  while (state.open) await input.next();
  if (state.error !== undefined && !producedPolicyResult) {
    const error = state.error.kind === 'protocol' && translatedError !== undefined
      ? { ...state.error, event: translatedFailureEvent(source, translatedError) }
      : state.error;
    yield { ok: false, error };
  }
});
