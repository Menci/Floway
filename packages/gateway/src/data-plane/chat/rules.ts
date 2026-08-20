// The rules every chat chain composes. Each is written against one protocol's payload key and
// dropped into that protocol's array — one stage per (rule, protocol) pair, because the payload
// types differ, but one *rule* each, written once here: the role fold, the flag reading and the
// key removal are shared, and only the walk over a protocol's own items is per protocol.
//
// A rule states three things by declaration that the surface this replaced stated by procedure.
// It returns the record it hands on rather than assigning to a mutable payload, so a rewrite is
// a spread and structural sharing is what makes it cheap — every rule here writes conditionally,
// which is the convention that keeps a 49-message conversation costing three objects, and is
// also what lets a Gemini generateContent payload be rewritten at all now that the record is
// frozen and deleting a key from it would throw. Which protocol a rule is looking at is a
// declared need rather than an ambient field: array position says which chain a stage is in, and
// what it reads about the turn is in the record. The guards are not deleted by that, they are
// split — a guard about the *wire* is said by position, because a stage below the fork runs only
// on the wire the fork chose, and a guard about what the *client* spoke is said by needing
// `ingress.chat.sourceProtocol`. And a rule that reads the response — the two that rewrite a
// stream — states it as a response-direction declaration rather than as work after the descent,
// with what it learned on the way down carried in the stage's own closure, because a
// response-side `needs` can only name what the ending provides.

import type { Chat, ChatAnswer } from './facts.ts';
import { asJsonObject, type JsonObject, readJsonNumber } from '../../shared/json-helpers.ts';
import { isFailure, type AttemptSelector } from '../pipeline/facts.ts';
import { foldsExclusiveCacheTokens } from '../shared/telemetry/usage.ts';
import { defineStage, move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, GeminiGenerateContentToolGroup } from '@floway-dev/protocols/gemini-generate-content';
import type {
  OpenAIChatCompletionsMessage,
  OpenAIChatCompletionsPayload,
  OpenAIChatCompletionsReasoningItem,
  OpenAIChatCompletionsStreamEvent,
} from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputItem, OpenAIResponsesPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

/** Removing a field inside a value is the same move as removing a fact, and a value that
 *  carried none of them comes back by identity so the rule costs nothing where it does not
 *  apply. */
const withoutKeys = <T extends object>(value: T, keys: readonly (keyof T)[]): T => {
  if (!keys.some(key => key in value)) return value;
  const removed = new Set<string>(keys as readonly string[]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !removed.has(key))) as T;
};

/** `map`, but the array comes back by identity when every element did. Written once because
 *  every rule here walks a list of something — messages, input items, content parts — and
 *  the identity is the whole reason a layer costs only what it actually changed. */
const mapKeepingIdentity = <T>(items: T[], rewrite: (item: T) => T): T[] => {
  let changed = false;
  const mapped = items.map(item => {
    const next = rewrite(item);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? mapped : items;
};

/** The response half of every rule here that rewrites a stream: a refusal and a collected
 *  body have no frames to rewrite, and telling the three apart is reading a value rather than
 *  dispatching on a declaration. `null` says there was nothing to do, so the caller hands the
 *  record it was given straight on. */
const answerWithFrames = <Event>(
  answer: ChatAnswer,
  rewrite: (frames: AsyncIterable<ProtocolFrame<Event>>) => AsyncGenerator<ProtocolFrame<Event>>,
): ChatAnswer | null => {
  if (isFailure(answer) || answer.kind !== 'stream') return null;
  const frames = answer.frames as AsyncIterable<ProtocolFrame<Event>>;
  return { kind: 'stream' as const, frames: { [Symbol.asyncIterator]: () => rewrite(frames) } };
};

/** A stream with each event rewritten one for one. The frame comes back by identity when the
 *  rewrite changed nothing, which is the same conditional-write convention the request-side
 *  rules follow — and a transport frame is not an event, so it rides through untouched. */
const rewritingEvents = async function* <Event>(
  frames: AsyncIterable<ProtocolFrame<Event>>,
  rewrite: (event: Event) => Event,
): AsyncGenerator<ProtocolFrame<Event>> {
  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = rewrite(frame.event);
    yield event === frame.event ? frame : eventFrame(event);
  }
};

/** Where a protocol keeps the numbers the cache-bucket fold reads. The names are the whole of
 *  what a protocol contributes: the decision, the two contradictions it raises and the
 *  arithmetic are one rule, and it is written once below. */
interface CacheBucketNames {
  readonly input: string;
  readonly output: string;
  readonly details: string;
  /** Read in the order given, because an upstream projecting Anthropic's cache-write bucket
   *  onto an OpenAI-shaped usage block may spell it either way. */
  readonly cacheWrite: readonly string[];
}

/**
 * Restores OpenAI's inclusive input-token contract on a usage block that reports the cache
 * buckets alongside the input total instead of inside it.
 *
 * OpenAI states the subset relationship outright — "Cached tokens here are counted as a subset
 * of input tokens, meaning input tokens will include cached and uncached tokens"
 * (https://github.com/openai/openai-openapi/blob/d4fb706e6e05d4cc9f1b33ca59b6e4f3e8edd439/openapi.yaml#L51043-L51049)
 * — and every downstream consumer here subtracts on that basis. Anthropic takes the opposite
 * convention: `input_tokens` counts only what was neither read from nor written to the cache,
 * and the three buckets sum to the real input
 * (https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching).
 *
 * A gateway that fronts an Anthropic-shaped upstream and projects it into an OpenAI shape can
 * carry the exclusive convention through to a wire that declares the inclusive one. Portkey
 * does exactly that — it assigns Anthropic's `input_tokens` straight to `prompt_tokens` while
 * summing `total_tokens` from all four buckets
 * (https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/providers/anthropic/chatComplete.ts#L612-L627).
 * Charm Hyper produces the same shape by subtracting the cached prefix out of the input total
 * it received: for one observed kimi-k3 turn it reported `prompt_tokens 479, cached_tokens
 * 13312, completion_tokens 373, total_tokens 14164`, where 479 + 13312 + 373 = 14164.
 *
 * `foldsExclusiveCacheTokens` owns the decision and the two contradictions that must not pass
 * silently; the `usage-exclusive-cached-tokens` flag is its declaration input. `total_tokens`
 * itself is left alone: under the exclusive convention it already counts the real input, so
 * the rewritten input plus output is what it was equal to all along. A block with nothing to
 * fold comes back by identity.
 */
const withCacheBucketsFolded = (
  usage: JsonObject,
  names: CacheBucketNames,
  declaredExclusive: boolean,
  identity: string,
): JsonObject => {
  const inputTokens = readJsonNumber(usage[names.input]);
  const outputTokens = readJsonNumber(usage[names.output]);
  if (inputTokens == null || outputTokens == null) return usage;

  const details = asJsonObject(usage[names.details]);
  const cacheRead = readJsonNumber(details?.cached_tokens) ?? 0;
  const cacheWrite = names.cacheWrite.map(name => readJsonNumber(details?.[name])).find(value => value != null) ?? 0;
  if (cacheRead === 0 && cacheWrite === 0) return usage;

  const folds = foldsExclusiveCacheTokens(declaredExclusive, {
    inputTokens,
    outputTokens,
    totalTokens: readJsonNumber(usage.total_tokens) ?? undefined,
    cacheRead,
    cacheWrite,
  }, identity);
  if (!folds) return usage;

  return { ...usage, [names.input]: inputTokens + cacheRead + cacheWrite };
};

/** How the attempt whose usage is being read is named in the errors the fold raises: an
 *  operator is told which upstream and which model to set the flag on. */
const attemptIdentity = (attempt: AttemptSelector): string => `${attempt.upstreamId}/${attempt.modelId}`;

/** Role rewrites, in the fixed order `system → developer → system → user`. Later rewrites
 *  are authoritative when flags overlap, and the last step affects only a system message
 *  that appears after the leading run — which is what "mid-conversation" means. The fold
 *  itself is `roleRewriter`; what is here is the walk over this protocol's messages. */
export const applyRoleCompatibilityToOpenAIChatCompletions = defineStage<
  Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'applyRoleCompatibility',
  through: {
    request: {
      needs: ['request.chat.openaiChatCompletions', 'route.attempt'],
      consumes: [],
      // Declared even though it will not always be written: a stage that only modifies a
      // field need not write on every run, and `provides \ needs` is the set that must be.
      provides: ['request.chat.openaiChatCompletions'],
    },
    response: { needs: ['response.chat.openaiChatCompletions'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
    Chat<'request.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => ({
    request: facts => {
      const rewrite = rolesFor(facts['route.attempt'].flags);
      if (rewrite === null) return facts;                       // the free do-nothing path
      const payload = facts['request.chat.openaiChatCompletions'];
      const messages = rewriteOpenAIChatCompletionsRoles(payload.messages, rewrite);
      // Written conditionally the whole way down, so a conversation this does not touch
      // comes back by identity and the layer costs what the rewrite actually changed.
      return messages === payload.messages
        ? facts
        : { ...facts, 'request.chat.openaiChatCompletions': move({ ...payload, messages }) };
    },
  })),
});

