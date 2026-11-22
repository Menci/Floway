import type { AnthropicMessagesPreparedFacts, AnthropicMessagesGenerateOutcome } from './types.ts';
import { routeCandidateModelIdentity } from '../../../pipeline/failover.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import {
  createAnthropicMessagesUsage,
  generateAnthropicId,
  toAnthropicMessagesUsageDelta,
  type AnthropicMessagesPayload,
  type AnthropicMessagesStreamEventEx,
} from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

const CLAUDE_CODE_USER_AGENT = /^claude-cli\/\d+\.\d+\.\d+/i;
const PROBE_PROMPTS: ReadonlySet<string> = new Set(['Hi', 'test']);

const soleUserPrompt = (payload: AnthropicMessagesPayload): string | null => {
  if (payload.messages.length !== 1) return null;
  const message = payload.messages[0]!;
  if (message.role !== 'user') return null;
  if (typeof message.content === 'string') return message.content;
  if (message.content.length !== 1) return null;
  const block = message.content[0]!;
  return block.type === 'text' ? block.text : null;
};

const userAgentOf = (facts: Pick<AnthropicMessagesPreparedFacts, 'request.inboundHeaders'>): string | undefined => {
  const entry = facts['request.inboundHeaders'].find(([name]) => name.toLowerCase() === 'user-agent');
  return entry?.[1] as string | undefined;
};

export const isClaudeCodeProbe = (facts: Pick<AnthropicMessagesPreparedFacts, 'request.payload' | 'request.inboundHeaders'>): boolean => {
  const payload = facts['request.payload'];
  if (payload.max_tokens !== 1 || payload.tools !== undefined) return false;
  const userAgent = userAgentOf(facts);
  if (userAgent === undefined || !CLAUDE_CODE_USER_AGENT.test(userAgent)) return false;
  const prompt = soleUserPrompt(payload);
  return prompt !== null && PROBE_PROMPTS.has(prompt);
};

const probeFrames = async function* (model: string): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
  yield eventFrame({
    type: 'message_start',
    message: {
      id: generateAnthropicId('msg'),
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_details: null,
      container: null,
      diagnostics: null,
      stop_sequence: null,
      usage: createAnthropicMessagesUsage(0, 0),
    },
  });
  yield eventFrame({
    type: 'message_delta',
    delta: { container: null, stop_reason: 'max_tokens', stop_details: null, stop_sequence: null },
    usage: toAnthropicMessagesUsageDelta(createAnthropicMessagesUsage(0, 0)),
  });
  yield eventFrame({ type: 'message_stop' });
  yield doneFrame();
};

export const answerClaudeCodeProbe = defineStage<
  AnthropicMessagesPreparedFacts,
  Pick<AnthropicMessagesPreparedFacts, 'web-search.state'>,
  AnthropicMessagesGenerateOutcome,
  AnthropicMessagesGenerateOutcome,
  never,
  ChatPipelineServices
>({
  name: 'answerClaudeCodeProbe',
  execute: async (facts, next, env) => {
    if (!isClaudeCodeProbe(facts)) return await next({ 'web-search.state': facts['web-search.state'] });
    const candidate = facts['route.candidate'];
    const modelIdentity = routeCandidateModelIdentity(candidate, candidate.providerModel.id);
    const usageId = env.usageLedger.register({ modelIdentity });
    env.usageLedger.updateBillableUsage(usageId, {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 0,
    });
    env.affinity.select(candidate);
    return {
      type: 'events',
      events: env.createStream({
        label: 'anthropic-messages.probe.events',
        iterate: () => probeFrames(facts['request.payload'].model),
      }),
      modelIdentity,
      usageId,
    };
  },
});
