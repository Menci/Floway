export interface FileStore {
  put(key: string, body: Uint8Array): Promise<void>;
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

  async put(key: string, body: Uint8Array): Promise<void> {
    this.files.set(key, body.slice());
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(key)?.slice() ?? null;
  }

  async deleteKeys(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.files.delete(key);
  }
}
