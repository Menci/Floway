import type { FileStore } from '@floway-dev/platform';

interface UploadedPart { partNumber: number; etag: string }

interface MultipartUpload {
  uploadPart(partNumber: number, body: Uint8Array): Promise<UploadedPart>;
  complete(parts: UploadedPart[]): Promise<unknown>;
  abort(): Promise<void>;
}

export interface R2BucketLike {
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null): Promise<unknown>;
  createMultipartUpload(key: string): Promise<MultipartUpload>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(keys: string | string[]): Promise<void>;
}

// R2 caps both `list` and `delete` at 1000 keys per call.
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#list
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#delete
const R2_BATCH_LIMIT = 1000;

// R2 requires a known stream length for put(). Multipart uploads can send
// fixed-size parts as they arrive, with a shorter final part.
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2bucket-definition
// https://developers.cloudflare.com/r2/objects/upload-objects/#multipart-upload
const R2_PART_SIZE = 5 * 1024 * 1024;

export class R2FileStore implements FileStore {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.bucket.put(key, body);
  }

  async putStream(key: string, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    let part = new Uint8Array(0);
    const parts: UploadedPart[] = [];
    let upload: MultipartUpload | undefined;
    let filled = 0;
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        const chunk = next.value;
        for (let offset = 0; offset < chunk.length;) {
          const length = Math.min(chunk.length - offset, R2_PART_SIZE - filled);
          if (filled + length > part.length) {
            const grown = new Uint8Array(Math.min(R2_PART_SIZE, Math.max(filled + length, part.length * 2)));
            grown.set(part.subarray(0, filled));
            part = grown;
          }
          part.set(chunk.subarray(offset, offset + length), filled);
          offset += length;
          filled += length;
          if (filled === R2_PART_SIZE) {
            upload ??= await this.bucket.createMultipartUpload(key);
            parts.push(await upload.uploadPart(parts.length + 1, part));
            filled = 0;
          }
        }
      }
      const lastPart = part.subarray(0, filled);
      if (upload === undefined) {
        await this.bucket.put(key, lastPart);
      } else {
        if (filled > 0) parts.push(await upload.uploadPart(parts.length + 1, lastPart));
        await upload.complete(parts);
      }
    } catch (error) {
      const cleanup = await Promise.allSettled([reader.cancel(error), upload?.abort()]);
      const failures = cleanup.flatMap(result => result.status === 'rejected' && result.reason !== error ? [result.reason] : []);
      if (failures.length) throw new AggregateError([error, ...failures], `Failed to write and clean up R2 object ${key}`);
      throw error;
    } finally {
      reader.releaseLock();
    }
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
}