interface RoleRewrite {
  readonly systemToDeveloper: boolean;
  readonly developerToSystem: boolean;
  readonly midConversationSystemToUser: boolean;
}

/** A flag is data on an upstream model, and this is a stage reading it. There is no
 *  category of stage a flag switches on or off. */
const rolesFor = (flags: readonly string[]): RoleRewrite | null => {
  const rewrite: RoleRewrite = {
    systemToDeveloper: flags.includes('rewrite-system-to-developer'),
    developerToSystem: flags.includes('rewrite-developer-to-system'),
    midConversationSystemToUser: flags.includes('rewrite-mid-conv-system-to-user'),
  };
  return rewrite.systemToDeveloper || rewrite.developerToSystem || rewrite.midConversationSystemToUser
    ? rewrite
    : null;
};

type OpenAIChatCompletionsMessages = OpenAIChatCompletionsPayload['messages'];

const rewriteOpenAIChatCompletionsRoles = (messages: OpenAIChatCompletionsMessages, rewrite: RoleRewrite): OpenAIChatCompletionsMessages => {
  const nextRole = roleRewriter(rewrite);
  return mapKeepingIdentity(messages, message => {
    const role = nextRole(message.role);
    return role === message.role ? message : { ...message, role };
  });
};

/** The three rewrites in their settled order, and the state that makes "mid-conversation"
 *  mean what it says: the last step affects only a system message that appears after the
 *  leading run, which is why the fold carries a flag rather than testing the index.
 *
 *  Written once, over roles alone. A protocol walks its own items, hands in the role it read
 *  off one and takes back the role to write, so the ordering exists in one place however
 *  differently the two protocols that use it shape a turn. An item with no role at all —
 *  an OpenAI Responses reasoning item between two system messages — still crosses the leading run,
 *  which is what makes the system message after it mid-conversation. */
const roleRewriter = (rewrite: RoleRewrite) => {
  let crossedLeadingSystemRun = false;
  return <Role extends string | undefined>(role: Role): Role | RewrittenRole => {
    let result: Role | RewrittenRole = role;
    if (rewrite.systemToDeveloper && result === 'system') result = 'developer';
    if (rewrite.developerToSystem && result === 'developer') result = 'system';
    if (!crossedLeadingSystemRun && result !== 'system') crossedLeadingSystemRun = true;
    if (rewrite.midConversationSystemToUser && crossedLeadingSystemRun && result === 'system') result = 'user';
    return result;
  };
};

/** The only roles the fold ever writes. Every protocol it runs on admits all three, so a
 *  rewritten role needs no cast to go back onto the item it came from. */
type RewrittenRole = 'system' | 'developer' | 'user';

/** The reasoning sentinel a forced tool choice needs. Gated by its flag, and the sentinel
 *  is the gateway's canonical form — putting it on the wire in a vendor's shape is the
 *  vendor normalizer's job, which is why this runs above them. */
export const disableReasoningOnForcedToolChoiceForOpenAIChatCompletions = defineStage<
  Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'disableReasoningOnForcedToolChoice',
  through: {
    request: {
      needs: ['request.chat.openaiChatCompletions', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiChatCompletions'],
    },
    response: { needs: ['response.chat.openaiChatCompletions'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
    Chat<'request.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('disable-reasoning-on-forced-tool-choice')) {
        return facts;
      }
      const payload = facts['request.chat.openaiChatCompletions'];
      if (!isForcedToolChoice(payload.tool_choice)) return facts;
      return { ...facts, 'request.chat.openaiChatCompletions': move({ ...payload, reasoning_effort: 'none' }) };
    },
  })),
});

/** `required`, or a named function. `auto` and `none` leave the model free to reason. */
const isForcedToolChoice = (choice: OpenAIChatCompletionsPayload['tool_choice']): boolean =>
  choice === 'required' || (typeof choice === 'object' && choice !== null);

/** Drops a field the upstream would reject as an unknown argument. It runs above the vendor
 *  normalizers so each of them sees the already-stripped canonical payload. */
export const stripPromptCacheKeyForOpenAIChatCompletions = defineStage<
  Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'stripPromptCacheKey',
  through: {
    request: {
      needs: ['request.chat.openaiChatCompletions', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiChatCompletions'],
    },
    response: { needs: ['response.chat.openaiChatCompletions'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
    Chat<'request.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('strip-prompt-cache-key')) return facts;
      const payload = facts['request.chat.openaiChatCompletions'];
      const stripped = withoutKeys(payload, ['prompt_cache_key']);
      return stripped === payload ? facts : { ...facts, 'request.chat.openaiChatCompletions': move(stripped) };
    },
  })),
});

