import type { RefinementCtx } from 'zod';

import { customIngressHeaderNameIssue, isCustomIngressHeaderValue } from '@floway-dev/provider-custom/browser';

interface CustomIngressHeaderRuleDraft {
  key: string;
  value: string | null;
}

const nameMessages = {
  invalid: 'upstreams.editor.headers.validation.invalidName',
  'anthropic-messages-owned': 'upstreams.editor.headers.validation.anthropicMessagesOwned',
  'transport-owned': 'upstreams.editor.headers.validation.transportOwned',
} as const;

export const refineCustomIngressHeaderRules = (
  rules: readonly CustomIngressHeaderRuleDraft[],
  context: RefinementCtx,
) => {
  const passthroughKeys = new Set<string>();
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index]!;
    const key = rule.key.trim().toLowerCase();
    if (key === '') continue;

    const nameIssue = customIngressHeaderNameIssue(key);
    if (nameIssue !== null) {
      context.addIssue({ code: 'custom', message: nameMessages[nameIssue], path: ['config', 'ingressHeadersRules', index, 'key'] });
    } else if (rule.value === null) {
      // Several rules may share a name to send several values, but the
      // client's own values enter the request once.
      if (passthroughKeys.has(key)) {
        context.addIssue({ code: 'custom', message: 'upstreams.editor.headers.validation.duplicatePassthrough', path: ['config', 'ingressHeadersRules', index, 'value'] });
      } else {
        passthroughKeys.add(key);
      }
    }

    if (rule.value !== null && !isCustomIngressHeaderValue(rule.value)) {
      context.addIssue({ code: 'custom', message: 'upstreams.editor.headers.validation.invalidValue', path: ['config', 'ingressHeadersRules', index, 'value'] });
    }
  }
};
