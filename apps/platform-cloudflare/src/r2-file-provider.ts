import type { FileProvider } from '@floway-dev/platform';

export interface R2BucketLike {
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: readonly { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

// R2 caps `delete` at 1000 keys per call and `list` at 1000 objects per page,
// so paginate with the listing cursor and delete each page as we go.
const R2_BATCH_LIMIT = 1000;

export class R2FileProvider implements FileProvider {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.bucket.put(key, body);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }

  async deleteKeys(keys: readonly string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += R2_BATCH_LIMIT) {
      await this.bucket.delete(keys.slice(index, index + R2_BATCH_LIMIT));
    }
  }

  async deletePrefixPage(prefix: string, limit: number): Promise<{ deleted: number; complete: boolean }> {
    if (prefix === '') throw new Error('R2FileProvider.deletePrefixPage: refusing empty prefix');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > R2_BATCH_LIMIT) {
      throw new RangeError(`R2FileProvider.deletePrefixPage limit must be from 1 to ${R2_BATCH_LIMIT}`);
    }
    const page = await this.bucket.list({ prefix, limit });
    await this.deleteKeys(page.objects.map(object => object.key));
    return { deleted: page.objects.length, complete: !page.truncated };
  }

  async deletePrefix(prefix: string): Promise<void> {
    // Refuse the entire bucket: a stray empty-string prefix would otherwise
    // wipe every spilled payload across tenants. Matches FsFileProvider.
    if (prefix === '') throw new Error('R2FileProvider.deletePrefix: refusing empty prefix');
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: R2_BATCH_LIMIT });
      await this.deleteKeys(page.objects.map(object => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: R2_BATCH_LIMIT });
      for (const object of page.objects) keys.push(object.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }
}