/**
 * Asks the upstream for the usage chunk that billing is read off.
 *
 * OpenAI Chat Completions emits the final usage-only chunk only when `stream_options.include_usage`
 * is on, and the gateway meters every stream from those frames — so what the client asked for
 * and what the upstream is asked for differ here, which is the one thing this rule exists to
 * say. Nothing downstream has to thread the client's original value through, because it is a
 * fact of its own: `ingress.chat.openaiChatCompletions.wantsUsageChunk` describes the request that
 * arrived and survives this rewrite, and the edge reads it to decide who is shown the chunk.
 *
 * It belongs to the wire rather than to the source chain because it names a field of *this*
 * protocol's request. Every source protocol that reaches an upstream over this endpoint runs
 * it — an Anthropic Messages or Gemini generateContent turn served here would otherwise be metered off a stream that was
 * never asked to report anything — and a turn that leaves for another wire gets that wire's
 * own rule for the same thing.
 *
 * Reference: https://platform.openai.com/docs/api-reference/chat/create
 */
export const includeUsageStreamOptionsForOpenAIChatCompletions = defineStage<
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'includeUsageStreamOptions',
  through: {
    request: {
      needs: ['request.chat.openaiChatCompletions'],
      consumes: [],
      provides: ['request.chat.openaiChatCompletions'],
    },
    response: { needs: ['response.chat.openaiChatCompletions'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiChatCompletions'>,
    Chat<'request.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => ({
    request: facts => {
      const payload = facts['request.chat.openaiChatCompletions'];
      if (payload.stream_options?.include_usage === true) return facts;
      // Whatever else the client put on `stream_options` is its own and stays; only the one
      // field the gateway has an interest in is written.
      return {
        ...facts,
        'request.chat.openaiChatCompletions': move({
          ...payload,
          stream_options: { ...payload.stream_options, include_usage: true },
        }),
      };
    },
  })),
});

/**
 * Puts a usage block back on the carrier chunk the spec says it arrives on.
 *
 * OpenAI puts the final `usage` on a `choices: []` chunk of its own
 * (https://platform.openai.com/docs/api-reference/chat-streaming), and some upstreams have
 * been observed to attach it to the same chunk that carries the last delta and
 * `finish_reason`. Such a chunk is split in two — the delta as it arrived, then a synthesized
 * carrier holding the usage — so everything downstream can rely on the standard shape.
 *
 * It runs above the vendor normalizers, so on the way back it sees a usage block whose cache
 * fields already carry OpenAI's names.
 */
export const normalizeUsageForOpenAIChatCompletions = defineStage<
  Record<string, never>,
  Record<string, never>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'normalizeUsage',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.openaiChatCompletions'],
      consumes: [],
      provides: ['response.chat.openaiChatCompletions'],
    },
  },
  execute: transform<
    Record<string, never>,
    Record<string, never>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => ({
    response: facts => {
      const answer = answerWithFrames<OpenAIChatCompletionsStreamEvent>(facts['response.chat.openaiChatCompletions'], withUsageOnItsOwnCarrier);
      return answer === null ? facts : { ...facts, 'response.chat.openaiChatCompletions': move(answer) };
    },
  })),
});

/** One chunk in, two out — and only for the chunk that carried both, which is why this is not
 *  a one-for-one event rewrite. */
const withUsageOnItsOwnCarrier = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const chunk = frame.event;
    if (asJsonObject(chunk.usage) === null || chunk.choices.length === 0) {
      yield frame;
      continue;
    }
    const { usage, ...withoutUsage } = chunk;
    yield eventFrame(withoutUsage);
    yield eventFrame({ ...withoutUsage, choices: [], usage });
  }
};

/**
 * Restores OpenAI's inclusive input-token contract on an upstream that reports the cache
 * buckets alongside `prompt_tokens` instead of inside it. The fold, the evidence for the two
 * conventions and the contradictions it raises are at `withCacheBucketsFolded`.
 *
 * Unconditional on this wire rather than flag-gated: `foldsExclusiveCacheTokens` reads
 * `total_tokens` as the witness, and the `usage-exclusive-cached-tokens` flag is a declaration
 * input for the responses whose totals witness nothing.
 *
 * Everything it says is about one upstream's OpenAI Chat Completions wire — the flag it reads
 * describes how that upstream writes its usage there, and the remedy its errors name is a
 * setting for that upstream. That is why it belongs to the wire: on any other wire these
 * events are a projection of some other protocol, where the flag answers a question about
 * counts it does not describe and telling an operator to set it would be advice that cannot
 * help. Nothing is lost by standing down there — a translator emits the canonical form, which
 * is the one case the fold has nothing to do with.
 *
 * It runs below the vendor normalizers, so on the way back it reads usage whose cache fields
 * already carry OpenAI's names.
 */
export const normalizeExclusiveCachedTokensForOpenAIChatCompletions = defineStage<
  Chat<'route.attempt'>,
  Chat<'route.attempt'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'normalizeExclusiveCachedTokens',
  through: {
    request: { needs: ['route.attempt'], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.openaiChatCompletions'],
      consumes: [],
      provides: ['response.chat.openaiChatCompletions'],
    },
  },
  execute: transform<
    Chat<'route.attempt'>,
    Chat<'route.attempt'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => {
    // Which attempt this is gets read on the way down and spoken about on the way back, which
    // is the order `transform` runs the two halves in.
    let attempt!: AttemptSelector;
    return {
      request: facts => {
        attempt = facts['route.attempt'];
        return facts;
      },
      response: facts => {
        const declaredExclusive = attempt.flags.includes('usage-exclusive-cached-tokens');
        const identity = attemptIdentity(attempt);
        const answer = answerWithFrames<OpenAIChatCompletionsStreamEvent>(
          facts['response.chat.openaiChatCompletions'],
          frames => rewritingEvents(frames, chunk => foldOpenAIChatCompletionsUsage(chunk, declaredExclusive, identity)),
        );
        return answer === null ? facts : { ...facts, 'response.chat.openaiChatCompletions': move(answer) };
      },
    };
  }),
});

/** OpenAI Chat Completions carries usage on the chunk's own root and names the buckets
 *  `prompt_tokens` and `prompt_tokens_details.{cached_tokens, cache_creation_input_tokens}`. */
const OPENAI_CHAT_COMPLETIONS_CACHE_BUCKETS: CacheBucketNames = {
  input: 'prompt_tokens',
  output: 'completion_tokens',
  details: 'prompt_tokens_details',
  cacheWrite: ['cache_creation_input_tokens', 'cache_write_tokens'],
};

const foldOpenAIChatCompletionsUsage = (
  chunk: OpenAIChatCompletionsStreamEvent,
  declaredExclusive: boolean,
  identity: string,
): OpenAIChatCompletionsStreamEvent => {
  const usage = asJsonObject(chunk.usage);
  if (usage === null) return chunk;
  const folded = withCacheBucketsFolded(usage, OPENAI_CHAT_COMPLETIONS_CACHE_BUCKETS, declaredExclusive, identity);
  return folded === usage ? chunk : { ...chunk, usage: folded as unknown as OpenAIChatCompletionsStreamEvent['usage'] };
};

// ── OpenAI Chat Completions vendor dialects ───────────────────────────────────────────────
//
// Each of the three below is last among this wire's rewrites, which is what gives it the final
// say on the outbound body and the first say on the inbound stream: everything above deals
// only in OpenAI-canonical form. The vendor flags are mutually exclusive in practice, but the
// stages are independent and run in the order they are composed if more than one is somehow on.

