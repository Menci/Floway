import type { GatewayDump } from '../../pipeline/services.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import type { ManagedStream, Result } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import type { ProtocolError, ProtocolResult, ProtocolStreamError } from '@floway-dev/upstream';

export const MAX_CHAT_COLLECTION_BYTES = 64 * 1024 * 1024;

export interface ChatCollectionError {
  readonly status: number;
  readonly outcome: ProtocolError;
}

interface ChatCollector<Event, Output> {
  accept(event: Event): ChatCollectionError | void;
  finish(): ProtocolResult<Output> | ChatCollectionError;
}

type Source<Event> = ManagedStream<Event, ProtocolStreamError>;

interface CollectScope<Event> {
  read(source: Source<Event>): AsyncIterableIterator<Result<Event, ProtocolStreamError>>;
  discard(source: Source<Event>): void;
  readonly services: { readonly dump: GatewayDump | null };
}

const encoder = new TextEncoder();

export const collectChatStream = async <Event, Output extends object>(
  name: string,
  http: HttpResponseFact | null,
  stream: Source<Event>,
  scope: CollectScope<NoInfer<Event>>,
  collector: ChatCollector<NoInfer<Event>, Output>,
  streamError: (error: ProtocolStreamError) => ChatCollectionError,
): Promise<{ http: HttpResponseFact | null; outcome: ProtocolResult<Output> | ProtocolError }> => {
  const failure = ({ status, outcome }: ChatCollectionError) => ({
    http: http?.status === status ? http : { status, statusText: '', headers: http?.headers ?? [], body: null },
    outcome,
  });
  let bytes = 0;
  for await (const item of scope.read(stream)) {
    if (!item.ok) {
      scope.discard(stream);
      if (item.error.kind === 'protocol' && item.error.event !== undefined) scope.services.dump?.frame(eventFrame(item.error.event));
      return failure(streamError(item.error));
    }
    bytes += encoder.encode(JSON.stringify(item.value)).byteLength;
    if (bytes > MAX_CHAT_COLLECTION_BYTES) throw new RangeError(`${name} response exceeds the ${MAX_CHAT_COLLECTION_BYTES}-byte collection limit`);
    scope.services.dump?.frame(eventFrame(item.value));
    const error = collector.accept(item.value);
    if (error !== undefined) {
      scope.discard(stream);
      return failure(error);
    }
  }
  const result = collector.finish();
  return 'outcome' in result ? failure(result) : { http, outcome: result };
};
