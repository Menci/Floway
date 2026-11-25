export type Result<T, E> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

declare const managedStream: unique symbol;
declare const deferredValue: unique symbol;

export interface ManagedStream<out T, out E> extends AsyncIterable<Result<T, E>> {
  readonly [managedStream]: true;
}

export interface Deferred<out T> {
  readonly [deferredValue]: true;
  readonly promise: Promise<T>;
}

export interface DeferredController<T> {
  readonly deferred: Deferred<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}
