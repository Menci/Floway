import { eventOutcome } from './fixture.ts';
import { compose, defineEnding, defineStage, link, run, type Stage } from '@floway-dev/pipeline';
import type { ChatTargetApi, ProtocolOutcome, ProviderFrame } from '@floway-dev/provider';

type OutcomeKey = `response.${ChatTargetApi}`;

export const driveChatStages = async <Input extends object, Event, Result = never>(
  stages: readonly Stage[],
  request: Input,
  reply: { readonly key: OutcomeKey } & (
    | { readonly frames?: readonly ProviderFrame<Event>[] }
    | { readonly outcome: Exclude<ProtocolOutcome<Event, Result>, { kind: 'stream' }> }
  ),
) => {
  type Request = { readonly 'test.input': Input };
  type Space = Request & {
    readonly 'test.request': Input;
  } & Readonly<Record<OutcomeKey, ProtocolOutcome<Event, Result>>>;
  const entry = ['test.input'] as const;
  const exit = ['test.request', reply.key] as const;
  const provideRequest = defineStage<Request, Input, object, object>({
    name: 'provideTestRequest',
    through: {
      request: { needs: entry, consumes: entry, provides: Object.keys(request) },
      response: { needs: [], consumes: [], provides: [] },
    },
    execute: async (facts, scope) => await scope.next(facts['test.input']),
  });
  const pipeline = compose<Space, {}>()('test chat stages', {
    entry, exit,
    stages: [provideRequest, ...stages],
    ending: defineEnding<Input, Pick<Space, 'test.request'> & Partial<Pick<Space, OutcomeKey>>>({
      name: 'stubProvider',
      request: { needs: [] },
      return: { provides: exit },
      execute: async (facts, scope) => {
        const outcome: ProtocolOutcome<Event, Result> = 'outcome' in reply
          ? reply.outcome
          : reply.frames === undefined
            ? { kind: 'error', source: 'local', error: 'No stub provider frames' }
            : eventOutcome(scope, reply.frames);
        return { 'test.request': facts, [reply.key]: outcome };
      },
    }),
  });
  link([pipeline]);
  const handle = run(pipeline, { 'test.input': request }, { services: {}, finalizationTimeoutMs: 1_000 });
  const result = await handle.result;
  const outcome = result[reply.key];
  const replyResult = outcome.kind === 'stream' ? { frames: await Array.fromAsync(outcome.events) } : { outcome };
  const done = await handle.done;
  if (!done.ok) throw done.error;
  return { request: result['test.request'], ...replyResult };
};
