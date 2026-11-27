import { defineStage } from './fact-space.ts';
import { filterHeaders } from '@floway-dev/http';
import { transform } from '@floway-dev/pipeline';

// https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-router-reference
export const filterAzureAnthropicHeaders = defineStage({
  name: 'azure.filter-anthropic-headers',
  through: {
    request: { needs: ['http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => ({ ...facts, http: { ...facts.http, headers: filterHeaders(facts.http.headers, name => name === 'anthropic-beta') } }),
  })),
});
