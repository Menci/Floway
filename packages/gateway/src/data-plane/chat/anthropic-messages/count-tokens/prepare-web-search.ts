import type { Fields, Counted } from './facts.ts';
import type { ChatServices } from '../../services.ts';
import { prepareAnthropicMessagesWebSearchShimRequest } from '../web-search-shim.ts';
import { defineStage, move } from '@floway-dev/pipeline';

/**
 * Puts the request into the shape the web-search shim would actually send.
 *
 * Anthropic's native `web_search_*` hosted tool becomes an ordinary client tool on the wire,
 * and prior turns' results are rewritten back into the history the upstream issued them
 * with — so a count taken on the client's own body would measure a request no upstream is
 * ever sent. Only the rewrite runs here: there is no stream to intercept and no search to
 * execute, because nothing is generated.
 *
 * `anthropic-messages-web-search-shim` is the whole of the gate, where generation also engages the
 * shim unconditionally on a translated wire: counting has only the native wire, so the
 * structural half of that condition can never hold.
 *
 * A tool definition this protocol rejects is an answer it already holds, which is why it
 * carries the `return` trait.
 */
export const prepareAnthropicMessagesWebSearchRequest = defineStage<
  Fields<'request.chat.anthropicMessages' | 'route.attempt'>,
  Fields<'request.chat.anthropicMessages'>,
  Counted<'response.chat.anthropicMessages'>,
  Counted<'response.chat.anthropicMessages'>,
  Counted<'response.chat.anthropicMessages'> & Fields<'response.usage.billable' | 'response.http.headers' | 'response.http.body'>,
  ChatServices
>({
  name: 'prepareAnthropicMessagesWebSearchRequest',
  through: {
    request: {
      needs: ['request.chat.anthropicMessages', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.anthropicMessages'],
    },
    response: { needs: ['response.chat.anthropicMessages'], consumes: [], provides: [] },
  },
  return: { provides: ['response.chat.anthropicMessages', 'response.usage.billable', 'response.http.headers', 'response.http.body'] },
  execute: async (facts, next) => {
    if (!facts['route.attempt'].flags.includes('anthropic-messages-web-search-shim')) return await next(facts);
    const prepared = prepareAnthropicMessagesWebSearchShimRequest(facts['request.chat.anthropicMessages']);
    if (prepared.type === 'invalid-request') {
      // Nothing was dialled, which is what an empty billed set and an empty header list say
      // on the other two keys.
      return move({
        ...facts,
        'response.chat.anthropicMessages': { status: 400, message: prepared.message },
        'response.usage.billable': [],
        'response.http.headers': [],
        'response.http.body': null,
      });
    }
    // A request that engaged nothing comes back by identity, so the record shows no change
    // where none happened.
    if (prepared.payload === facts['request.chat.anthropicMessages']) return await next(facts);
    return await next({ ...facts, 'request.chat.anthropicMessages': move(prepared.payload) });
  },
});
