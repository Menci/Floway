import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import type { FileStore } from '@floway-dev/platform';

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

  constructor(root: string) {
    // Resolve once so `pathFor` can verify resolved paths still live under it.
    this.root = resolve(root);
    // Ensure the root exists so the first put() doesn't race against a missing
    // directory and so tests / fresh deploys see a consistent structure.
    mkdirSync(this.root, { recursive: true });
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
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
