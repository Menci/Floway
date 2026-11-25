import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { deleteHeader, getHeaders, setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';
import { parseAnthropicBetaHeader } from '@floway-dev/protocols/anthropic-messages';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.anthropicMessages';

// Subscription billing requires the Claude Code attribution. On ordinary API
// credentials it prevents cache reuse and can disqualify subscriber API credits.
// https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers#what-the-credits-cover
// https://github.com/decolua/9router/issues/4739
const claudeCodeBeta = 'claude-code-20250219';

const stripText = (text: string): string => text.replace(/x-anthropic-billing-header[^\n]*/g, '').replace(/cch=[0-9a-f]{5,};?/gi, '').trim();

export const stripBillingAttribution = defineStage({
  name: 'anthropicMessages.strip-billing-attribution',
  through: {
    request: { needs: [key, 'request.http', 'serve.candidate'], provides: [key, 'request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      if (!facts['serve.candidate'].model.enabledFlags.includes('strip-billing-attribution')) return facts;
      const request = facts['request.http'];
      const betaHeaders = getHeaders(request.headers, 'anthropic-beta');
      const beta = betaHeaders.flatMap(value => parseAnthropicBetaHeader(typeof value === 'string' ? value : value.reveal()));
      const retained = beta.filter(flag => flag !== claudeCodeBeta);
      const next = beta.length === retained.length ? request : {
        ...request,
        headers: retained.length === 0
          ? deleteHeader(request.headers, 'anthropic-beta')
          : setHeader(request.headers, 'anthropic-beta', retained.join(',')),
      };

      const { system: source, ...payload } = facts[key];
      const system = typeof source === 'string' ? stripText(source) : Array.isArray(source)
        ? source.map(block => ({ ...block, text: stripText(block.text) })).filter(block => block.text.length > 0)
        : source;
      const shaped = typeof source === 'string' || Array.isArray(source)
        ? move({ ...payload, ...(system?.length ? { system } : {}) })
        : facts[key];
      return {
        ...facts,
        [key]: shaped,
        'request.http': next === request ? request : move(next),
      };
    },
  })),
});
