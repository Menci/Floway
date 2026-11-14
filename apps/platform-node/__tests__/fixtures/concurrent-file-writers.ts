import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const originalOpen = fsPromises.open;
let pause = true;
let staged!: () => void;
const started = new Promise<void>(resolve => { staged = resolve; });
let resume!: () => void;
const gate = new Promise<void>(resolve => { resume = resolve; });
fsPromises.open = async (...args: Parameters<typeof fsPromises.open>) => {
  if (pause) { pause = false; staged(); await gate; }
  return await originalOpen(...args);
};
syncBuiltinESMExports();
const { FsFileStore } = await import('../../src/fs-file-store.ts');
const store = new FsFileStore(process.argv[2]!);
try {
  const first = store.put('file', new Uint8Array([1]));
  await started;
  await store.put('file', new Uint8Array([2]));
  resume();
  await first;
} finally {
  fsPromises.open = originalOpen;
  syncBuiltinESMExports();
}
