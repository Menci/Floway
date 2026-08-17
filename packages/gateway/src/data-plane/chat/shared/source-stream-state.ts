// What a source's stream turned out to be, read back when the turn settles.
//
// One transport still needs it: the Responses WebSocket writes each frame itself and has to
// decide, when the socket closes, whether what it wrote was a finished turn. Every HTTP
// family answers the same question from its own metered reading instead.

import type { StreamCompletion } from '../../shared/sse.ts';

export class SourceStreamState {
  failed = false;
  completed = false;

  failedAfter(completion: StreamCompletion): boolean {
    return completion === 'error' || this.failed || (completion === 'cancel' && !this.completed);
  }
}
