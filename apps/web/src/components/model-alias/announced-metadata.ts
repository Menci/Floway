import type { AliasTarget, AnnouncedMetadata, ChatAliasRules, ChatModelInfo, ControlPlaneModel, ModelKind, PublicModelLimits } from "../../api/types";

const intersectArrays = <T,>(arrays: readonly (readonly T[])[]) => {
  if (!arrays.length) return [];
  return arrays[0]!.filter((value) => arrays.slice(1).every((array) => array.includes(value)));
};

function effectiveChat(chat: ChatModelInfo | undefined, rules: ChatAliasRules): ChatModelInfo | undefined {
  if (!chat?.reasoning || !rules.reasoning) return chat;
  const reasoning = { ...chat.reasoning };
  if (rules.reasoning.effort !== undefined) delete reasoning.effort;
  if (rules.reasoning.budget_tokens !== undefined) delete reasoning.budget_tokens;
  if (rules.reasoning.adaptive === true) delete reasoning.adaptive;
  return { ...chat, reasoning };
}

function intersectChat(chats: readonly ChatModelInfo[]): ChatModelInfo | undefined {
  const result: ChatModelInfo = {};
  if (chats.every((chat) => chat.modalities)) {
    const input = intersectArrays(chats.map((chat) => chat.modalities!.input));
    const output = intersectArrays(chats.map((chat) => chat.modalities!.output));
    if (input.length && output.length) result.modalities = { input, output };
  }
  if (chats.every((chat) => chat.reasoning)) {
    const blocks = chats.map((chat) => chat.reasoning!);
    const reasoning: NonNullable<ChatModelInfo["reasoning"]> = {};
    if (blocks.every((block) => block.effort)) {
      const supported = intersectArrays(blocks.map((block) => block.effort!.supported));
      if (supported.length) {
        const defaults = new Set(blocks.map((block) => block.effort!.default));
        const agreed = defaults.size === 1 ? [...defaults][0] : undefined;
        reasoning.effort = { supported, default: agreed && supported.includes(agreed) ? agreed : supported[0]! };
      }
    }
    if (blocks.every((block) => block.budget_tokens)) {
      const budgets = blocks.map((block) => block.budget_tokens!);
      if (budgets.every((budget) => budget.min !== undefined && budget.max !== undefined)) {
        const min = Math.max(...budgets.map((budget) => budget.min!));
        const max = Math.min(...budgets.map((budget) => budget.max!));
        if (min <= max) reasoning.budget_tokens = { min, max };
      }
    }
    for (const field of ["adaptive", "mandatory"] as const) {
      const values = new Set(blocks.map((block) => block[field]));
      if (values.size === 1 && [...values][0] !== undefined) reasoning[field] = [...values][0];
    }
    if (Object.keys(reasoning).length) result.reasoning = reasoning;
  }
  return Object.keys(result).length ? result : undefined;
}

export function computeAnnouncedMetadata(
  targets: readonly AliasTarget[],
  kind: ModelKind,
  models: readonly ControlPlaneModel[] | null | undefined,
): AnnouncedMetadata {
  const catalog = new Map((models ?? []).filter((model) => model.aliasedFrom === undefined).map((model) => [model.id, model]));
  const available = targets
    .map((target) => ({ target, model: catalog.get(target.target_model_id) }))
    .filter((entry): entry is { target: AliasTarget; model: ControlPlaneModel } => entry.model?.kind === kind);
  if (!available.length) return {};
  const limits: PublicModelLimits = {};
  for (const key of ["max_context_window_tokens", "max_prompt_tokens", "max_output_tokens"] as const) {
    const values = available.map(({ model }) => model.limits[key]);
    if (values.every((value): value is number => value !== undefined)) limits[key] = Math.min(...values);
  }
  const out: AnnouncedMetadata = {};
  if (Object.keys(limits).length) out.limits = limits;
  const chats = available.map(({ target, model }) => effectiveChat(model.chat, target.rules));
  if (chats.every((chat): chat is ChatModelInfo => chat !== undefined)) out.chat = intersectChat(chats);
  return out;
}
