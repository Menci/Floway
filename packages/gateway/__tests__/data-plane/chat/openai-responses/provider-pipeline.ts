import { pipeline, terminal } from '@floway-dev/pipeline';
import type { Pipeline, StageEnv } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type {
  ProviderPipelineOpenAIResponsesInput,
  ProviderPipelineResponsesOutcome,
  ProviderPipelineServices,
  ProviderPipelineStreamOutcome,
} from '@floway-dev/provider';

export const stubResponsesProviderPipeline = (
  name: string,
  handler: (
    facts: Readonly<ProviderPipelineOpenAIResponsesInput>,
    env: StageEnv<ProviderPipelineServices>,
  ) => Promise<ProviderPipelineResponsesOutcome> | ProviderPipelineResponsesOutcome,
): Pipeline<ProviderPipelineOpenAIResponsesInput, ProviderPipelineResponsesOutcome, ProviderPipelineServices> =>
  pipeline<ProviderPipelineOpenAIResponsesInput>(name).end(
    terminal<ProviderPipelineOpenAIResponsesInput, ProviderPipelineResponsesOutcome, ProviderPipelineServices>({
      name: `${name}.end`,
      execute: async (facts, env) => await handler(facts, env),
    }),
  );

export const stubChatProviderPipeline = (
  name: string,
  handler: (
    facts: Readonly<ProviderPipelineOpenAIResponsesInput>,
    env: StageEnv<ProviderPipelineServices>,
  ) => Promise<ProviderPipelineStreamOutcome<OpenAIChatCompletionsStreamEvent>> | ProviderPipelineStreamOutcome<OpenAIChatCompletionsStreamEvent>,
): Pipeline<ProviderPipelineOpenAIResponsesInput, ProviderPipelineStreamOutcome<OpenAIChatCompletionsStreamEvent>, ProviderPipelineServices> =>
  pipeline<ProviderPipelineOpenAIResponsesInput>(name).end(
    terminal<ProviderPipelineOpenAIResponsesInput, ProviderPipelineStreamOutcome<OpenAIChatCompletionsStreamEvent>, ProviderPipelineServices>({
      name: `${name}.end`,
      execute: async (facts, env) => await handler(facts, env),
    }),
  );
