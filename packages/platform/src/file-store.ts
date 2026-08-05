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
    this.files.set(key, new Uint8Array(body));
  }

  async get(key: string): Promise<Uint8Array | null> {
    const body = this.files.get(key);
    return body ? new Uint8Array(body) : null;
  }

  async deleteKeys(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.files.delete(key);
  }
}
