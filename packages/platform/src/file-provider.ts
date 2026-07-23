export interface FileProvider {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  deleteKeys(keys: readonly string[]): Promise<void>;
}

let fileProvider: FileProvider | null = null;

export const initFileProvider = (provider: FileProvider): void => {
  fileProvider = provider;
};

export const getFileProvider = (): FileProvider => {
  if (!fileProvider) throw new Error('FileProvider not initialized - call initFileProvider() first');
  return fileProvider;
};

export class MemoryFileProvider implements FileProvider {
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
