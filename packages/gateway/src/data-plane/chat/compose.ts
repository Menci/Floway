import type { ChatAnswer } from './facts.ts';
import type { ChatServices } from './services.ts';
import { recordStream } from '../../dump/run-sink.ts';
import { isFailure } from '../pipeline/facts.ts';
import { compose, isStreamFact, move, type Stage, type Use } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const answerKeys = new Set([
  'response.chat.openaiChatCompletions',
  'response.chat.openaiResponses',
  'response.chat.anthropicMessages',
  'response.chat.geminiGenerateContent',
]);

// Record at publication so a downstream translation cannot consume the only reference to
// the upstream protocol. Observers retain the reference; content rewrites publish a new one.
const recordingStage = (stage: Stage): Stage => {
  const keys = [...new Set([
    ...stage.return?.provides ?? [],
    ...(stage.through ?? stage.into)?.response.provides ?? [],
  ])].filter(key => answerKeys.has(key));
  if (keys.length === 0) return stage;
  return {
    ...stage,
    execute: async (facts, ...args) => {
      const back = await stage.execute(facts, ...args);
      const use = args[args.length - 1] as Use<ChatServices>;
      if (use.gateway.dump === null) return back;
      let recorded = back;
      for (const key of keys) {
        if (!(key in back)) continue;
        const answer = back[key] as ChatAnswer;
        if (isFailure(answer) || answer.kind !== 'stream' || isStreamFact(answer.frames)) continue;
        recorded = { ...recorded, [key]: move({ ...answer, frames: recordStream(answer.frames as AsyncIterable<ProtocolFrame<unknown>>, use.gateway.dump) }) };
      }
      return recorded;
    },
  };
};

export const composeChat: typeof compose = (name, stages) => compose(name, stages.map(recordingStage));
