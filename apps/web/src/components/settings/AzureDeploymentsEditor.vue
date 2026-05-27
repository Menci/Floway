<script setup lang="ts">
import { Badge, Card, Input, Select, Switch } from '@floway-dev/ui';
import { reactive } from 'vue';

import type { AzureDeployment, FlagDef } from '../../api/types.ts';
import FlagOverridesEditor from './FlagOverridesEditor.vue';

type EditableDeployment = AzureDeployment & { __uiId?: string };

const deployments = defineModel<EditableDeployment[]>({ required: true });

const props = defineProps<{
  flags: FlagDef[];
  upstreamFlagOverrides: Record<string, boolean>;
}>();

type ApiType = 'chat_completions' | 'responses' | 'responses_chat' | 'messages' | 'embeddings' | 'images' | 'custom';

const API_TYPE_ENDPOINTS: Record<Exclude<ApiType, 'custom'>, string[]> = {
  chat_completions: ['/chat/completions'],
  responses: ['/responses'],
  responses_chat: ['/responses', '/chat/completions'],
  messages: ['/v1/messages'],
  embeddings: ['/embeddings'],
  images: ['/v1/images/generations', '/v1/images/edits'],
};

const apiTypeOptions: { value: ApiType; label: string }[] = [
  { value: 'chat_completions', label: 'Chat' },
  { value: 'responses', label: 'Responses' },
  { value: 'responses_chat', label: 'Responses + Chat' },
  { value: 'messages', label: 'Messages' },
  { value: 'embeddings', label: 'Embeddings' },
  { value: 'images', label: 'Images' },
  { value: 'custom', label: 'Custom' },
];

const apiTypeFromEndpoints = (endpoints: string[] | undefined): ApiType => {
  const set = new Set(endpoints ?? []);
  if (set.has('/v1/messages') || set.has('/messages')) return 'messages';
  if (set.has('/embeddings') || set.has('/v1/embeddings')) return 'embeddings';
  if (set.has('/v1/images/generations') || set.has('/images/generations') || set.has('/v1/images/edits') || set.has('/images/edits')) return 'images';
  const hasResponses = set.has('/responses') || set.has('/v1/responses');
  const hasChat = set.has('/chat/completions') || set.has('/v1/chat/completions');
  if (hasResponses && hasChat) return 'responses_chat';
  if (hasChat) return 'chat_completions';
  if (hasResponses) return 'responses';
  return 'custom';
};

let nextUiId = 0;
const uiIdFor = (d: EditableDeployment): string => {
  // Lazy-tag the deployment so every row gets a stable client-side id without
  // round-tripping through Vue Proxy identity. Object.assign-based edits
  // preserve the property, so re-renders never lose the row's open state.
  if (!d.__uiId) d.__uiId = `d${++nextUiId}`;
  return d.__uiId;
};

const expanded = reactive<Record<string, boolean>>({});
const isExpanded = (d: EditableDeployment, index: number) => {
  const id = uiIdFor(d);
  if (!(id in expanded)) expanded[id] = index === 0 || !d.deployment.trim();
  return expanded[id];
};
const toggleExpanded = (d: EditableDeployment) => {
  const id = uiIdFor(d);
  expanded[id] = !expanded[id];
};

// All field edits mutate the existing object in place via Object.assign,
// keeping the reference (and the __uiId on it) stable. The v-for key based on
// __uiId therefore doesn't churn, so the open/closed state and focused input
// survive every keystroke.
const updateAt = (i: number, patch: Partial<AzureDeployment>) => {
  const target = deployments.value[i];
  if (!target) return;
  Object.assign(target, patch);
  for (const key of Object.keys(patch) as (keyof AzureDeployment)[]) {
    if (patch[key] === undefined) delete (target as unknown as Record<string, unknown>)[key];
  }
};

const setApiType = (i: number, t: ApiType) => {
  if (t === 'custom') return;
  updateAt(i, { supportedEndpoints: [...API_TYPE_ENDPOINTS[t]] });
};

const toggleEndpoint = (i: number, endpoint: string, on: boolean) => {
  const set = new Set(deployments.value[i]?.supportedEndpoints ?? []);
  if (on) set.add(endpoint); else set.delete(endpoint);
  updateAt(i, { supportedEndpoints: Array.from(set) });
};

const updateLimit = (i: number, key: 'max_context_window_tokens' | 'max_prompt_tokens' | 'max_output_tokens', value: string) => {
  const limits = { ...(deployments.value[i]?.limits ?? {}) };
  const num = value === '' ? undefined : Number(value);
  if (num === undefined || !Number.isFinite(num)) delete limits[key]; else limits[key] = num;
  updateAt(i, { limits: Object.keys(limits).length > 0 ? limits : undefined });
};