/**
 * DeepSeek's wire dialect.
 *
 * Outbound: `reasoning_effort: 'none'` is the gateway's canonical "no reasoning" sentinel and
 * is not in DeepSeek's own enum, which uses a top-level `thinking: { type: 'disabled' }`
 * instead. Assistant messages carry their reasoning on the scalar `reasoning_content` DeepSeek
 * documents — it is the only field it reads, and it reports 400s when the assistant-message
 * replay of a multi-turn tool-call loop omits it. And `response_format: { type: 'json_schema' }`
 * is downgraded to `json_object`, which is the only structured output DeepSeek supports; the
 * schema body is dropped rather than rejected by the upstream.
 *
 * Inbound: `reasoning_content` deltas become `reasoning_text`, and the `prompt_cache_hit_tokens`
 * / `prompt_cache_miss_tokens` pair becomes OpenAI's `prompt_tokens_details.cached_tokens` —
 * computed from the hit count alone, which is the cached prefix length.
 *
 * References:
 * - https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 * - https://api-docs.deepseek.com/guides/kv_cache
 * - https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
 */
export const vendorDeepSeekNormalizeForOpenAIChatCompletions = defineStage<
  Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'vendorDeepSeekNormalize',
  through: {
    request: {
      needs: ['request.chat.openaiChatCompletions', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiChatCompletions'],
    },
    response: {
      needs: ['response.chat.openaiChatCompletions'],
      consumes: [],
      provides: ['response.chat.openaiChatCompletions'],
    },
  },
  execute: transform<
    Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
    Chat<'request.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => {
    // Whether this vendor's dialect applies at all is read on the way down and acted on in
    // both directions, which is the order `transform` runs the two halves in.
    let enabled = false;
    return {
      request: facts => {
        enabled = facts['route.attempt'].flags.includes('vendor-deepseek');
        if (!enabled) return facts;
        const payload = facts['request.chat.openaiChatCompletions'];
        const normalized = deepSeekOutbound(payload);
        return normalized === payload ? facts : { ...facts, 'request.chat.openaiChatCompletions': move(normalized) };
      },
      response: facts => {
        if (!enabled) return facts;
        const answer = answerWithFrames<OpenAIChatCompletionsStreamEvent>(
          facts['response.chat.openaiChatCompletions'],
          frames => rewritingEvents(frames, chunk => deepSeekInboundUsage(deepSeekInboundDeltas(chunk))),
        );
        return answer === null ? facts : { ...facts, 'response.chat.openaiChatCompletions': move(answer) };
      },
    };
  }),
});

const deepSeekOutbound = (payload: OpenAIChatCompletionsPayload): OpenAIChatCompletionsPayload => {
  const withThinking = payload.reasoning_effort === 'none'
    ? { ...withoutKeys(payload, ['reasoning_effort']), thinking: { type: 'disabled' } } satisfies OpenAIChatCompletionsPayloadWithDeepSeekThinking
    : payload;
  const withResponseFormat = withThinking.response_format?.type === 'json_schema'
    ? { ...withThinking, response_format: { type: 'json_object' } }
    : withThinking;
  const messages = mapKeepingIdentity(withResponseFormat.messages, deepSeekAssistantReasoning);
  return messages === withResponseFormat.messages ? withResponseFormat : { ...withResponseFormat, messages };
};

/** The reasoning DeepSeek reads, and only that: `reasoning_opaque` is the OpenAI-canonical
 *  signature for cross-turn replay and DeepSeek does not accept it, so it goes with the two
 *  fields that are projected onto `reasoning_content`. */
const deepSeekAssistantReasoning = (message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage => {
  const stripped = withoutKeys(message, ['reasoning_text', 'reasoning_opaque', 'reasoning_items']);
  if (stripped === message) return message;
  const text = typeof message.reasoning_text === 'string'
    ? message.reasoning_text
    : deepSeekReasoningFromItems(message.reasoning_items);
  if (text === undefined) return stripped;
  const projected: OpenAIChatCompletionsMessageWithDeepSeekReasoning = { ...stripped, reasoning_content: text };
  return projected;
};

/** The newer OpenAI shape carries reasoning as summary items; DeepSeek documents only the
 *  scalar, so what summaries there are become it. */
const deepSeekReasoningFromItems = (items: OpenAIChatCompletionsReasoningItem[] | null | undefined): string | undefined => {
  const parts = items?.flatMap(item => item.summary?.map(summary => summary.text) ?? []) ?? [];
  return parts.length > 0 ? parts.join('') : undefined;
};

const deepSeekInboundDeltas = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const choices = mapKeepingIdentity(chunk.choices, choice => {
    const delta = choice.delta as OpenAIChatCompletionsDeltaWithDeepSeekReasoning;
    if (typeof delta.reasoning_content !== 'string') return choice;
    const stripped = withoutKeys(delta, ['reasoning_content']);
    return {
      ...choice,
      delta: delta.reasoning_text === undefined ? { ...stripped, reasoning_text: delta.reasoning_content } : stripped,
    };
  });
  return choices === chunk.choices ? chunk : { ...chunk, choices };
};

/** DeepSeek's "hit" count is the cached prefix length, which is what OpenAI's
 *  `cached_tokens` means; the "miss" count is what is left of the input and is dropped.
 *  `prompt_tokens` is documented as exactly hit + miss, and the cache matches only a prefix.
 *  https://api-docs.deepseek.com/api/create-chat-completion
 *  https://api-docs.deepseek.com/guides/kv_cache */
const DEEPSEEK_CACHE_FIELDS = ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'] as const;

const deepSeekInboundUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const usage = asJsonObject(chunk.usage);
  if (usage === null) return chunk;
  const stripped = withoutKeys(usage, DEEPSEEK_CACHE_FIELDS);
  if (stripped === usage) return chunk;
  const hit = readJsonNumber(usage.prompt_cache_hit_tokens);
  const next: JsonObject = hit == null
    ? stripped
    : { ...stripped, prompt_tokens_details: { ...(asJsonObject(usage.prompt_tokens_details) ?? {}), cached_tokens: hit } };
  return { ...chunk, usage: next as unknown as OpenAIChatCompletionsStreamEvent['usage'] };
};

/** Qwen says "no reasoning" with a top-level `enable_thinking: false` rather than with the
 *  canonical sentinel. Its response shape matches OpenAI for the fields the gateway reads, so
 *  there is nothing to do on the way back.
 *  https://www.alibabacloud.com/help/en/model-studio/deep-thinking */
export const vendorQwenNormalizeForOpenAIChatCompletions = defineStage<
  Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'vendorQwenNormalize',
  through: {
    request: {
      needs: ['request.chat.openaiChatCompletions', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiChatCompletions'],
    },
    response: { needs: ['response.chat.openaiChatCompletions'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
    Chat<'request.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('vendor-qwen')) return facts;
      const payload = facts['request.chat.openaiChatCompletions'];
      if (payload.reasoning_effort !== 'none') return facts;
      const normalized: OpenAIChatCompletionsPayloadWithQwenThinking = {
        ...withoutKeys(payload, ['reasoning_effort']),
        enable_thinking: false,
      };
      return { ...facts, 'request.chat.openaiChatCompletions': move(normalized) };
    },
  })),
});

