import { defineStage } from './fact-space.ts';
import { transform } from '@floway-dev/pipeline';

export const filterAzureHeaders = defineStage({
  name: 'azure.filter-headers',
  through: {
    request: { needs: ['http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => ({ ...facts, http: { ...facts.http, headers: [] } }),
  })),
});
