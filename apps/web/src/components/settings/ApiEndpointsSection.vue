<script setup lang="ts">
// Read-only reference card listing every public endpoint the gateway exposes.
// The list is static — the URLs don't change per upstream, so there's no
// fetch backing this. Keep in sync with `mountChatRoutes` /
// `mountDataPlane` in `@floway-dev/gateway`.

import { Card } from '@floway-dev/ui';

interface EndpointRow {
  method: 'GET' | 'POST';
  path: string;
  name: string;
  docs: string;
}

const endpoints: EndpointRow[] = [
  { method: 'POST', path: '/v1/messages', name: 'Anthropic Messages', docs: 'https://docs.anthropic.com/en/api/messages' },
  { method: 'POST', path: '/v1/messages/count_tokens', name: 'Anthropic Count Tokens', docs: 'https://docs.anthropic.com/en/api/messages-count-tokens' },
  { method: 'POST', path: '/v1/responses', name: 'OpenAI Responses', docs: 'https://platform.openai.com/docs/api-reference/responses/create' },
  { method: 'POST', path: '/v1/responses/compact', name: 'OpenAI Responses Compact', docs: 'https://platform.openai.com/docs/api-reference/responses/compact' },
  { method: 'GET', path: '/v1/responses', name: 'OpenAI Responses (WebSocket)', docs: 'https://developers.openai.com/api/docs/guides/websocket-mode' },
  { method: 'POST', path: '/v1/chat/completions', name: 'OpenAI Chat Completions', docs: 'https://platform.openai.com/docs/api-reference/chat/create' },
  { method: 'POST', path: '/v1/embeddings', name: 'OpenAI Embeddings', docs: 'https://platform.openai.com/docs/api-reference/embeddings/create' },
  { method: 'POST', path: '/v1/images/generations', name: 'OpenAI Image Generations', docs: 'https://platform.openai.com/docs/api-reference/images/create' },
  { method: 'POST', path: '/v1/images/edits', name: 'OpenAI Image Edits', docs: 'https://platform.openai.com/docs/api-reference/images/createEdit' },
  { method: 'POST', path: '/v1/rerank', name: 'Cohere Rerank v1', docs: 'https://docs.cohere.com/reference/rerank' },
  { method: 'POST', path: '/v2/rerank', name: 'Cohere Rerank v2', docs: 'https://docs.cohere.com/v2/reference/rerank' },
  { method: 'POST', path: '/jina/v1/rerank', name: 'Jina Rerank', docs: 'https://api.jina.ai/openapi.json' },
  { method: 'POST', path: '/voyage/v1/rerank', name: 'Voyage Rerank', docs: 'https://docs.voyageai.com/reference/reranker-api' },
  { method: 'GET', path: '/v1/models', name: 'OpenAI Models', docs: 'https://platform.openai.com/docs/api-reference/models/list' },
  { method: 'POST', path: '/v1beta/models/{model}:{action}', name: 'Google Gemini', docs: 'https://ai.google.dev/api/generate-content' },
];
</script>

<template>
  <Card :padded="false" class="glass-card p-5 sm:p-6 animate-in delay-1">
    <h3 class="mb-4 font-semibold text-white">API Endpoints</h3>
    <div class="min-w-0">
      <div
        v-for="ep in endpoints"
        :key="`${ep.method} ${ep.path}`"
        class="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-white/[0.04] py-2 last:border-b-0"
      >
        <span
          class="shrink-0 rounded px-2 py-0.5 font-mono text-[10px] font-bold"
          :class="ep.method === 'GET' ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-accent-emerald/10 text-accent-emerald'"
        >{{ ep.method }}</span>
        <code class="min-w-0 max-w-[48%] truncate font-mono text-xs font-semibold text-gray-300 sm:max-w-[220px]">{{ ep.path }}</code>
        <span class="min-w-0 flex-1 truncate text-xs font-medium text-gray-500">{{ ep.name }}</span>
        <a
          :href="ep.docs"
          target="_blank"
          rel="noreferrer"
          class="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-bold text-accent-cyan hover:underline"
        >
          Docs
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M7 17 17 7" />
            <path d="M7 7h10v10" />
          </svg>
        </a>
      </div>
    </div>
  </Card>
</template>