/** Kimi (Moonshot) reports the cached prefix on a flat `cached_tokens` beside the totals; the
 *  rules above this one read OpenAI's `prompt_tokens_details.cached_tokens`, so it is put
 *  there. Kimi accepts the canonical request shape, so there is nothing to do on the way out.
 *  https://platform.kimi.com/docs/api/chat */
export const vendorKimiNormalizeForOpenAIChatCompletions = defineStage<
  Chat<'route.attempt'>,
  Chat<'route.attempt'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'vendorKimiNormalize',
  through: {
    request: { needs: ['route.attempt'], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.openaiChatCompletions'],
      consumes: [],
      provides: ['response.chat.openaiChatCompletions'],
    },
  },
  execute: transform<
    Chat<'route.attempt'>,
    Chat<'route.attempt'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => {
    let enabled = false;
    return {
      request: facts => {
        enabled = facts['route.attempt'].flags.includes('vendor-kimi');
        return facts;
      },
      response: facts => {
        if (!enabled) return facts;
        const answer = answerWithFrames<OpenAIChatCompletionsStreamEvent>(
          facts['response.chat.openaiChatCompletions'],
          frames => rewritingEvents(frames, kimiInboundUsage),
        );
        return answer === null ? facts : { ...facts, 'response.chat.openaiChatCompletions': move(answer) };
      },
    };
  }),
});

const kimiInboundUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const usage = asJsonObject(chunk.usage);
  if (usage === null) return chunk;
  const cached = readJsonNumber(usage.cached_tokens);
  if (cached == null) return chunk;
  const next: JsonObject = {
    ...withoutKeys(usage, ['cached_tokens']),
    prompt_tokens_details: { ...(asJsonObject(usage.prompt_tokens_details) ?? {}), cached_tokens: cached },
  };
  return { ...chunk, usage: next as unknown as OpenAIChatCompletionsStreamEvent['usage'] };
};

/** None of the three fields is an OpenAI Chat Completions field, so each is declared beside the vendor
 *  that reads it rather than widening the protocol's own types. */
type OpenAIChatCompletionsPayloadWithDeepSeekThinking = Omit<OpenAIChatCompletionsPayload, 'reasoning_effort'> & { thinking: { type: string } };
type OpenAIChatCompletionsPayloadWithQwenThinking = Omit<OpenAIChatCompletionsPayload, 'reasoning_effort'> & { enable_thinking: false };
type OpenAIChatCompletionsMessageWithDeepSeekReasoning =
  Omit<OpenAIChatCompletionsMessage, 'reasoning_text' | 'reasoning_opaque' | 'reasoning_items'> & { reasoning_content: string };
type OpenAIChatCompletionsDeltaWithDeepSeekReasoning =
  OpenAIChatCompletionsStreamEvent['choices'][number]['delta'] & { reasoning_content?: unknown };

// ── Anthropic Messages ────────────────────────────────────────────────────────────────────

/**
 * The mid-conversation system rewrite, which on this protocol is every inline system message.
 *
 * Anthropic's top-level `payload.system` is the only first-position system slot, so a system
 * message inside `messages` is by construction past the leading run — which is why this reads
 * the same flag as the other protocols' fold but is not that fold: there is no leading run to
 * cross here, and no developer role to trade with.
 */
export const applyRoleCompatibilityToAnthropicMessages = defineStage<
  Chat<'request.chat.anthropicMessages' | 'route.attempt'>,
  Chat<'request.chat.anthropicMessages'>,
  Chat<'response.chat.anthropicMessages'>,
  Chat<'response.chat.anthropicMessages'>
>({
  name: 'applyRoleCompatibility',
  through: {
    request: {
      needs: ['request.chat.anthropicMessages', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.anthropicMessages'],
    },
    response: { needs: ['response.chat.anthropicMessages'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.anthropicMessages' | 'route.attempt'>,
    Chat<'request.chat.anthropicMessages'>,
    Chat<'response.chat.anthropicMessages'>,
    Chat<'response.chat.anthropicMessages'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('rewrite-mid-conv-system-to-user')) return facts;
      const payload = facts['request.chat.anthropicMessages'];
      const messages = mapKeepingIdentity(payload.messages, message =>
        message.role === 'system' ? { role: 'user' as const, content: message.content } : message);
      return messages === payload.messages
        ? facts
        : { ...facts, 'request.chat.anthropicMessages': move({ ...payload, messages }) };
    },
  })),
});

/** The reasoning sentinel a forced tool choice needs, in the shape this protocol has
 *  natively. `tool` and `any` are the forced choices; `auto` and `none` leave the model free
 *  to reason. */
export const disableReasoningOnForcedToolChoiceForAnthropicMessages = defineStage<
  Chat<'request.chat.anthropicMessages' | 'route.attempt'>,
  Chat<'request.chat.anthropicMessages'>,
  Chat<'response.chat.anthropicMessages'>,
  Chat<'response.chat.anthropicMessages'>
>({
  name: 'disableReasoningOnForcedToolChoice',
  through: {
    request: {
      needs: ['request.chat.anthropicMessages', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.anthropicMessages'],
    },
    response: { needs: ['response.chat.anthropicMessages'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.anthropicMessages' | 'route.attempt'>,
    Chat<'request.chat.anthropicMessages'>,
    Chat<'response.chat.anthropicMessages'>,
    Chat<'response.chat.anthropicMessages'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('disable-reasoning-on-forced-tool-choice')) {
        return facts;
      }
      const payload = facts['request.chat.anthropicMessages'];
      const choice = payload.tool_choice?.type;
      if (choice !== 'tool' && choice !== 'any') return facts;
      return { ...facts, 'request.chat.anthropicMessages': move(withAnthropicMessagesReasoningDisabled(payload)) };
    },
  })),
});

/** Only the reasoning subfield goes with the sentinel: a forced tool choice composes fine
 *  with structured output on these upstreams, and it is thinking it does not compose with, so
 *  `output_config.format` has to survive. An `output_config` that held nothing but the effort
 *  is nothing at all once the effort is gone, so it goes rather than riding on empty. */
const withAnthropicMessagesReasoningDisabled = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  const { output_config, ...rest } = payload;
  const next: AnthropicMessagesPayload = { ...rest, thinking: { type: 'disabled' as const } };
  if (output_config !== undefined) {
    const remaining = withoutKeys(output_config, ['effort']);
    if (Object.keys(remaining).length > 0) next.output_config = remaining;
  }
  return next;
};

/**
 * Scrubs Claude Code's billing-attribution block out of the system prompt.
 *
 * The block leads every Claude Code turn as `system[0]`:
 * `x-anthropic-billing-header: cc_version=<version>.<fingerprint>; cc_entrypoint=<entrypoint>;`
 * with optional `cch=`, `cc_workload=` and `cc_prev_req=` segments after it. Two of those parts
 * vary per call — the version's trailing fingerprint is derived from the first user message,
 * and `cch=` was a per-request nonce on builds through 2.1.177 — so an upstream reading the
 * block as ordinary prompt text sees a different prompt every turn and reuses nothing. One
 * report measured stripping the line as taking the prefix cache from 0% to ~99.7%.
 * https://github.com/anthropics/claude-code/issues/68900
 * https://github.com/anthropics/claude-code/issues/50085
 *
 * Anthropic's own endpoint wants it intact, which is what the flag is for: it is on for the
 * upstreams that treat the block as text and off for the one that reads it. What that endpoint
 * does with it is not documented anywhere primary — the observable part is that the CLI adds
 * *more* of these fields on its first-party path, so it reads as a client-attribution signal.
 */
