import { FsFileStore } from '../../src/fs-file-store.ts';

const store = new FsFileStore(process.argv[2]!);
let chunk = 0;
await store.put('file', new ReadableStream({
  async pull(controller) {
    if (chunk++ === 0) controller.enqueue(new Uint8Array([1, 2]));
    else {
      process.send!('staged');
      await new Promise<void>(() => {});
    }
  },
}, { highWaterMark: 0 }));
