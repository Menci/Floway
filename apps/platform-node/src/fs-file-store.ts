import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import type { FileBody, FileStore } from '@floway-dev/platform';

// Keys use POSIX separators so filesystem and object-storage deployments agree.
// The operator's umask, mount permissions and service account own confidentiality;
// a file contains the writer's already-encoded bytes, including pipeline redaction.
// Access to this directory exposes recorded request contents and is equivalent to
// access to the gateway's stored configuration. We do not add a second permission policy.
export class FsFileStore implements FileStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  async put(key: string, body: FileBody): Promise<void> {
    const reader = body instanceof Uint8Array ? null : body.getReader();
    let staging: string | undefined;
    try {
      const path = this.pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      staging = `${path}.${randomUUID()}.tmp`;
      {
        await using file = await open(staging, 'wx');
        if (body instanceof Uint8Array) await file.writeFile(body);
        else {
          for (;;) {
            const { done, value } = await reader!.read();
            if (done) break;
            await file.writeFile(value);
          }
        }
      }
      await rename(staging, path);
    } catch (error) {
      const errors: unknown[] = [error];
      if (reader !== null) {
        try { await reader.cancel(error); } catch (cleanupError) { if (cleanupError !== error) errors.push(cleanupError); }
      }
      if (staging !== undefined) {
        try { await rm(staging, { force: true }); } catch (cleanupError) { errors.push(cleanupError); }
      }
      if (errors.length > 1) throw new AggregateError(errors, 'File write failed and cleanup also failed', { cause: error });
      throw error;
    } finally { reader?.releaseLock(); }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async deleteKeys(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map(async key => await rm(this.pathFor(key), { force: true })));
  }

  // Resolve a key against `root` and reject paths that escape it. Even though
  // the FileStore contract treats keys as opaque, callers are not required
  // to scrub user-controlled segments and a `..`-laden key would otherwise
  // walk to arbitrary host paths under R2 it would simply be a strange key.
  private pathFor(key: string): string {
    if (isAbsolute(key)) throw new Error(`FsFileStore: absolute keys are not supported (${key})`);
    const path = resolve(this.root, ...key.split('/'));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`FsFileStore: key escapes root (${key})`);
    }
    return path;
  }
}
