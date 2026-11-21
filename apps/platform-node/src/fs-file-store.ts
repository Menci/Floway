import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { FileBody, FileStore } from '@floway-dev/platform';

const STAGING_SEGMENT = '.floway-staging';

const isStagingSegment = (segment: string): boolean => segment.toLowerCase() === STAGING_SEGMENT;

// Filesystem-backed FileStore. Keys use POSIX separators so filesystem and
// object-storage deployments agree. The operator's umask, mount permissions,
// and service account own confidentiality; access to this directory already
// exposes the gateway's stored configuration and recorded request contents.
export class FsFileStore implements FileStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  async put(key: string, body: FileBody): Promise<void> {
    const path = this.pathFor(key);
    const reader = body instanceof Uint8Array ? null : body.getReader();
    let staging: string | undefined;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let stagingHint = Date.now();

    try {
      await mkdir(dirname(path), { recursive: true });
      const stagingDirectory = this.stagingDirectoryFor(path);
      await mkdir(stagingDirectory, { recursive: true });
      staging = join(stagingDirectory, stagingHint.toString(36));
      for (;;) {
        try {
          file = await open(staging, 'wx');
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          stagingHint++;
          staging = join(stagingDirectory, stagingHint.toString(36));
        }
      }

      if (body instanceof Uint8Array) {
        await file.writeFile(body);
      } else {
        for (;;) {
          const { done, value } = await reader!.read();
          if (done) break;
          if (value.byteLength > 0) {
            await file.writeFile(value);
            const now = new Date();
            await file.utimes(now, now);
          }
        }
      }

      await file.close();
      file = undefined;
      await rename(staging, path);
      staging = undefined;
    } catch (error) {
      const failures: unknown[] = [error];
      if (file !== undefined) {
        try {
          await file.close();
        } catch (cleanupError) {
          if (cleanupError !== error) failures.push(cleanupError);
        }
      }
      if (reader !== null) {
        try {
          await reader.cancel(error);
        } catch (cleanupError) {
          if (cleanupError !== error) failures.push(cleanupError);
        }
      }
      if (staging !== undefined) {
        try {
          await rm(staging, { force: true });
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'File write failed and cleanup also failed', { cause: error });
      }
      throw error;
    } finally {
      reader?.releaseLock();
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async deleteKeys(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map(async key => {
      const path = this.pathFor(key);
      await Promise.all([
        rm(path, { force: true }),
        rm(this.stagingDirectoryFor(path), { recursive: true, force: true }),
      ]);
    }));
  }

  // Staging sits beside the destination so `rename` stays atomic across mounted
  // key prefixes. The basename digest scopes orphan cleanup to the target key
  // without interpreting a public key as a temporary filename.
  private stagingDirectoryFor(path: string): string {
    return join(dirname(path), STAGING_SEGMENT, createHash('sha256').update(basename(path)).digest('hex'));
  }

  private pathFor(key: string): string {
    if (key.length === 0) throw new Error('FsFileStore: keys must not be empty');
    if (key.split('/').some(isStagingSegment)) {
      throw new Error(`FsFileStore: reserved staging segment (${key})`);
    }
    if (isAbsolute(key)) throw new Error(`FsFileStore: absolute keys are not supported (${key})`);

    const path = resolve(this.root, ...key.split('/'));
    if (path === this.root || !path.startsWith(this.root + sep)) {
      throw new Error(`FsFileStore: key escapes root (${key})`);
    }
    if (relative(this.root, path).split(sep).some(isStagingSegment)) {
      throw new Error(`FsFileStore: reserved staging segment (${key})`);
    }
    return path;
  }
}
