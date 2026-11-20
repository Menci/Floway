import type { FileBody, FileStore } from '@floway-dev/platform';

export interface R2UploadedPartLike { partNumber: number; etag: string }
export interface R2MultipartUploadLike {
  uploadPart(partNumber: number, value: Uint8Array): Promise<R2UploadedPartLike>;
  complete(parts: R2UploadedPartLike[]): Promise<unknown>;
  abort(): Promise<void>;
}

export interface R2BucketLike {
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(keys: string | string[]): Promise<void>;
  createMultipartUpload(key: string): Promise<R2MultipartUploadLike>;
}

// R2 caps both `list` and `delete` at 1000 keys per call.
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#list
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#delete
const R2_BATCH_LIMIT = 1000;

// Generated streams have no known content length, so R2's single put cannot consume
// them. Multipart parts must be at least 5 MiB except for the last part.
// https://developers.cloudflare.com/r2/objects/upload-objects/#multipart-upload
const R2_PART_BYTES = 5 * 1024 * 1024;

export class R2FileStore implements FileStore {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: string, body: FileBody): Promise<void> {
    if (body instanceof Uint8Array) { await this.bucket.put(key, body); return; }
    const reader = body.getReader();
    let upload: R2MultipartUploadLike | undefined;
    const parts: R2UploadedPartLike[] = [];
    let buffer = new Uint8Array(R2_PART_BYTES);
    let length = 0;
    const flush = async () => {
      upload ??= await this.bucket.createMultipartUpload(key);
      parts.push(await upload.uploadPart(parts.length + 1, length === buffer.byteLength ? buffer : buffer.subarray(0, length)));
      buffer = new Uint8Array(R2_PART_BYTES);
      length = 0;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let offset = 0;
        while (offset < value.byteLength) {
          const count = Math.min(buffer.byteLength - length, value.byteLength - offset);
          buffer.set(value.subarray(offset, offset + count), length);
          length += count;
          offset += count;
          if (length === buffer.byteLength) await flush();
        }
      }
      if (upload === undefined) await this.bucket.put(key, buffer.subarray(0, length));
      else {
        if (length > 0) await flush();
        await upload.complete(parts);
      }
    } catch (error) {
      const errors: unknown[] = [error];
      try { await reader.cancel(error); } catch (cleanupError) { if (cleanupError !== error) errors.push(cleanupError); }
      if (upload !== undefined) {
        try { await upload.abort(); } catch (cleanupError) { errors.push(cleanupError); }
      }
      if (errors.length > 1) throw new AggregateError(errors, 'R2 upload failed and cleanup also failed', { cause: error });
      throw error;
    } finally { reader.releaseLock(); }
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
