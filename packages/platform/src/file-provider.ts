export interface FileProvider {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  deletePrefix(prefix: string): Promise<void>;
  // Returns every key whose name starts with prefix. Implementations enumerate
  // exhaustively (paginating internally where the backing store requires it);
  // callers receive a flat list of full keys.
  listKeys(prefix: string): Promise<string[]>;
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

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) this.files.delete(key);
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter(key => key.startsWith(prefix));
  }
}
