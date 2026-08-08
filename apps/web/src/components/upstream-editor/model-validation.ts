import { pricingEntryDraftsFor, pricingIsValid } from './pricing-model';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { validateUpstreamPath } from '@floway-dev/provider/join';
import { modelsField, type UpstreamModelConfig } from '@floway-dev/provider/model-config';

export type ModelValidationField = 'configuration' | 'endpoints' | 'pricing' | 'reasoning' | 'rerankTarget' | 'upstreamModelId';

export interface ModelValidationIssue {
  field: ModelValidationField;
  message: string;
}

export const modelValidationIssues = (model: UpstreamModelConfig): ModelValidationIssue[] => {
  const issues: ModelValidationIssue[] = [];
  if (model.upstreamModelId.trim() === '') {
    issues.push({ field: 'upstreamModelId', message: 'dashboard.upstreamEditor.models.upstreamIdRequired' });
  }
  if (Object.keys(model.endpoints).length === 0) {
    issues.push({ field: 'endpoints', message: 'dashboard.upstreamEditor.models.endpointsRequired' });
  }

  const effectiveKind = Object.keys(model.endpoints).length === 0 ? null : kindForEndpoints(model.endpoints);
  if (effectiveKind === 'rerank' && model.rerankTarget === undefined) {
    issues.push({ field: 'rerankTarget', message: 'dashboard.upstreamEditor.models.rerankTargetRequired' });
  } else if (effectiveKind !== null && effectiveKind !== 'rerank' && model.rerankTarget !== undefined) {
    issues.push({ field: 'rerankTarget', message: 'dashboard.upstreamEditor.models.rerankTargetUnexpected' });
  } else if (model.rerankTarget?.path !== undefined && !validateUpstreamPath(model.rerankTarget.path, 'path').ok) {
    issues.push({ field: 'rerankTarget', message: 'dashboard.upstreamEditor.models.rerankPathInvalid' });
  }

  const effort = model.chat?.reasoning?.effort;
  if (effort && (effort.supported.length === 0 || !effort.default || !effort.supported.includes(effort.default))) {
    issues.push({ field: 'reasoning', message: 'dashboard.upstreamEditor.models.invalidEffort' });
  }
  const budget = model.chat?.reasoning?.budget_tokens;
  if (budget?.min !== undefined && budget.max !== undefined && budget.max < budget.min) {
    issues.push({ field: 'reasoning', message: 'dashboard.upstreamEditor.models.invalidBudget' });
  }
  if (!pricingIsValid(pricingEntryDraftsFor(model.pricing), model.pricing)) {
    issues.push({ field: 'pricing', message: 'dashboard.upstreamEditor.models.invalidPricing' });
  }
  if (issues.length > 0) return issues;

  try {
    modelsField([model], 'model');
  } catch {
    issues.push({ field: 'configuration', message: 'dashboard.upstreamEditor.models.invalidConfiguration' });
  }
  return issues;
};

export const modelsAreValid = (models: readonly UpstreamModelConfig[]) =>
  models.every(model => modelValidationIssues(model).length === 0);
