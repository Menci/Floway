import { answerClaudeCodeProbe } from './stages/answer-claude-code-probe.ts';
import { applyRoleCompatibility } from './stages/apply-role-compatibility.ts';
import { countTokensNative } from './stages/count-tokens.ts';
import { disableReasoningOnForcedToolChoice } from './stages/disable-reasoning-on-forced-tool-choice.ts';
import { normalizeEmptyToolsToolChoice } from './stages/normalize-empty-tools-tool-choice.ts';
import { prepareAnthropicMessagesRequest } from './stages/prepare.ts';
import { stripBillingAttribution } from './stages/strip-billing-attribution.ts';
import { translateOrNative } from './stages/translate-or-native.ts';
import type { AnthropicMessagesDispatchPlan, AnthropicMessagesPreparedFacts } from './stages/types.ts';
import { webSearchRequestPrepared, webSearchShim } from './stages/web-search-shim.ts';
import { filterInboundHeaderEntries } from '../../pipeline/index.ts';
import {
  type AnthropicMessagesAttemptInput,
  type ChatAttemptOutcome,
  type ChatPipelineServices,
  type ChatPlainOutcome,
} from '../pipeline/index.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { defineStage, dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { BoundDispatch, Pipeline, StageEnv, UnboundOutcome } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { HttpOutcome } from '@floway-dev/provider';

export const anthropicMessagesGenerateTarget = chatTargetPicker([
  'anthropicMessages',
  'openaiResponses',
  'openaiChatCompletions',
]);

export const anthropicMessagesCountTokensTarget = chatTargetPicker(['anthropicMessages']);

type GenerateFacts = AnthropicMessagesPreparedFacts;

type CountFacts = AnthropicMessagesPreparedFacts;

type GenerateDispatchPlan = AnthropicMessagesDispatchPlan;

type CountDispatchPlan = Extract<AnthropicMessagesDispatchPlan, { type: 'native' }>;

type GenerateDispatchInnerOutcome = import('./stages/types.ts').AnthropicMessagesDispatchedOutcome;

const selectGenerateDispatch = async (
  facts: Readonly<GenerateFacts & { readonly 'dispatch.plan': GenerateDispatchPlan }>,
  plan: GenerateDispatchPlan,
  env: StageEnv<ChatPipelineServices>,
): Promise<BoundDispatch<GenerateDispatchInnerOutcome, ChatPipelineServices>> => {
  const candidate = facts['route.candidate'];
  if (plan.targetApi === 'anthropicMessages') {
    const provider = env.providerFor(candidate.upstreamId);
    const target = provider.pipelines?.anthropicMessages;
    if (target === undefined) throw new Error(`Provider ${candidate.upstreamId} has no anthropicMessages pipeline`);
    return handoff(target, {
      'route.candidate': candidate,
      'provider.model': candidate.providerModel,
      'request.inboundHeaders': filterInboundHeaderEntries(facts['request.inboundHeaders'], provider.inboundHeaderAllowlist),
      'request.payload': plan.payload,
      'request.anthropicBeta': facts['request.anthropicBeta'],
    });
  }
  if (plan.targetApi === 'openaiResponses') {
    const { openaiResponsesAttemptPipeline } = await import('../openai-responses/attempt-pipeline.ts');
    return handoff(openaiResponsesAttemptPipeline, {
      'route.candidate': candidate,
      'request.inboundHeaders': facts['request.inboundHeaders'],
      'request.payload': plan.payload,
      'request.action': 'generate',
    });
  }
  const { openaiChatCompletionsAttemptPipeline } = await import('../openai-chat-completions/attempt-pipeline.ts');
  return handoff(openaiChatCompletionsAttemptPipeline, {
    'route.candidate': candidate,
    'request.inboundHeaders': facts['request.inboundHeaders'],
    'request.payload': plan.payload,
  });
};

const prepareGenerate = defineStage<
  AnthropicMessagesAttemptInput,
  GenerateFacts,
  UnboundOutcome,
  UnboundOutcome,
  never,
  ChatPipelineServices
