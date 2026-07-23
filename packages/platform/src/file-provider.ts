export interface FileListPage {
  keys: string[];
  nextCursor: string | null;
}

export interface FileProvider {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  listPage(prefix: string, cursor: string | null, limit: number): Promise<FileListPage>;
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

  async listPage(prefix: string, cursor: string | null, limit: number): Promise<FileListPage> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error(`File list limit must be positive: ${limit}`);
    const keys = [...this.files.keys()]
      .filter(key => key.startsWith(prefix) && (cursor === null || key > cursor))
      .sort()
      .slice(0, limit);
    return { keys, nextCursor: keys.length === limit ? keys.at(-1)! : null };
  }

  async deleteKeys(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.files.delete(key);
  }
}
