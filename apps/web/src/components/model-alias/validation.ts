import type { AliasTarget, AnnouncedMetadata } from '@floway-dev/protocols/common';
import { assertCodexContextWindow, codexChatField } from '@floway-dev/provider/model-config';

const isTokenCount = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

export const targetIssue = (target: AliasTarget): string | null => {
  if (!target.target_model_id.trim()) return 'dashboard.modelAliases.validation.targetRequired';
  const reasoning = target.rules.reasoning;
  if (reasoning?.budget_tokens !== undefined && !isTokenCount(reasoning.budget_tokens)) {
    return 'dashboard.modelAliases.validation.budget';
  }
  if (reasoning?.adaptive === true && reasoning.budget_tokens !== undefined) {
    return 'dashboard.modelAliases.validation.adaptiveBudget';
  }
  return null;
};

export const ANNOUNCED_METADATA_FIELDS = [
  'max_context_window_tokens',
  'max_prompt_tokens',
  'max_output_tokens',
  'budgetMin',
  'budgetMax',
  'codex',
] as const;

export type AnnouncedMetadataField = typeof ANNOUNCED_METADATA_FIELDS[number];

export type AnnouncedMetadataIssues = Partial<Record<AnnouncedMetadataField, string>>;

export const announcedMetadataIssues = (metadata: AnnouncedMetadata): AnnouncedMetadataIssues => {
  const issues: AnnouncedMetadataIssues = {};
  try {
    if (metadata.chat?.codex !== undefined) codexChatField(metadata.chat.codex, 'chat.codex');
    assertCodexContextWindow(metadata.chat?.codex, metadata.limits, 'metadata');
  } catch {
    issues.codex = 'dashboard.upstreamEditor.models.invalidConfiguration';
  }
  for (const [key, value] of Object.entries(metadata.limits ?? {})) {
    if (!isTokenCount(value)) issues[key as AnnouncedMetadataField] = 'dashboard.modelAliases.validation.metadataNumber';
  }
  const budget = metadata.chat?.reasoning?.budget_tokens;
  if (budget?.min !== undefined && !isTokenCount(budget.min)) issues.budgetMin = 'dashboard.modelAliases.validation.metadataNumber';
  if (budget?.max !== undefined && !isTokenCount(budget.max)) issues.budgetMax = 'dashboard.modelAliases.validation.metadataNumber';
  // Report the ordering only once both ends are readable numbers.
  if (issues.budgetMax === undefined && issues.budgetMin === undefined && budget?.min !== undefined && budget.max !== undefined && budget.max < budget.min) {
    issues.budgetMax = 'dashboard.modelAliases.validation.metadataRange';
  }
  return issues;
};
