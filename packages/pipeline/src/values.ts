export type Facts = Readonly<Record<string, unknown>>;

export type Result<T, E> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

declare const managedStream: unique symbol;
declare const deferredValue: unique symbol;

export interface ManagedStream<out T, out E> {
  readonly [managedStream]: Result<T, E>;
}

export interface Deferred<out T> {
  readonly [deferredValue]: T;
}

export type Handle = ManagedStream<unknown, unknown> | Deferred<unknown>;

export interface StreamCursor<T, E> extends AsyncIterableIterator<Result<T, E>> {
  discard(): void;
}

export interface Read {
  <T, E>(handle: ManagedStream<T, E>): StreamCursor<T, E>;
  <T>(handle: Deferred<T>): Promise<T>;
}