export const stripBillingAttributionFromAnthropicMessages = defineStage<
  Chat<'request.chat.anthropicMessages' | 'route.attempt'>,
  Chat<'request.chat.anthropicMessages'>,
  Chat<'response.chat.anthropicMessages'>,
  Chat<'response.chat.anthropicMessages'>
>({
  name: 'stripBillingAttribution',
  through: {
    request: {
      needs: ['request.chat.anthropicMessages', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.anthropicMessages'],
    },
    response: { needs: ['response.chat.anthropicMessages'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.anthropicMessages' | 'route.attempt'>,
    Chat<'request.chat.anthropicMessages'>,
    Chat<'response.chat.anthropicMessages'>,
    Chat<'response.chat.anthropicMessages'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('strip-billing-attribution')) return facts;
      const payload = facts['request.chat.anthropicMessages'];
      const system = scrubbedSystemPrompt(payload.system);
      if (system === payload.system) return facts;
      const withoutSystem = withoutKeys(payload, ['system']);
      return {
        ...facts,
        'request.chat.anthropicMessages': move(system === undefined ? withoutSystem : { ...withoutSystem, system }),
      };
    },
  })),
});

const BILLING_HEADER_LINE = /x-anthropic-billing-header[^\n]*/g;
// Swept separately from the line because a `cch=` also reaches the prompt replayed inside
// message content, where the line pattern cannot see it. Every value captured in the wild is
// five hex digits with a trailing semicolon.
// https://github.com/anthropics/claude-code/issues/40652
const BILLING_CACHE_HASH = /cch=[0-9a-f]{5,};?/gi;

const scrubText = (text: string): string =>
  text.replace(BILLING_HEADER_LINE, '').replace(BILLING_CACHE_HASH, '').trim();

/** What is left of the system prompt once the block is out of it: the value that came in when
 *  there was nothing to scrub, and `undefined` when nothing at all is left — an empty system
 *  prompt is not a system prompt, so the field goes rather than riding on empty. */
const scrubbedSystemPrompt = (system: AnthropicMessagesPayload['system']): AnthropicMessagesPayload['system'] => {
  if (system === undefined) return undefined;
  if (typeof system === 'string') {
    const scrubbed = scrubText(system);
    if (scrubbed.length === 0) return undefined;
    return scrubbed === system ? system : scrubbed;
  }
  let changed = false;
  const blocks = system.flatMap(block => {
    const text = scrubText(block.text);
    if (text.length === 0) { changed = true; return []; }
    if (text === block.text) return [block];
    changed = true;
    return [{ ...block, text }];
  });
  if (!changed) return system;
  return blocks.length > 0 ? blocks : undefined;
};

// ── Gemini generateContent ────────────────────────────────────────────────────────────────
//
// The three strippers below are unconditional rather than flag-gated, and that is a statement
// about the target graph rather than about any upstream: Gemini generateContent has no wire of its own here,
// so every turn is served through a translation, and what no translation can carry cannot be
// sent whichever candidate answers. Stripping is a rewrite rather than a deletion — the record
// is frozen, so a stage that deleted a key in place would throw rather than strip.

/** Gemini generateContent file and code parts have no equivalent anywhere the translations reach, so they go
 *  at source and every target sees translatable parts. A part left holding nothing goes with
 *  them: it is not a part any more. */
