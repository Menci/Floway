import type { GatewayFacts } from '../../../../pipeline/facts.ts';
import type { StreamOutcome } from '../../../../pipeline/serve.ts';
import type { HostedToolLifecycleEvent, HostedToolTerminal } from '../types.ts';
import type { Deferred } from '@floway-dev/pipeline';

/** What one image call is, and what it comes to. */
export interface ImageSubRequestFacts extends GatewayFacts {
  'request.imageGeneration.action': 'generate' | 'edit';
  /** The lifecycle the caller splices into its own answer. */
  'response.imageGeneration.lifecycle': AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal>;
  /** What the call turned out to cost, once its events have run out — which is after this run
   *  has answered, because the caller is what drives them. */
  'response.imageGeneration.streamedUsage': Deferred<StreamOutcome> | null;
}

export type Fields<K extends keyof ImageSubRequestFacts> = { [P in K]: ImageSubRequestFacts[P] };
