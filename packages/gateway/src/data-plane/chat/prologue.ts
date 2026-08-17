// Opening a chat run. The seam every non-chat family uses builds the services a run is
// given; a chat run needs three more, and this is where they come from.
//
// All three are the live half of resolution. A `ModelCandidate` never enters the record —
// `move()` would freeze the provider's own models cache — and neither does the payload
// affinity materializes for one, because materializing rewrites client-carried state for the
// upstream that will see it and the result is per candidate. So the resolver keeps them and
// the stage that dials asks for them back by selector, which is the same shape the shared
// services already use for the candidate itself.

import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from './shared/gateway-ctx.ts';
import type { ChatServices } from './stages.ts';
import type { ApiKey } from '../../repo/types.ts';
import type { AttemptSelector } from '../pipeline/facts.ts';
import { gatewayCtxOptions, prologueFor, runDumpOf, type Ingress, type Prologue } from '../pipeline/serve.ts';
import type { StatefulResponsesStore } from './responses/items/store.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { ModelCandidate } from '@floway-dev/provider';

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
    /** Native Responses entries persist their items; every other source gets a scratchpad,
     *  so the server-tool shim's request-private state always has a home. */
    readonly storeFactory: (apiKey: ApiKey, requestStartedAt: number) => StatefulResponsesStore;
  },
): ChatPrologue => {
  // One options object, read twice: the context is built from it, and the run recording it
  // opened is what the runner's events are written to. Building it a second time would call
  // `takeRequestBody` again and hand the dump an empty buffer — which is exactly how every
  // chat turn once came to write a record holding no events.
  const ctxOptions = gatewayCtxOptions(c, ingress, options);
  const gateway = createChatGatewayCtxFromHono(c, ctxOptions, options.storeFactory);
  const base = prologueFor(gateway, ingress, runDumpOf(ctxOptions));

  let materialize: ((candidate: ModelCandidate) => unknown) | undefined;
  return {
    ...base,
    gateway,
    services: {
      ...base.services,
      gateway,
      rememberChatSelection: payloadFor => { materialize = payloadFor; },
      chatPayloadFor: (selector: AttemptSelector) => {
        if (materialize === undefined) {
          throw new Error('chatPayloadFor: nothing was resolved in this run; the selector did not come from it');
        }
        return materialize(base.services.resolveAttempt(selector));
      },
      selectAffinity: candidate => { gateway.affinity.select(candidate); },
    },
  };
};