>({
  name: 'prepareAnthropicMessagesGenerate',
  provides: ['route.candidate', 'request.payload', 'request.inboundHeaders', 'request.anthropicBeta', 'route.targetApi', 'web-search.state'],
  execute: async (facts, next) => await next({
    ...prepareAnthropicMessagesRequest(
      facts,
      anthropicMessagesGenerateTarget.pick(facts['route.candidate'].endpoints),
    ),
    'request.anthropicBeta': facts['request.anthropicBeta'],
    'web-search.state': undefined,
    'route.candidate': facts['route.candidate'],
  }),
});

const prepareCountTokens = defineStage<
  AnthropicMessagesAttemptInput,
  CountFacts,
  UnboundOutcome,
  UnboundOutcome,
  never,
  ChatPipelineServices
>({
  name: 'prepareAnthropicMessagesCountTokens',
  provides: ['route.candidate', 'request.payload', 'request.inboundHeaders', 'request.anthropicBeta', 'route.targetApi', 'web-search.state'],
  execute: async (facts, next) => await next({
    ...prepareAnthropicMessagesRequest(facts, 'anthropicMessages'),
    'request.anthropicBeta': facts['request.anthropicBeta'],
    'web-search.state': undefined,
    'route.candidate': facts['route.candidate'],
  }),
});

export const anthropicMessagesAttemptPipeline: Pipeline<
  AnthropicMessagesAttemptInput,
  ChatAttemptOutcome<AnthropicMessagesStreamEventEx>,
  ChatPipelineServices
> = pipeline<AnthropicMessagesAttemptInput>('gateway.anthropic-messages.attempt')
  .use(prepareGenerate)
  .use(answerClaudeCodeProbe)
  .use(webSearchShim)
  .use(stripBillingAttribution)
  .use(disableReasoningOnForcedToolChoice)
  .use(normalizeEmptyToolsToolChoice)
  .use(applyRoleCompatibility)
  .use(translateOrNative)
  .end(dispatch<GenerateFacts & { readonly 'dispatch.plan': GenerateDispatchPlan }, GenerateDispatchInnerOutcome, ChatPipelineServices>({
    name: 'gateway.anthropic-messages.attempt.dispatch',
    select: async (facts, env) => await selectGenerateDispatch(facts, facts['dispatch.plan'], env),
  }));

export const anthropicMessagesCountTokensAttemptPipeline: Pipeline<
  AnthropicMessagesAttemptInput,
  ChatPlainOutcome,
  ChatPipelineServices
> = pipeline<AnthropicMessagesAttemptInput>('gateway.anthropic-messages.count-tokens.attempt')
  .use(prepareCountTokens)
  .use(webSearchRequestPrepared)
  .use(stripBillingAttribution)
  .use(disableReasoningOnForcedToolChoice)
  .use(normalizeEmptyToolsToolChoice)
  .use(applyRoleCompatibility)
  .use(countTokensNative)
  .end(dispatch<CountFacts & { readonly 'dispatch.plan': CountDispatchPlan }, HttpOutcome, ChatPipelineServices>({
    name: 'gateway.anthropic-messages.count-tokens.dispatch',
    select: (facts, env) => {
      const plan = facts['dispatch.plan'];
      if (plan.targetApi !== 'anthropicMessages') throw new Error('count_tokens received a translated dispatch plan');
      const provider = env.providerFor(plan.candidate.upstreamId);
      const target = provider.pipelines?.anthropicMessagesCountTokens;
      if (target === undefined) throw new Error(`Provider ${plan.candidate.upstreamId} has no anthropicMessagesCountTokens pipeline`);
      return handoff(target, {
        'route.candidate': plan.candidate,
        'provider.model': plan.candidate.providerModel,
        'request.inboundHeaders': filterInboundHeaderEntries(facts['request.inboundHeaders'], provider.inboundHeaderAllowlist),
        'request.payload': plan.payload,
        'request.anthropicBeta': facts['request.anthropicBeta'],
      });
    },
  }));
