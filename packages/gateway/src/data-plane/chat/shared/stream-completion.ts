import type { Deferred } from '@floway-dev/pipeline';

export const protocolCompletionKey = 'response.stream.protocolComplete';

export interface StreamCompletionFacts {
  readonly [protocolCompletionKey]?: Deferred<boolean> | undefined;
}
