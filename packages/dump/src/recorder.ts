import type { DumpMetadata, StoredDumpRecord } from './types.ts';
import { createRunEncoder, streamFact, toNdjson, type DumpEvent, type Event, type StreamFact } from '@floway-dev/pipeline';

export interface StreamRecording {
  readonly fact: StreamFact;
  frame(frame: unknown): void | Promise<void>;
  end(): void | Promise<void>;
}

export interface StreamRecorder {
  openStream(): StreamRecording;
}

export interface RecordingPorts {
  write(record: StoredDumpRecord): Promise<void>;
  publish(meta: DumpMetadata): Promise<void>;
}

export const createRunRecorder = ({ write, publish }: RecordingPorts) => {
  const encode = createRunEncoder();
  const events: DumpEvent[] = [];
  let failure: { readonly error: unknown } | null = null;
  let streams = 0;
  let answerStream: StreamRecording | undefined;
  const sink = (event: Event): void => {
    if (failure !== null) throw failure.error;
    try {
      for (const encoded of encode(event)) events.push(encoded);
    } catch (error) {
      failure = { error };
      throw error;
    }
  };
  const openStream = (): StreamRecording => {
    const streamId = ++streams;
    return {
      fact: streamFact(streamId),
      frame: frame => { sink({ type: 'stream.frame', streamId, frames: [frame] }); },
      end: () => { sink({ type: 'stream.end', streamId }); },
    };
  };
  const frame = (value: unknown): void | Promise<void> => {
    answerStream ??= openStream();
    return answerStream.frame(value);
  };
  const finish = async (meta: DumpMetadata): Promise<void> => {
    if (failure !== null) throw failure.error;
    await write({ meta, events: new TextEncoder().encode(toNdjson(events)) });
    await publish(meta);
  };
  return { sink, frame, openStream, finish };
};

export type RunRecorder = ReturnType<typeof createRunRecorder>;
