import { pricingEntryDraftsFor, pricingIsValid } from './pricing-model';
import { kindForEndpoints } from '@floway-dev/protocols/browser';
import { validateUpstreamPath, modelsField, type UpstreamModelConfig } from '@floway-dev/provider/browser';

export type ModelValidationField = 'configuration' | 'endpoints' | 'pricing' | 'reasoning' | 'rerankTarget' | 'decisionTarget' | 'upstreamModelId';

export interface ModelValidationIssue {
  field: ModelValidationField;
  message: string;
}

export const modelValidationIssues = (model: UpstreamModelConfig): ModelValidationIssue[] => {
  const issues: ModelValidationIssue[] = [];
  if (model.upstreamModelId.trim() === '') {
    issues.push({ field: 'upstreamModelId', message: 'models.editor.upstreamIdRequired' });
  }
  if (Object.keys(model.endpoints).length === 0) {
    issues.push({ field: 'endpoints', message: 'models.editor.endpointsRequired' });
  }

  const effectiveKind = Object.keys(model.endpoints).length === 0 ? null : kindForEndpoints(model.endpoints);
  if (effectiveKind === 'rerank' && model.rerankTarget === undefined) {
    issues.push({ field: 'rerankTarget', message: 'models.editor.rerankTargetRequired' });
  } else if (effectiveKind !== null && effectiveKind !== 'rerank' && model.rerankTarget !== undefined) {
    issues.push({ field: 'rerankTarget', message: 'models.editor.rerankTargetUnexpected' });
  } else if (model.rerankTarget?.path !== undefined && !validateUpstreamPath(model.rerankTarget.path, 'path').ok) {
    issues.push({ field: 'rerankTarget', message: 'models.editor.rerankPathInvalid' });
  }
  if (effectiveKind !== null && effectiveKind !== 'decision' && model.decisionTarget !== undefined) {
    issues.push({ field: 'decisionTarget', message: 'models.editor.decisionTargetUnexpected' });
  } else if (model.decisionTarget?.path !== undefined && !validateUpstreamPath(model.decisionTarget.path, 'path').ok) {
    issues.push({ field: 'decisionTarget', message: 'models.editor.decisionPathInvalid' });
  }

  const effort = model.chat?.reasoning?.effort;
  if (effort && (effort.supported.length === 0 || !effort.default || !effort.supported.includes(effort.default))) {
    issues.push({ field: 'reasoning', message: 'models.editor.invalidEffort' });
  }
  const budget = model.chat?.reasoning?.budget_tokens;
  if (budget?.min !== undefined && budget.max !== undefined && budget.max < budget.min) {
    issues.push({ field: 'reasoning', message: 'models.editor.invalidBudget' });
  }
  if (!pricingIsValid(pricingEntryDraftsFor(model.pricing), model.pricing)) {
    issues.push({ field: 'pricing', message: 'models.editor.invalidPricing' });
  }
  if (issues.length > 0) return issues;

  try {
    modelsField([model], 'model');
  } catch {
    issues.push({ field: 'configuration', message: 'models.editor.invalidConfiguration' });
  }
  return issues;
};

export const modelsAreValid = (models: readonly UpstreamModelConfig[]) =>
  models.every(model => modelValidationIssues(model).length === 0);