export const stripUnsupportedPartFieldsFromGeminiGenerateContent = defineStage<
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>
>({
  name: 'stripUnsupportedPartFields',
  through: {
    request: { needs: ['request.chat.geminiGenerateContent'], consumes: [], provides: ['request.chat.geminiGenerateContent'] },
    response: { needs: ['response.chat.geminiGenerateContent'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>
  >(() => ({
    request: facts => {
      const payload = facts['request.chat.geminiGenerateContent'];
      const stripped = withUnsupportedPartFieldsStripped(payload);
      return stripped === payload ? facts : { ...facts, 'request.chat.geminiGenerateContent': move(stripped) };
    },
  })),
});

/** `fileData` addresses a Google-hosted file the API will not hand back — "you can use the API
 *  to get metadata about the files, but you can't download the files" — and the two code parts
 *  are the transcript of the server-side `codeExecution` tool that the stage below strips.
 *  None survives a translation, so they go at source.
 *  https://ai.google.dev/gemini-api/docs/files
 *  https://ai.google.dev/gemini-api/docs/code-execution */
const UNSUPPORTED_GEMINI_PART_FIELDS = ['fileData', 'executableCode', 'codeExecutionResult'] as const;

const withUnsupportedPartFieldsStripped = (payload: GeminiGenerateContentPayload): GeminiGenerateContentPayload => {
  const contents = payload.contents === undefined
    ? undefined
    : mapKeepingIdentity(payload.contents, stripContentParts);
  const systemInstruction = payload.systemInstruction === undefined
    ? undefined
    : stripContentParts(payload.systemInstruction);
  if (contents === payload.contents && systemInstruction === payload.systemInstruction) return payload;
  return {
    ...payload,
    ...(contents === undefined ? {} : { contents }),
    ...(systemInstruction === undefined ? {} : { systemInstruction }),
  };
};

const stripContentParts = (content: GeminiGenerateContentContent): GeminiGenerateContentContent => {
  let changed = false;
  const parts = content.parts.flatMap(part => {
    const stripped = withoutKeys(part, UNSUPPORTED_GEMINI_PART_FIELDS);
    if (stripped === part) return [part];
    changed = true;
    return Object.keys(stripped).length > 0 ? [stripped] : [];
  });
  return changed ? { ...content, parts } : content;
};

/** Only function declarations translate out of a Gemini generateContent tool group, so the rest of a group's
 *  capabilities go — and a group left declaring no function goes with them, because a target
 *  emitter offered an empty group would be offered a tool that does nothing. `tools` itself
 *  goes when no group survived: an empty tool list is a different request from no tools. */
export const stripUnsupportedToolsFromGeminiGenerateContent = defineStage<
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>
>({
  name: 'stripUnsupportedTools',
  through: {
    request: { needs: ['request.chat.geminiGenerateContent'], consumes: [], provides: ['request.chat.geminiGenerateContent'] },
    response: { needs: ['response.chat.geminiGenerateContent'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>
  >(() => ({
    request: facts => {
      const payload = facts['request.chat.geminiGenerateContent'];
      const stripped = withUnsupportedToolsStripped(payload);
      return stripped === payload ? facts : { ...facts, 'request.chat.geminiGenerateContent': move(stripped) };
    },
  })),
});

/** Every field a Gemini generateContent tool group can carry other than `functionDeclarations` — the
 *  capabilities Google executes inside its own generation loop, which no target wire can be
 *  asked to run. `functionDeclarations` is the one that survives because the model "does not
 *  execute the function"; it asks the caller to. Re-derive against the `Tool` schema whenever
 *  it gains a field, which it still does.
 *  https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta
 *  https://ai.google.dev/api/generate-content */
const UNSUPPORTED_GEMINI_TOOL_CAPABILITIES = [
  'googleSearch',
  'googleSearchRetrieval',
  'codeExecution',
  'computerUse',
  'urlContext',
  'fileSearch',
  'mcpServers',
  'googleMaps',
] as const;

const withUnsupportedToolsStripped = (payload: GeminiGenerateContentPayload): GeminiGenerateContentPayload => {
  const { tools } = payload;
  if (tools === undefined) return payload;
  let changed = false;
  const kept: GeminiGenerateContentToolGroup[] = [];
  for (const tool of tools) {
    const stripped = withoutKeys(tool, UNSUPPORTED_GEMINI_TOOL_CAPABILITIES);
    if (stripped !== tool) changed = true;
    if (stripped.functionDeclarations !== undefined && stripped.functionDeclarations.length > 0) kept.push(stripped);
    else changed = true;
  }
  if (kept.length === 0) return withoutKeys(payload, ['tools']);
  return changed ? { ...payload, tools: kept } : payload;
};

/** Gemini generateContent safety controls are source-specific and have no matching control on every target
 *  path, so they go rather than have us pretend to enforce a policy we cannot honor
 *  end to end. */
export const stripSafetySettingsFromGeminiGenerateContent = defineStage<
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>
>({
  name: 'stripSafetySettings',
  through: {
    request: { needs: ['request.chat.geminiGenerateContent'], consumes: [], provides: ['request.chat.geminiGenerateContent'] },
    response: { needs: ['response.chat.geminiGenerateContent'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>
  >(() => ({
    request: facts => {
      const payload = facts['request.chat.geminiGenerateContent'];
      const stripped = withoutKeys(payload, ['safetySettings']);
      return stripped === payload ? facts : { ...facts, 'request.chat.geminiGenerateContent': move(stripped) };
    },
  })),
});

/**
 * Hides Gemini generateContent thought-summary parts from a caller who did not ask for them.
 *
 * The opt-in is `generationConfig.thinkingConfig.includeThoughts`, which is something the
 * client sent — a request-direction reading — and the rule that uses it runs on the way back.
 * So it rides in this stage's own closure rather than as a declaration: a response-side
 * `needs` can only name what the ending provides, which is the answer and not the turn.
 */
export const suppressThoughtPartsFromGeminiGenerateContent = defineStage<
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>
>({
  name: 'suppressThoughtParts',
  through: {
    request: { needs: ['request.chat.geminiGenerateContent'], consumes: [], provides: [] },
    response: { needs: ['response.chat.geminiGenerateContent'], consumes: [], provides: ['response.chat.geminiGenerateContent'] },
  },
  execute: transform<
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>
  >(() => {
    // Assigned on the way down and read on the way back, which is the order `transform` runs
    // the two halves in.
    let includeThoughts!: boolean;
    return {
      request: facts => {
        includeThoughts = facts['request.chat.geminiGenerateContent'].generationConfig?.thinkingConfig?.includeThoughts === true;
        return facts;
      },
      response: facts => {
        if (includeThoughts) return facts;
        const answer = facts['response.chat.geminiGenerateContent'];
        // A refusal and a collected body have no thought parts to hide, and telling the three
        // apart is reading a value rather than dispatching on a declaration.
        if (isFailure(answer) || answer.kind !== 'stream') return facts;
        const frames = answer.frames as AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>;
        return {
          ...facts,
          'response.chat.geminiGenerateContent': move({
            kind: 'stream' as const,
            frames: { [Symbol.asyncIterator]: () => withoutThoughtParts(frames) },
          }),
        };
      },
    };
  }),
});

/** A candidate that has nothing left to say and has not finished is not a candidate, and an
 *  event left carrying no candidate, no usage, no model and no id is not an event — dropping
 *  both is what keeps a stream of pure thought from reaching the client as a stream of
 *  empties. */
const withoutThoughtParts = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type !== 'event' || 'error' in frame.event) {
      yield frame;
      continue;
    }

    const candidates = frame.event.candidates?.flatMap(candidate => {
      const parts = candidate.content.parts.filter(part => part.thought !== true);
      if (!parts.length && candidate.finishReason === undefined) return [];
      return [{ ...candidate, content: { ...candidate.content, parts } }];
    });

    const event: GeminiGenerateContentStreamEvent = {
      ...frame.event,
      ...(candidates === undefined ? {} : { candidates }),
    };
    if (hasGeminiGenerateContentEventPayload(event)) yield eventFrame(event);
  }
};

const hasGeminiGenerateContentEventPayload = (event: GeminiGenerateContentStreamEvent): boolean => {
  if ('error' in event) return true;
  return (event.candidates?.length ?? 0) > 0
    || event.usageMetadata !== undefined
    || event.modelVersion !== undefined
    || event.responseId !== undefined;
};

// ── OpenAI Responses ──────────────────────────────────────────────────────────────────────

/** Role rewrites, in the same fixed order and by the same fold as OpenAI Chat Completions; what is
 *  here is the walk over this protocol's input items. Only a message item carries a role, and
 *  an item that carries none still crosses the leading system run — a reasoning item between
 *  two system messages is what makes the second one mid-conversation. */
export const applyRoleCompatibilityToOpenAIResponses = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'applyRoleCompatibility',
  through: {
    request: {
      needs: ['request.chat.openaiResponses', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiResponses'],
    },
    response: { needs: ['response.chat.openaiResponses'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiResponses' | 'route.attempt'>,
    Chat<'request.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>
  >(() => ({
    request: facts => {
      const rewrite = rolesFor(facts['route.attempt'].flags);
      if (rewrite === null) return facts;                       // the free do-nothing path
      // The key holds what a client may send, whose `input` is a string or a list; this chain
      // runs on the canonical form the entry normalized it to, which is the one a wire takes.
      const payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
      const nextRole = roleRewriter(rewrite);
      const input = mapKeepingIdentity(payload.input, (item): OpenAIResponsesInputItem => {
        if (item.type !== 'message') {
          nextRole(undefined);
          return item;
        }
        const role = nextRole(item.role);
        return role === item.role ? item : { ...item, role };
      });
      return input === payload.input
        ? facts
        : { ...facts, 'request.chat.openaiResponses': move({ ...payload, input }) };
    },
  })),
});

/** The reasoning sentinel a forced tool choice needs. `required` or a named tool is forced;
 *  `auto` and `none` leave the model free to reason. The `reasoning` object is replaced
 *  rather than merged — a summary has no meaning once there is nothing to summarize — and
 *  the sentinel is the gateway's canonical form, which is why this runs above the vendor
 *  normalizers that put it on the wire in a vendor's shape. */
export const disableReasoningOnForcedToolChoiceForOpenAIResponses = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'disableReasoningOnForcedToolChoice',
  through: {
    request: {
      needs: ['request.chat.openaiResponses', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiResponses'],
    },
    response: { needs: ['response.chat.openaiResponses'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiResponses' | 'route.attempt'>,
    Chat<'request.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('disable-reasoning-on-forced-tool-choice')) {
        return facts;
      }
      const payload = facts['request.chat.openaiResponses'];
      if (!isForcedOpenAIResponsesToolChoice(payload.tool_choice)) return facts;
      return { ...facts, 'request.chat.openaiResponses': move({ ...payload, reasoning: { effort: 'none' } }) };
    },
  })),
});

const isForcedOpenAIResponsesToolChoice = (choice: OpenAIResponsesPayload['tool_choice']): boolean => {
  if (choice === undefined || choice === null) return false;
  if (typeof choice === 'string') return choice === 'required';
  return true;
};

/** Drops a field the upstream would reject as an unknown argument. It runs above the vendor
 *  normalizers so each of them sees the already-stripped canonical payload. */
export const stripPromptCacheKeyForOpenAIResponses = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'stripPromptCacheKey',
  through: {
    request: {
      needs: ['request.chat.openaiResponses', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiResponses'],
    },
    response: { needs: ['response.chat.openaiResponses'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiResponses' | 'route.attempt'>,
    Chat<'request.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('strip-prompt-cache-key')) return facts;
      const payload = facts['request.chat.openaiResponses'];
      const stripped = withoutKeys(payload, ['prompt_cache_key']);
      return stripped === payload ? facts : { ...facts, 'request.chat.openaiResponses': move(stripped) };
    },
  })),
});

/**
 * Restores OpenAI's inclusive input-token contract on an upstream that reports the cache
 * buckets alongside `input_tokens` instead of inside it.
 *
 * Unconditional on this chain rather than flag-gated: `foldsExclusiveCacheTokens` owns the
 * decision and reads `total_tokens` as the witness, and the `usage-exclusive-cached-tokens`
 * flag is a declaration input for the responses whose totals witness nothing. Every event
 * that carries a response resource repeats the whole resource, so the rewrite applies to each
 * of them rather than to a single terminal frame. The evidence for the two conventions and
 * the contradictions that raise are documented at `foldsExclusiveCacheTokens` and at
 * `withCacheBucketsFolded`, which is the fold itself.
 */
export const normalizeExclusiveCachedTokensForOpenAIResponses = defineStage<
  Chat<'route.attempt'>,
  Chat<'route.attempt'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'normalizeExclusiveCachedTokens',
  through: {
    request: { needs: ['route.attempt'], consumes: [], provides: [] },
    response: { needs: ['response.chat.openaiResponses'], consumes: [], provides: ['response.chat.openaiResponses'] },
  },
  execute: transform<
    Chat<'route.attempt'>,
    Chat<'route.attempt'>,
    Chat<'response.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>
  >(() => {
    // Which attempt this is gets read on the way down and spoken about on the way back, which
    // is the order `transform` runs the two halves in.
    let attempt!: AttemptSelector;
    return {
      request: facts => {
        attempt = facts['route.attempt'];
        return facts;
      },
      response: facts => {
        const declaredExclusive = attempt.flags.includes('usage-exclusive-cached-tokens');
        const identity = attemptIdentity(attempt);
        const answer = answerWithFrames<OpenAIResponsesStreamEvent>(
          facts['response.chat.openaiResponses'],
          frames => rewritingEvents(frames, event => foldOpenAIResponsesUsage(event, declaredExclusive, identity)),
        );
        return answer === null ? facts : { ...facts, 'response.chat.openaiResponses': move(answer) };
      },
    };
  }),
});

/** OpenAI Responses carries usage on `event.response.usage` and names the buckets `input_tokens` and
 *  `input_tokens_details.{cached_tokens, cache_write_tokens}`. */
const OPENAI_RESPONSES_CACHE_BUCKETS: CacheBucketNames = {
  input: 'input_tokens',
  output: 'output_tokens',
  details: 'input_tokens_details',
  cacheWrite: ['cache_write_tokens'],
};

const foldOpenAIResponsesUsage = (
  event: OpenAIResponsesStreamEvent,
  declaredExclusive: boolean,
  identity: string,
): OpenAIResponsesStreamEvent => {
  if (!('response' in event)) return event;
  const response = asJsonObject(event.response);
  const usage = asJsonObject(response?.usage);
  if (response === null || usage === null) return event;
  const folded = withCacheBucketsFolded(usage, OPENAI_RESPONSES_CACHE_BUCKETS, declaredExclusive, identity);
  if (folded === usage) return event;
  return { ...event, response: { ...response, usage: folded } as JsonObject } as unknown as OpenAIResponsesStreamEvent;
};

/** DeepSeek says "no reasoning" with a top-level `thinking: { type: 'disabled' }` rather than
 *  with the canonical sentinel, so the sentinel is put into its wire form here — last among
 *  this chain's rewrites, because a vendor normalizer has the final say on the outbound body.
 *  https://api-docs.deepseek.com/zh-cn/guides/thinking_mode */
export const vendorDeepSeekNormalizeForOpenAIResponses = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'vendorDeepSeekNormalize',
  through: {
    request: {
      needs: ['request.chat.openaiResponses', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiResponses'],
    },
    response: { needs: ['response.chat.openaiResponses'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiResponses' | 'route.attempt'>,
    Chat<'request.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('vendor-deepseek')) return facts;
      const payload = facts['request.chat.openaiResponses'];
      if (payload.reasoning?.effort !== 'none') return facts;
      const { reasoning, ...rest } = payload;
      const normalized: OpenAIResponsesPayloadWithDeepSeekThinking = { ...rest, thinking: { type: 'disabled' } };
      return { ...facts, 'request.chat.openaiResponses': move(normalized) };
    },
  })),
});

