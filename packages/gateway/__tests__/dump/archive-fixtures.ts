import type { ArchiveMetadata, CommitDumpArchive } from '../../src/dump/archive-metadata.ts';

export const dumpContents = '{"type":"object","fromObjectId":1,"nodes":[{}]}\n{"type":"stage.entered","stageId":1,"name":"serve","facts":{"$":1}}\n{"type":"stage.leaved","stageId":1,"facts":{"$":1}}\n';

export const archiveMetadata = (id: string, completedAt: number, patch: Partial<ArchiveMetadata> = {}): ArchiveMetadata => ({
  id, startedAt: completedAt - 1, completedAt, method: 'POST', path: '/v1/embeddings', status: 200,
  model: 'model', durationMs: 1, ttftMs: null, requestBytes: 0, responseBytes: 0, inputTokens: null, outputTokens: null, error: null, ...patch,
});

export const archiveBody = (contents = dumpContents): ReadableStream<Uint8Array> => new Blob([contents]).stream();

export const writeArchive = async (
  store: { writeArchive(keyId: string, id: string, body: ReadableStream<Uint8Array>): Promise<CommitDumpArchive> },
  keyId: string, meta: ArchiveMetadata, upstreamId: string | null = null,
): Promise<void> => {
  const commit = await store.writeArchive(keyId, meta.id, archiveBody());
  await commit(meta, upstreamId);
};
