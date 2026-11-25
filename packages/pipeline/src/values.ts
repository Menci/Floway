export type Result<T, E> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface ManagedStream<out T, out E> extends AsyncIterable<Result<T, E>> {}

export interface Deferred<out T> {
  readonly promise: Promise<T>;
}

export interface DeferredController<T> {
  readonly deferred: Deferred<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}
