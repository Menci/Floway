import type { AnthropicMessagesFrame, AnthropicMessagesRequest } from './facts.ts';
import type { HttpInput, HttpOutput } from '../../../pipeline/edge-http.ts';
import { header } from '../../../pipeline/non-chat.ts';
import { emptyUsageFacts, type UsageFacts, usageResponseKeys } from '../../../pipeline/observe-usage.ts';
import { defineStage, type ManagedStream } from '@floway-dev/pipeline';
import { createAnthropicMessagesUsage, generateAnthropicId, toAnthropicMessagesUsageDelta } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';

// Claude Code 2.1.226 model validation uses "Hi", and credential verification
// uses "test". The quota preflight reads live rate-limit headers. Probe spellings
// vary by build: https://github.com/BerriAI/litellm/issues/35061
const CLAUDE_CODE_USER_AGENT = /^claude-cli\/\d+\.\d+\.\d+/i;
const PROBE_PROMPTS: ReadonlySet<string> = new Set(['Hi', 'test']);

type Request = AnthropicMessagesRequest & HttpInput;
type Answer = HttpOutput & UsageFacts & {
  readonly 'response.anthropicMessages': ManagedStream<AnthropicMessagesFrame> | undefined;
};

const isClaudeCodeProbe = (facts: Request): boolean => {
  const { max_tokens, tools, messages } = facts['request.anthropicMessages'];
  if (max_tokens !== 1 || tools !== undefined || messages.length !== 1) return false;
  const userAgent = header(facts['request.http'].headers, 'user-agent');
  if (userAgent == null || !CLAUDE_CODE_USER_AGENT.test(userAgent)) return false;
  const [message] = messages;
  if (message.role !== 'user') return false;
  const { content } = message;
  if (typeof content === 'string') return PROBE_PROMPTS.has(content);
  const [block] = content;
  return content.length === 1 && block.type === 'text' && PROBE_PROMPTS.has(block.text);
};

// Claude Code's validation path reads the usage counters unconditionally.
const probeFrames = async function* (model: string): AsyncGenerator<AnthropicMessagesFrame> {
  const usage = createAnthropicMessagesUsage(0, 0);
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
      usage,
    },
  });
  yield eventFrame({ type: 'message_delta', delta: { container: null, stop_reason: 'max_tokens', stop_details: null, stop_sequence: null }, usage: toAnthropicMessagesUsageDelta(usage) });
  yield eventFrame({ type: 'message_stop' });
  yield doneFrame();
};

export const answerClaudeCodeProbe = defineStage<Request, Request, Answer, Answer>({
  name: 'answerClaudeCodeProbe',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.http'], consumes: [], provides: [] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http', 'response.anthropicMessages', ...usageResponseKeys] },
  execute: async (facts, next, env) => {
    if (!isClaudeCodeProbe(facts)) return await next(facts);
    const now = env.clock();
    return {
      'response.http': { status: 200, statusText: '', headers: [], body: null, timing: { startedAt: now, headersAt: now } },
      'response.anthropicMessages': env.createStream({
        label: 'Claude Code probe',
        iterate: () => probeFrames(facts['request.anthropicMessages'].model),
      }),
      ...emptyUsageFacts(env),
    };
  },
});
