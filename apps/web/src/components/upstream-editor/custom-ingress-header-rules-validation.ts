import type { RefinementCtx } from 'zod';

import { customIngressHeaderNameIssue, isCustomIngressHeaderValue } from '@floway-dev/provider-custom/ingress-header-rules';

interface CustomIngressHeaderRuleDraft {
  key: string;
  value: string | null;
}

const nameMessages = {
  invalid: 'dashboard.upstreamEditor.headers.validation.invalidName',
  'anthropic-messages-owned': 'dashboard.upstreamEditor.headers.validation.anthropicMessagesOwned',
  'transport-owned': 'dashboard.upstreamEditor.headers.validation.transportOwned',
} as const;

export const refineCustomIngressHeaderRules = (
  rules: readonly CustomIngressHeaderRuleDraft[],
  context: RefinementCtx,
) => {
  const seen = new Set<string>();
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index]!;
    const key = rule.key.trim().toLowerCase();
    if (key === '') continue;

    const nameIssue = customIngressHeaderNameIssue(key);
    if (nameIssue !== null) {
      context.addIssue({ code: 'custom', message: nameMessages[nameIssue], path: ['config', 'ingressHeadersRules', index, 'key'] });
    } else if (seen.has(key)) {
      context.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.headers.validation.duplicateName', path: ['config', 'ingressHeadersRules', index, 'key'] });
    } else {
      seen.add(key);
    }

    if (rule.value !== null && !isCustomIngressHeaderValue(rule.value)) {
      context.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.headers.validation.invalidValue', path: ['config', 'ingressHeadersRules', index, 'value'] });
    }
  }
};
