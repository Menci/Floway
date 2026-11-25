import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';

// Copilot rejects service_tier in the body. Raw model selection carries the serving lane.
// https://github.com/caozhiyuan/copilot-api/commit/f7835a44f06976cab874700e4d94a5f5c0379369
export const stripServiceTier = defineCopilotStage({
  name: 'copilot.openaiResponses.stripServiceTier',
  through: {
    request: { needs: ['request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiResponses'];
      const { service_tier: _tier, ...next } = payload;
      return { ...facts, 'request.openaiResponses': move(next) };
    },
  })),
});