const updateCost = (i: number, key: 'input' | 'output' | 'cache_read' | 'cache_write', value: string) => {
  const cost = { ...(deployments.value[i]?.cost ?? {} as Partial<AzureDeployment['cost']> & object) };
  const num = value === '' ? undefined : Number(value);
  if (num === undefined || !Number.isFinite(num)) delete (cost as Record<string, unknown>)[key];
  else (cost as Record<string, unknown>)[key] = num;
  // cost must include input + output for the server's pricingField check; if
  // both are missing we drop the whole object so the row stores `cost:
  // undefined` rather than a half-filled stub that fails validation.
  const hasAny = ['input', 'output', 'cache_read', 'cache_write'].some(k => (cost as Record<string, unknown>)[k] !== undefined);
  updateAt(i, { cost: hasAny ? (cost as AzureDeployment['cost']) : undefined });
};

const toggleFlagOverridesEnabled = (i: number) => {
  const current = deployments.value[i]?.flagOverrides;
  if (current?.enabled) {
    updateAt(i, { flagOverrides: undefined });
  } else {
    updateAt(i, { flagOverrides: { enabled: true, values: { ...(current?.values ?? {}) } } });
  }
};

const addDeployment = () => {
  // The baseline defaults a fresh deployment to OpenAI Responses; matching that
  // here keeps the UI consistent with operators' muscle memory.
  const fresh: EditableDeployment = {
    deployment: '',
    supportedEndpoints: ['/responses'],
    __uiId: `d${++nextUiId}`,
  };
  expanded[fresh.__uiId!] = true;
  deployments.value = [...deployments.value, fresh];
};

defineExpose({ addDeployment });

const removeAt = (i: number) => {
  const target = deployments.value[i];
  if (target?.__uiId) delete expanded[target.__uiId];
  deployments.value = deployments.value.filter((_, idx) => idx !== i);
};

const customSelectableEndpoints = [
  '/chat/completions',
  '/responses',
  '/v1/messages',
  '/embeddings',
  '/v1/images/generations',
  '/v1/images/edits',
];

const titleFor = (d: AzureDeployment) => d.display_name?.trim() || d.deployment?.trim() || 'Untitled model';

const showOnlyCustomEndpointsPanel = (i: number) => apiTypeFromEndpoints(deployments.value[i]?.supportedEndpoints) === 'custom';

const apiTypeFor = (i: number): ApiType => apiTypeFromEndpoints(deployments.value[i]?.supportedEndpoints);
</script>

