// RPC does not preserve custom Error prototypes, so expected stream outcomes
// cross this boundary as data and are reconstructed by the client adapter.
// https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/
export type LogStreamAppendResult =
  | { kind: 'appended' }
  | { kind: 'hole'; length: number }
  | { kind: 'ended' | 'expired' };

export type LogStreamReadResult =
  | { kind: 'chunk'; bytes: ArrayBuffer }
  | { kind: 'tail'; ended: boolean }
  | { kind: 'expired' };

export interface LogStreamStub {
  open(): Promise<void>;
  exists(): Promise<boolean>;
  append(atOffset: number, bytes: ArrayBuffer): Promise<LogStreamAppendResult>;
  end(): Promise<'ended' | 'expired'>;
  readChunk(fromOffset: number): Promise<LogStreamReadResult>;
  fetch(request: Request): Promise<Response>;
}
