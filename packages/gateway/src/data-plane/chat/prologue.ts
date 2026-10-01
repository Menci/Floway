// Chat admission adds the request-owned store and affinity ports to shared run services.

import type { ChatServices } from './services.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from './shared/gateway-ctx.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { ApiKey } from '../../repo/types.ts';
import { gatewayCtxOptions, prologueFor, runDumpOf, type Ingress, type Prologue } from '../pipeline/serve.ts';
import type { OpenAIResponsesStatefulStore } from './openai-responses/items/store.ts';

export interface ChatPrologue extends Prologue {
  readonly services: ChatServices;
  readonly gateway: ChatGatewayCtx;
}

export const openChatPrologue = (
  c: AuthedContext,
  ingress: Ingress,
  options: {
    readonly wantsStream: boolean;
    readonly model?: string;
    /** Native OpenAI Responses entries persist their items; every other source gets a scratchpad,
     *  so the hosted-tool shim's request-private state always has a home. */
    readonly storeFactory: (apiKey: ApiKey, requestStartedAt: number) => OpenAIResponsesStatefulStore;
  },
): ChatPrologue => {
  // One options object, read twice: the context is built from it, and the run recording it
  // opened is what the runner's events are written to. Building it a second time would call
  // `takeRequestBody` again and hand the dump an empty buffer — which is exactly how every
  // chat turn once came to write a record holding no events.
  const ctxOptions = gatewayCtxOptions(c, ingress, options);
  const gateway = createChatGatewayCtxFromHono(c, ctxOptions, options.storeFactory);
  const base = prologueFor(gateway, ingress, runDumpOf(ctxOptions));

  return {
    ...base,
    gateway,
    services: {
      ...base.services,
      gateway,
      selectAffinity: candidate => { gateway.affinity.select(candidate); },
    },
  };
};