<template>
  <div class="space-y-2">
    <Card v-for="(deployment, i) in deployments" :key="uiIdFor(deployment)" :padded="false" class="overflow-hidden">
      <header class="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
          :aria-expanded="!!isExpanded(deployment, i)"
          @click="toggleExpanded(deployment)"
        >
          <span class="flex min-w-0 items-center gap-2">
            <span class="truncate text-sm font-medium text-white">{{ titleFor(deployment) }}</span>
            <Badge v-if="deployment.flagOverrides?.enabled" tone="cyan" size="sm">flags</Badge>
          </span>
          <svg
            class="size-4 shrink-0 text-gray-400 transition-transform"
            :class="isExpanded(deployment, i) && 'rotate-180'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          class="grid size-7 shrink-0 place-items-center rounded text-gray-500 hover:bg-surface-700 hover:text-accent-rose"
          aria-label="Remove deployment"
          @click="removeAt(i)"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </header>

      <div v-if="isExpanded(deployment, i)" class="space-y-4 border-t border-white/[0.06] p-3">
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label class="block space-y-1.5">
            <span class="block text-xs font-medium text-gray-500">Display Name</span>
            <Input :model-value="deployment.display_name" placeholder="e.g. GPT 5.4 Pro" size="sm" @update:model-value="v => updateAt(i, { display_name: v || undefined })" />
          </label>
          <label class="block space-y-1.5">
            <span class="block text-xs font-medium text-gray-500">Deployment</span>
            <Input :model-value="deployment.deployment" placeholder="e.g. gpt-5.4-pro" size="sm" class="font-mono" @update:model-value="v => updateAt(i, { deployment: v })" />
          </label>
          <label class="block space-y-1.5">
            <span class="block text-xs font-medium text-gray-500">Public Model ID</span>
            <Input :model-value="deployment.publicModelId" :placeholder="deployment.deployment || ''" size="sm" class="font-mono" @update:model-value="v => updateAt(i, { publicModelId: v || undefined })" />
          </label>
          <label class="block space-y-1.5">
            <span class="block text-xs font-medium text-gray-500">API Type</span>
            <Select :model-value="apiTypeFor(i)" :options="apiTypeOptions" size="sm" @update:model-value="t => setApiType(i, t as ApiType)" />
          </label>
        </div>

        <div v-if="showOnlyCustomEndpointsPanel(i)" class="space-y-1.5">
          <span class="block text-xs font-medium text-gray-500">Supported Endpoints</span>
          <div class="flex flex-wrap gap-2">
            <label v-for="ep in customSelectableEndpoints" :key="ep" class="inline-flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-surface-800/40 px-2 py-1 text-xs text-gray-200">
              <input type="checkbox" :checked="deployment.supportedEndpoints?.includes(ep)" @change="(e: Event) => toggleEndpoint(i, ep, (e.target as HTMLInputElement).checked)">
              <code>{{ ep }}</code>
            </label>
          </div>
        </div>

        <div class="space-y-1.5">
          <p class="text-xs font-semibold text-gray-400">Context Limits</p>
          <div class="grid gap-3 sm:grid-cols-3">
            <label class="block space-y-1">
              <span class="block text-[11px] font-medium text-gray-500">Context Window</span>
              <Input type="number" :model-value="deployment.limits?.max_context_window_tokens" placeholder="e.g. 1050000" size="sm" class="font-mono" @update:model-value="v => updateLimit(i, 'max_context_window_tokens', String(v))" />
            </label>
            <label class="block space-y-1">
              <span class="block text-[11px] font-medium text-gray-500">Prompt Tokens</span>
              <Input type="number" :model-value="deployment.limits?.max_prompt_tokens" placeholder="e.g. 922000" size="sm" class="font-mono" @update:model-value="v => updateLimit(i, 'max_prompt_tokens', String(v))" />
            </label>
            <label class="block space-y-1">
              <span class="block text-[11px] font-medium text-gray-500">Output Tokens</span>
              <Input type="number" :model-value="deployment.limits?.max_output_tokens" placeholder="e.g. 128000" size="sm" class="font-mono" @update:model-value="v => updateLimit(i, 'max_output_tokens', String(v))" />
            </label>
          </div>
        </div>

        <div class="space-y-1.5">
          <p class="text-xs font-semibold text-gray-400">Pricing</p>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label class="block space-y-1">
              <span class="block text-[11px] font-medium text-gray-500">Input ($/MTok)</span>
              <Input type="number" :model-value="deployment.cost?.input" placeholder="e.g. 2.5" size="sm" class="font-mono" @update:model-value="v => updateCost(i, 'input', String(v))" />
            </label>
            <label class="block space-y-1">
              <span class="block text-[11px] font-medium text-gray-500">Output ($/MTok)</span>
              <Input type="number" :model-value="deployment.cost?.output" placeholder="e.g. 15" size="sm" class="font-mono" @update:model-value="v => updateCost(i, 'output', String(v))" />
            </label>
            <label class="block space-y-1">
              <span class="block text-[11px] font-medium text-gray-500">Cache Read ($/MTok)</span>
              <Input type="number" :model-value="deployment.cost?.cache_read" placeholder="e.g. 0.25" size="sm" class="font-mono" @update:model-value="v => updateCost(i, 'cache_read', String(v))" />
            </label>
            <label class="block space-y-1">
              <span class="block text-[11px] font-medium text-gray-500">Cache Write ($/MTok)</span>
              <Input type="number" :model-value="deployment.cost?.cache_write" placeholder="leave blank if not charged" size="sm" class="font-mono" @update:model-value="v => updateCost(i, 'cache_write', String(v))" />
            </label>
          </div>
          <p class="text-[11px] leading-relaxed text-gray-500">
            Per-million-token USD rates. Leave all four blank to omit pricing. <span class="text-gray-400">Input</span> and <span class="text-gray-400">Output</span> must both be filled or both blank; <span class="text-gray-400">Cache Read</span> / <span class="text-gray-400">Cache Write</span> are independently optional.
          </p>
        </div>

        <div>
          <div class="mb-2 flex items-center justify-between">
            <p class="text-xs font-semibold text-gray-400">
              Override Feature Flags
              <span
                v-if="deployment.flagOverrides?.enabled && Object.keys(deployment.flagOverrides?.values ?? {}).length > 0"
                class="ml-1.5 font-mono text-[10px] font-medium text-accent-cyan"
              >(+{{ Object.keys(deployment.flagOverrides?.values ?? {}).length }})</span>
            </p>
            <Switch :model-value="deployment.flagOverrides?.enabled === true" @update:model-value="() => toggleFlagOverridesEnabled(i)" />
          </div>

          <div v-if="deployment.flagOverrides?.enabled">
            <FlagOverridesEditor
              :model-value="deployment.flagOverrides?.values ?? {}"
              :flags="flags"
              provider-kind="azure"
              :inherited-overrides="upstreamFlagOverrides"
              :name-prefix="`dep-${i}-flag`"
              class="max-h-56"
              @update:model-value="values => updateAt(i, { flagOverrides: { enabled: true, values } })"
            />
          </div>
        </div>
      </div>
    </Card>
  </div>
</template>
