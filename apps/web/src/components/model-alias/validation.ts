import type { AliasTarget, AnnouncedMetadata } from '@floway-dev/protocols/browser';

const isTokenCount = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

export const targetIssue = (target: AliasTarget): string | null => {
  if (!target.target_model_id.trim()) return 'models.aliases.validation.targetRequired';
  const reasoning = target.rules.reasoning;
  if (reasoning?.budget_tokens !== undefined && !isTokenCount(reasoning.budget_tokens)) {
    return 'models.aliases.validation.budget';
  }
  if (reasoning?.adaptive === true && reasoning.budget_tokens !== undefined) {
    return 'models.aliases.validation.adaptiveBudget';
  }
  return null;
};

export const ANNOUNCED_METADATA_FIELDS = [
  'max_context_window_tokens',
  'max_prompt_tokens',
  'max_output_tokens',
  'budgetMin',
  'budgetMax',
] as const;

export type AnnouncedMetadataField = typeof ANNOUNCED_METADATA_FIELDS[number];

export type AnnouncedMetadataIssues = Partial<Record<AnnouncedMetadataField, string>>;

export const announcedMetadataIssues = (metadata: AnnouncedMetadata): AnnouncedMetadataIssues => {
  const issues: AnnouncedMetadataIssues = {};
  for (const [key, value] of Object.entries(metadata.limits ?? {})) {
    if (!isTokenCount(value)) issues[key as AnnouncedMetadataField] = 'models.aliases.validation.metadataNumber';
  }
  const budget = metadata.chat?.reasoning?.budget_tokens;
  if (budget?.min !== undefined && !isTokenCount(budget.min)) issues.budgetMin = 'models.aliases.validation.metadataNumber';
  if (budget?.max !== undefined && !isTokenCount(budget.max)) issues.budgetMax = 'models.aliases.validation.metadataNumber';
  // Report the ordering only once both ends are readable numbers.
  if (issues.budgetMax === undefined && issues.budgetMin === undefined && budget?.min !== undefined && budget.max !== undefined && budget.max < budget.min) {
    issues.budgetMax = 'models.aliases.validation.metadataRange';
  }
  return issues;
};
