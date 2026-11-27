import type { ChatRequestFacts, ChatResponseFacts } from '../../pipeline/facts.ts';
import { serializeProtocolItems } from '../../pipeline/stream-transform.ts';
import { getHeader } from '@floway-dev/http';
import { factSpace } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

const { defineStage } = factSpace<Pick<ChatRequestFacts, 'http' | 'model'>, Pick<ChatResponseFacts, 'anthropicMessages'>>();

export const serializeAnthropicMessagesItems = defineStage({
  name: 'anthropicMessages.serialize-stream-items',
  through: {
    request: { needs: ['http', 'model'], provides: [], consumes: [] },
    response: { needs: ['anthropicMessages'], provides: ['anthropicMessages'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.anthropicMessages;
    if (outcome.kind !== 'stream') return answer;
    const userAgent = getHeader(facts.http.headers, 'user-agent');
    if (!facts.model.enabledFlags.includes('serialize-stream-items') && !requiresSerializedAnthropicMessagesItems(userAgent)) {
      return answer;
    }
    const stream = scope.wrapStream(outcome.stream, (source, producer) => serializeProtocolItems<AnthropicMessagesStreamEventEx>(source, producer, event => {
      if (event.type === 'content_block_start') return { index: event.index, kind: 'start' };
      if (event.type === 'content_block_delta') return { index: event.index, kind: 'delta' };
      if (event.type === 'content_block_stop') return { index: event.index, kind: 'end' };
      return undefined;
    }, event => event));
    return { ...answer, anthropicMessages: { kind: 'stream', stream } };
  },
});

// These versions keep convenience-event state on the latest block, rather than the delta's owner.
// https://github.com/vercel/ai/blob/2136151c3c249b86191bbbb7e7655d23df8947a2/packages/anthropic/src/anthropic-language-model.ts#L2732-L2747
// https://github.com/vercel/ai/blob/2136151c3c249b86191bbbb7e7655d23df8947a2/packages/anthropic/src/anthropic-provider.ts#L161-L168
// https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/lib/MessageStream.ts#L459-L509
// https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/client.ts#L978-L980
const requiresSerializedAnthropicMessagesItems = (userAgent: unknown): boolean =>
  typeof userAgent === 'string'
  && (/(?:^|\s)ai-sdk-anthropic\/4\.0\.71(?:\s|$)/.test(userAgent) || /(?:^|\s)Anthropic\/JS 0\.131\.0(?:\s|$)/.test(userAgent));
