import { collectArchiveMetadata, type CommitDumpArchive } from './archive-metadata.ts';
import type { WriteDumpArchive } from './store-contract.ts';
import type { PipelineRecorder } from '../data-plane/pipeline/recorder.ts';
import { ulid } from '../shared/ulid.ts';
import { createDumpEncoder } from '@floway-dev/dump';

type Upload = { readonly ok: true; readonly commit: CommitDumpArchive } | { readonly ok: false; readonly error: unknown };

interface Capture {
  readonly started: number;
  readonly metadata: ReturnType<typeof collectArchiveMetadata>;
  readonly upload: Promise<Upload>;
}

export const createPipelineRecorder = (keyId: string, writeArchive: WriteDumpArchive): PipelineRecorder => {
  const encoder = createDumpEncoder();
  let failure: { readonly error: unknown } | undefined;
  let capture: Capture | undefined;
  let writer: ReadableStreamDefaultController<Uint8Array>;
  const bytes = new ReadableStream<Uint8Array>({
    start(controller) { writer = controller; },
    cancel(error) { failure ??= { error }; },
  });

  const fail = (error: unknown): void => {
    failure ??= { error };
    writer.error(error);
  };

  const open = (): Capture => {
    const started = performance.now();
    const startedAt = Date.now();
    const id = ulid(startedAt);
    const metadata = collectArchiveMetadata(id, startedAt);
    const upload = Promise.resolve().then(async (): Promise<Upload> => {
      try {
        return { ok: true, commit: await writeArchive(keyId, id, bytes) };
      } catch (error) {
        fail(error);
        return { ok: false, error };
      }
    });
    return { started, metadata, upload };
  };

  return {
    event(event) {
      if (failure) return;
      try {
        capture ??= open();
        capture.metadata.observe(event, performance.now() - capture.started);
        writer.enqueue(encoder.encode(event));
      } catch (error) {
        fail(error);
      }
    },
    async finish() {
      if (!capture) {
        if (failure) throw failure.error;
        return;
      }
      const completedAt = Date.now();
      const durationMs = performance.now() - capture.started;
      if (!failure) writer.close();
      const result = await capture.upload;
      if (failure) {
        if (!result.ok && result.error !== failure.error) {
          throw new AggregateError([failure.error, result.error], 'Failed to record and upload the pipeline dump');
        }
        throw failure.error;
      }
      if (!result.ok) throw result.error;
      const completed = capture.metadata.complete(completedAt, durationMs);
      await result.commit(completed.metadata, completed.upstreamId);
    },
  };
};
