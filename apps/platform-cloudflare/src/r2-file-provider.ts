import type { FileListPage, FileProvider } from '@floway-dev/platform';

export interface R2BucketLike {
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

// R2 caps both `list` and `delete` at 1000 keys per call.
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#list
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#delete
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

  async listPage(prefix: string, cursor: string | null, limit: number): Promise<FileListPage> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error(`File list limit must be positive: ${limit}`);
    const page = await this.bucket.list({
      prefix,
      ...(cursor === null ? {} : { cursor }),
      limit: Math.min(limit, R2_BATCH_LIMIT),
    });
    if (page.truncated && page.cursor === undefined) throw new Error('R2 truncated a file listing without a cursor');
    return {
      keys: page.objects.map(object => object.key),
      nextCursor: page.truncated ? page.cursor! : null,
    };
  }

  async deleteKeys(keys: readonly string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += R2_BATCH_LIMIT) {
      await this.bucket.delete(keys.slice(index, index + R2_BATCH_LIMIT));
    }
  }
}
