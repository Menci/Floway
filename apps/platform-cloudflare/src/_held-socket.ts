// Internal helper (underscore prefix = not a platform export): adapts a
// DialedSocket into the DuplexStream shape `@floway-dev/http` consumes, plus
// an idempotent close.
//
// Why this exists as its own ~tiny class: the DurableHttpSessionDO is the
// first piece of code in the workspace that OWNS a live outbound socket across
// inbound requests. If a future need arises for a raw persistent TCP duplex
// (not HTTP), HeldSocket is the seam to promote into a platform `DurableSocketDial`
// contract + a `DurableSocketDO` — a mechanical refactor rather than a rewrite.

import type { DuplexStream } from '@floway-dev/http';
import type { DialedSocket } from '@floway-dev/platform';

export class HeldSocket {
  constructor(private readonly dialed: DialedSocket) {}

  /** The duplex view `fetchOnStream` reads/writes. */
  asDuplex(): DuplexStream {
    return { readable: this.dialed.readable, writable: this.dialed.writable };
  }

  /** Idempotent — safe to call on an already-closed/errored socket. */
  close(): Promise<void> {
    return this.dialed.close();
  }
}
