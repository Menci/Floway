import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import type { FileStore } from '@floway-dev/platform';

export interface FsFileStoreWriteOperations {
  writeTemporaryFile(path: string, body: Uint8Array): Promise<void>;
  replaceFile(temporaryPath: string, path: string): Promise<void>;
}

const nodeWriteOperations: FsFileStoreWriteOperations = {
  writeTemporaryFile: async (path, body) => await writeFile(path, body, { flag: 'wx' }),
  replaceFile: rename,
};

// Filesystem-backed FileStore. Every key resolves to a path under `root`.
// Keys use forward-slash POSIX separators (matching R2's surface) and are
// translated to native path segments on the way in/out so the same key reads
// identically on Windows and POSIX hosts.
//
// Threat model: `root` (`FLOWAY_FILES_DIR`) is gateway-trusted. Everything
// dumped here is data the gateway already holds in its database (API keys,
// upstream credentials, request payloads); fs-level access to this directory
// is already equivalent to gateway compromise. We deliberately do not mode
// 0o600 / 0o700 the writes — bodies are stored verbatim and the OS-level
// confidentiality boundary belongs to the operator (umask, mount perms,
// dedicated user). The dashboard redacts sensitive headers at render time
// for human display, but the on-disk record stays untouched so an operator
// can replay or diff against upstream byte-for-byte.
export class FsFileStore implements FileStore {
  private readonly root: string;
  private readonly directoryMutations = new Map<string, Promise<void>>();

  constructor(
    root: string,
    private readonly writeOperations: FsFileStoreWriteOperations = nodeWriteOperations,
  ) {
    // Resolve once so `pathFor` can verify resolved paths still live under it.
    this.root = resolve(root);
    // Ensure the root exists so the first put() doesn't race against a missing
    // directory and so tests / fresh deploys see a consistent structure.
    mkdirSync(this.root, { recursive: true });
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    const directory = dirname(path);
    await this.withDirectoryLock(directory, async () => {
      await mkdir(directory, { recursive: true });
      const temporaryPath = join(directory, `.floway-write-${randomUUID()}`);
      try {
        await this.writeOperations.writeTemporaryFile(temporaryPath, body);
        await this.writeOperations.replaceFile(temporaryPath, path);
      } catch (error) {
        try {
          await rm(temporaryPath, { force: true });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `FsFileStore: failed to write and clean up ${key}`);
        }
        throw error;
      }
    });
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
    for (const key of keys) {
      const path = this.pathFor(key);
      const directory = dirname(path);
      await this.withDirectoryLock(directory, async () => await rm(path, { force: true }));
      await this.pruneEmptyParents(directory);
    }
  }

  private async pruneEmptyParents(start: string): Promise<void> {
    let directory = start;
    while (directory !== this.root) {
      const removed = await this.withDirectoryLock(directory, async () => {
        try {
          await rmdir(directory);
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return true;
          if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
          throw error;
        }
      });
      if (!removed) return;
      directory = dirname(directory);
    }
  }

  private async withDirectoryLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.directoryMutations.get(directory) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>(resolveLock => { release = resolveLock; });
    const tail = previous.then(() => lock);
    this.directoryMutations.set(directory, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.directoryMutations.get(directory) === tail) this.directoryMutations.delete(directory);
    }
  }

  // Resolve a key against `root` and reject paths that escape it. Even though
  // the FileStore contract treats keys as opaque, callers are not required
  // to scrub user-controlled segments and a `..`-laden key would otherwise
  // walk to arbitrary host paths under R2 it would simply be a strange key.
  private pathFor(key: string): string {
    if (isAbsolute(key)) throw new Error(`FsFileStore: absolute keys are not supported (${key})`);
    const path = resolve(this.root, ...key.split('/'));
    if (path === this.root) throw new Error(`FsFileStore: empty keys are not supported (${key})`);
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`FsFileStore: key escapes root (${key})`);
    }
    return path;
  }
}
