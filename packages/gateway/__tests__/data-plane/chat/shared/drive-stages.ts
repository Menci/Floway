import { compose, defineEnding, link, type ManagedStream, run, type Stage } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

type FrameKey = `response.${string}`;

export const driveChatStages = async <Input extends object, Event>(
  stages: readonly Stage[],
  request: Input,
  reply: { readonly key: FrameKey; readonly frames?: readonly ProtocolFrame<Event>[] },
) => {
  type Output = {
    readonly 'test.request': Input;
    readonly [key: FrameKey]: ManagedStream<ProtocolFrame<Event>> | undefined;
  };
  const pipeline = compose<Input, Output, {}>('test chat stages', {
    stages,
    ending: defineEnding<Input, Output>({
      name: 'stubProvider',
      request: { needs: [] },
      return: { provides: ['test.request', reply.key] },
      execute: async (facts, _into, env) => {
        const { frames } = reply;
        const stream = frames === undefined ? undefined : env.createStream({
          label: 'provider frames',
          async *iterate() { yield* frames; },
        });
        const output: Record<FrameKey, ManagedStream<ProtocolFrame<Event>> | undefined> = { [reply.key]: stream };
        return { ...output, 'test.request': facts };
      },
    }),
  });
  link([pipeline]);
  const handle = run(pipeline, request, { services: {}, finalizationTimeoutMs: 1_000 });
  const result = await handle.result;
  const frames: ProtocolFrame<Event>[] = [];
  const stream = result[reply.key];
  if (stream !== undefined) for await (const frame of stream) frames.push(frame);
  const done = await handle.done;
  if (!done.ok) throw done.error;
  return { request: result['test.request'], frames };
};
