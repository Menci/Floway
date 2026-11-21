export type LogStreamAppendResult =
  | { kind: 'appended' }
  | { kind: 'hole'; length: number }
  | { kind: 'ended' }
  | { kind: 'expired' };

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