/** Qwen says the same thing with a top-level `enable_thinking: false`.
 *  https://www.alibabacloud.com/help/en/model-studio/deep-thinking */
export const vendorQwenNormalizeForOpenAIResponses = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'vendorQwenNormalize',
  through: {
    request: {
      needs: ['request.chat.openaiResponses', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiResponses'],
    },
    response: { needs: ['response.chat.openaiResponses'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiResponses' | 'route.attempt'>,
    Chat<'request.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('vendor-qwen')) return facts;
      const payload = facts['request.chat.openaiResponses'];
      if (payload.reasoning?.effort !== 'none') return facts;
      const { reasoning, ...rest } = payload;
      const normalized: OpenAIResponsesPayloadWithQwenThinking = { ...rest, enable_thinking: false };
      return { ...facts, 'request.chat.openaiResponses': move(normalized) };
    },
  })),
});

/** Neither field is an OpenAI Responses field, so each is declared beside the vendor that reads it
 *  rather than widening the protocol's own request type. */
type OpenAIResponsesPayloadWithDeepSeekThinking = Omit<OpenAIResponsesPayload, 'reasoning'> & { thinking: { type: 'disabled' } };
type OpenAIResponsesPayloadWithQwenThinking = Omit<OpenAIResponsesPayload, 'reasoning'> & { enable_thinking: false };
