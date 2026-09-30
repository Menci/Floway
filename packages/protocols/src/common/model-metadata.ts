import type { ChatAliasRules } from './aliases.ts';
import type { ChatModelInfo, CodexChatModelInfo } from './models.ts';

const intersect = <T, R>(items: readonly T[], pick: (item: T) => R | undefined, combine: (values: R[]) => R | undefined): R | undefined => {
  const values = items.map(pick);
  return items.length > 0 && values.every((value): value is R => value !== undefined) ? combine(values) : undefined;
};

const common = <T>(values: T[]): T | undefined => {
  const serialized = values.map(value => JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item));
  return serialized.every(value => value === serialized[0]) ? values[0] : undefined;
};

const sharedValues = <T>(arrays: readonly (readonly T[])[]): T[] =>
  arrays[0]?.filter(value => arrays.every(array => array.includes(value))) ?? [];

export const chatMetadataWithRules = (chat: ChatModelInfo | undefined, rules: ChatAliasRules): ChatModelInfo | undefined => {
  if (chat === undefined) return undefined;
  const result = { ...chat };
  if (rules.verbosity !== undefined) delete result.verbosity;
  if (result.codex !== undefined) {
    result.codex = { ...result.codex };
    if (rules.verbosity !== undefined) delete result.codex.default_verbosity;
    if (rules.reasoning?.summary !== undefined) delete result.codex.default_reasoning_summary;
  }
  if (result.reasoning !== undefined) {
    result.reasoning = { ...result.reasoning };
    if (rules.reasoning?.effort !== undefined) delete result.reasoning.effort;
    if (rules.reasoning?.budget_tokens !== undefined) delete result.reasoning.budget_tokens;
    if (rules.reasoning?.adaptive === true) delete result.reasoning.adaptive;
  }
  return result;
};

export const intersectChatMetadata = (chats: readonly ChatModelInfo[]): ChatModelInfo | undefined => {
  const result: ChatModelInfo = {};
  const modalities = intersect(chats, chat => chat.modalities, values => {
    const input = sharedValues(values.map(value => value.input));
    const output = sharedValues(values.map(value => value.output));
    return input.length && output.length ? { input, output } : undefined;
  });
  if (modalities !== undefined) result.modalities = modalities;
  const original = intersect(chats, chat => chat.image_detail_original, values => values.every(Boolean));
  if (original !== undefined) result.image_detail_original = original;
  const verbosity = intersect(chats, chat => chat.verbosity, values => ({ supported: values.every(value => value.supported) }));
  if (verbosity !== undefined) result.verbosity = verbosity;
  const reasoning = intersect(chats, chat => chat.reasoning, values => {
    const block: NonNullable<ChatModelInfo['reasoning']> = {};
    const effort = intersect(values, value => value.effort, efforts => {
      const supported = sharedValues(efforts.map(value => value.supported));
      if (!supported.length) return undefined;
      const agreed = common(efforts.map(value => value.default));
      return { supported, default: agreed !== undefined && supported.includes(agreed) ? agreed : supported[0]! };
    });
    if (effort !== undefined) block.effort = effort;
    const budget = intersect(values, value => value.budget_tokens, budgets => {
      const min = intersect(budgets, value => value.min, numbers => Math.max(...numbers));
      const max = intersect(budgets, value => value.max, numbers => Math.min(...numbers));
      return min !== undefined && max !== undefined && min <= max ? { min, max } : undefined;
    });
    if (budget !== undefined) block.budget_tokens = budget;
    for (const key of ['adaptive', 'mandatory'] as const) {
      const value = intersect(values, item => item[key], common);
      if (value !== undefined) block[key] = value;
    }
    return Object.keys(block).length ? block : undefined;
  });
  if (reasoning !== undefined) result.reasoning = reasoning;
  const codex = intersect(chats, chat => chat.codex, profiles => {
    const profile: CodexChatModelInfo = {};
    for (const key of Object.keys(profiles[0]!) as (keyof CodexChatModelInfo)[]) {
      const value = intersect(profiles, item => item[key], values => {
        if (key === 'use_responses_lite' || key === 'supports_reasoning_effort_updates' || key === 'supports_search_tool') return values.every(value => value === true);
        if (key === 'default_context_window_tokens' || key === 'auto_compact_token_limit' || key === 'effective_context_window_percent') {
          if (values.every((value): value is number => typeof value === 'number')) return Math.min(...values);
        }
        return common(values);
      });
      if (value !== undefined) Object.assign(profile, { [key]: value });
    }
    return Object.keys(profile).length ? profile : undefined;
  });
  if (codex !== undefined) result.codex = codex;
  return Object.keys(result).length ? result : undefined;
};
