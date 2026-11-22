export interface ManagedStream<out T> extends AsyncIterable<T> {
  readonly label: string;
  close(): Promise<void>;
}

export interface Deferred<out T> {
  readonly name: string;
  readonly promise: Promise<T>;
}

export interface DeferredHandle<T> {
  readonly deferred: Deferred<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export const managedStreams = new WeakSet<ManagedStream<unknown>>();
export const deferreds = new WeakSet<Deferred<unknown>>();

export const isManagedStream = (value: unknown): value is ManagedStream<unknown> =>
  typeof value === 'object' && value !== null && managedStreams.has(value as ManagedStream<unknown>);

export const isDeferred = (value: unknown): value is Deferred<unknown> =>
  typeof value === 'object' && value !== null && deferreds.has(value as Deferred<unknown>);
