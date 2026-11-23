import type { FileDumpStore } from '../../src/repo/dump-store.ts';
import { fakeMeta } from '../dump/test-fixtures.ts';

export const writeDump = async (store: FileDumpStore, keyId: string, id: string, completedAt: number): Promise<string> => {
  const meta = fakeMeta({ id, startedAt: completedAt - 1, completedAt });
  const artifactKey = store.createArtifactKey(keyId, meta.startedAt, id);
  const artifact = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"k":"done","ok":true}\n'));
      controller.close();
    },
  });
  await store.stageAndPutArtifact(keyId, id, artifactKey, artifact);
  await store.commitRecord(keyId, { meta, artifactKey });
  return artifactKey;
};
