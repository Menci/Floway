export type FileBody = Uint8Array | ReadableStream<Uint8Array>;

export interface FileStore {
  /** Consumes the body and publishes the complete object atomically at EOF. */
  put(key: string, body: FileBody): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  deleteKeys(keys: readonly string[]): Promise<void>;
}

let fileStore: FileStore | null = null;

export const initFileStore = (store: FileStore): void => {
  fileStore = store;
};

export const getFileStore = (): FileStore => {
  if (!fileStore) throw new Error('FileStore not initialized - call initFileStore() first');
  return fileStore;
};

export class MemoryFileStore implements FileStore {
  private readonly files = new Map<string, Uint8Array>();

  async put(key: string, body: FileBody): Promise<void> {
    if (body instanceof Uint8Array) {
      this.files.set(key, body.slice());
      return;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value.slice());
        byteLength += value.byteLength;
      }

      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.files.set(key, bytes);
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await reader.cancel(error);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'MemoryFileStore stream read and cancellation both failed', { cause: error });
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(key)?.slice() ?? null;
  }

  async deleteKeys(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.files.delete(key);
  }
}
