import type { ChatOperation, ChatOutcome, CollectedChatResult } from './pipeline.ts';
import { localResponseHead } from '../../pipeline/encode.ts';
import { defineOperationStage, type OperationEvent } from '../../pipeline/facts.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import type { Facts } from '@floway-dev/pipeline';
import type { ProtocolError, ProtocolStreamError } from '@floway-dev/provider';

export const MAX_CHAT_COLLECTION_BYTES = 64 * 1024 * 1024;

export interface ChatCollectionFailure extends ProtocolError {
  status: number;
}

export interface ChatCollector<Op extends ChatOperation> {
  push(event: OperationEvent<Op>): ChatCollectionFailure | void;
  finish(): { kind: 'result'; result: CollectedChatResult<Op> } | ChatCollectionFailure;
}

export const collectChat = <Op extends ChatOperation, Delivery extends { stream: boolean }>(
  operation: Op,
  createCollector: (delivery: Delivery) => ChatCollector<Op>,
  streamError: (error: ProtocolStreamError) => ChatCollectionFailure,
) => {
  const outcomeKey: string = `response.${operation}`;
  const responseKeys: readonly string[] = ['response.http', outcomeKey];
  const encoder = new TextEncoder();
  return defineOperationStage({
    name: `${operation}.collect`,
    through: {
      request: { needs: ['request.delivery'], provides: [], consumes: [] },
      response: { needs: responseKeys, provides: responseKeys, consumes: [] },
    },
    async execute(facts, scope) {
      const delivery = facts['request.delivery'] as Delivery;
      const answer = await scope.next(facts);
      const outcome = answer[outcomeKey] as ChatOutcome<Op>;
      if (delivery.stream || outcome.kind !== 'stream') return answer;

      const fail = ({ status, ...error }: ChatCollectionFailure): Facts => {
        const head = answer['response.http'] as HttpResponseFact | null;
        const http = head?.status === status ? head : { ...localResponseHead(status), headers: head?.headers ?? [], body: null };
        return { ...answer, 'response.http': http, [outcomeKey]: error };
      };

      const collector = createCollector(delivery);
      let bytes = 0;
      for await (const item of scope.read(outcome.stream)) {
        if (!item.ok) {
          scope.discard(outcome.stream);
          return fail(streamError(item.error));
        }
        bytes += encoder.encode(JSON.stringify(item.value)).byteLength;
        if (bytes > MAX_CHAT_COLLECTION_BYTES) {
          throw new RangeError(`${operation} response exceeds the ${MAX_CHAT_COLLECTION_BYTES}-byte collection limit`);
        }
        const failure = collector.push(item.value);
        if (failure) {
          scope.discard(outcome.stream);
          return fail(failure);
        }
      }
      const collected = collector.finish();
      return collected.kind === 'error' ? fail(collected) : { ...answer, [outcomeKey]: collected };
    },
  });
};
