import type { AliasTarget, AnnouncedMetadata } from '../../api/types';

// What the dialog's controls can hold but an alias cannot mean. Each rule is
// stated once here and read twice: the editor that owns the control renders
// the message on it, and the dialog's schema asks the same question again to
// refuse the submit. Neither can drift from the other, and no rule can end up
// blocking a save without saying why.

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

export type AnnouncedMetadataField =
  | 'max_context_window_tokens'
  | 'max_prompt_tokens'
  | 'max_output_tokens'
  | 'budgetMin'
  | 'budgetMax';

export type AnnouncedMetadataIssues = Partial<Record<AnnouncedMetadataField, string>>;

export const announcedMetadataIssues = (metadata: AnnouncedMetadata): AnnouncedMetadataIssues => {
  const issues: AnnouncedMetadataIssues = {};
  for (const [key, value] of Object.entries(metadata.limits ?? {})) {
    if (!isTokenCount(value)) issues[key as AnnouncedMetadataField] = 'dashboard.modelAliases.validation.metadataNumber';
  }
  const budget = metadata.chat?.reasoning?.budget_tokens;
  if (budget?.min !== undefined && !isTokenCount(budget.min)) issues.budgetMin = 'dashboard.modelAliases.validation.metadataNumber';
  if (budget?.max !== undefined && !isTokenCount(budget.max)) issues.budgetMax = 'dashboard.modelAliases.validation.metadataNumber';
  // A range only means anything once both ends are numbers, so the ordering
  // rule waits for the ends to be readable rather than piling onto a field
  // that is already saying it holds the wrong kind of value.
  if (issues.budgetMax === undefined && issues.budgetMin === undefined && budget?.min !== undefined && budget.max !== undefined && budget.max < budget.min) {
    issues.budgetMax = 'dashboard.modelAliases.validation.metadataRange';
  }
  return issues;
};
