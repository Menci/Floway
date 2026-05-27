<script setup lang="ts">
import { Button, Input } from '@floway-dev/ui';
import Prism from 'prismjs';
import 'prismjs/components/prism-json.js';
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue';

import type { AzureDeployment, FlagDef } from '../../api/types.ts';

import AzureDeploymentsEditor from './AzureDeploymentsEditor.vue';

// Deployment-array state lives in the draft so the parent dialog can read it
// straight through to the PATCH/POST body. The JSON textarea is a power-user
// affordance: switching to JSON mode serializes the current array; switching
// back parses it (and refuses to leave JSON mode on a parse error so the user
// doesn't silently lose their work).
interface AzureDraft {
  endpoint: string;
  apiKey: string;
  deployments: AzureDeployment[];
}

const draft = defineModel<AzureDraft>({ required: true });

const props = defineProps<{
  apiKeySet: boolean;
  flags: FlagDef[];
  upstreamFlagOverrides: Record<string, boolean>;
  // In create mode the baseline ships with one default-expanded "Untitled model"
  // card so the user has somewhere to type into immediately.
  seedDefault?: boolean;
}>();

const editorRef = ref<InstanceType<typeof AzureDeploymentsEditor> | null>(null);
const mode = ref<'ui' | 'json'>('ui');
const jsonText = ref('');
const jsonError = ref<string | null>(null);
const jsonHighlightRef = useTemplateRef<HTMLPreElement>('jsonHighlightRef');

const blankDeployment = (): AzureDeployment => ({ deployment: '', supportedEndpoints: ['/responses'] });

const initialiseJson = () => {
  const sanitised = draft.value.deployments
    .filter(d => d.deployment.trim())
    .map(d => {
      const clone: AzureDeployment & { __uiId?: string } = { ...d };
      delete clone.__uiId;
      return clone;
    });
  jsonText.value = JSON.stringify(sanitised, null, 2);
  jsonError.value = null;
};

const switchMode = (next: 'ui' | 'json') => {
  if (mode.value === next) return;
  if (next === 'json') {
    initialiseJson();
    mode.value = 'json';
    return;
  }
  try {
    const parsed = JSON.parse(jsonText.value);
    if (!Array.isArray(parsed)) throw new Error('deployments JSON must be an array');
    draft.value = { ...draft.value, deployments: parsed.length > 0 ? parsed as AzureDeployment[] : [blankDeployment()] };
    jsonError.value = null;
    mode.value = 'ui';
  } catch (e) {
    jsonError.value = `Cannot leave JSON mode: ${e instanceof Error ? e.message : String(e)}`;
  }
};

watch(() => draft.value.deployments, list => {
  if (mode.value !== 'ui') return;
  const sanitised = list.map(d => {
    const clone: AzureDeployment & { __uiId?: string } = { ...d };
    delete clone.__uiId;
    return clone;
  });
  jsonText.value = JSON.stringify(sanitised, null, 2);
}, { deep: true });

const onJsonInput = (text: string) => {
  jsonText.value = text;
  jsonError.value = null;
};

const isJsonMode = computed(() => mode.value === 'json');

const addFromButton = () => editorRef.value?.addDeployment();

const highlightedJson = computed(() => Prism.highlight(jsonText.value, Prism.languages.json!, 'json'));

const syncJsonScroll = (event: Event) => {
  const target = event.target as HTMLTextAreaElement | null;
  const highlight = jsonHighlightRef.value;
  if (!target || !highlight) return;
  highlight.scrollTop = target.scrollTop;
  highlight.scrollLeft = target.scrollLeft;
};

onMounted(() => {
  // Seed one default deployment so create mode opens with a visible, expanded
  // card to type into — matches the baseline.
  if (props.seedDefault && draft.value.deployments.length === 0) {
    draft.value = { ...draft.value, deployments: [blankDeployment()] };
  }
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Endpoint</label>
        <Input
          :model-value="draft.endpoint"
          placeholder="e.g. https://resource.openai.azure.com/openai/v1"
          class="font-mono"
          @update:model-value="v => draft = { ...draft, endpoint: v }"
        />
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">
          {{ apiKeySet ? 'API Key (leave blank to keep)' : 'API Key' }}
        </label>
        <Input
          type="password"
          autocomplete="off"
          :model-value="draft.apiKey"
          :placeholder="apiKeySet ? '••••••••' : 'xxxxx'"
          class="font-mono"
          @update:model-value="v => draft = { ...draft, apiKey: v }"
        />
      </div>
    </div>

    <div>
      <div class="mb-2 flex items-center justify-between gap-3">
        <p class="text-xs font-medium text-gray-500">Deployments</p>
        <div v-if="!isJsonMode" class="flex items-center gap-2">
          <Button variant="secondary" size="sm" @click="addFromButton">Add Deployment</Button>
          <Button variant="secondary" size="sm" @click="switchMode('json')">Edit as JSON</Button>
        </div>
        <Button v-else variant="secondary" size="sm" @click="switchMode('ui')">Edit with UI</Button>
      </div>

      <AzureDeploymentsEditor
        v-if="!isJsonMode"
        ref="editorRef"
        v-model="draft.deployments"
        :flags="flags"
        :upstream-flag-overrides="upstreamFlagOverrides"
      />

      <div v-else class="rounded-lg border border-white/10 bg-surface-900/70">
        <div class="json-editor relative h-72 overflow-hidden rounded-lg">
          <pre
            ref="jsonHighlightRef"
            aria-hidden="true"
            class="absolute inset-0 m-0 overflow-auto whitespace-pre p-3 text-[11px] font-mono leading-[1.6]"
          ><code class="language-json" v-html="highlightedJson" /></pre>
          <textarea
            :value="jsonText"
            spellcheck="false"
            wrap="off"
            aria-label="Azure deployments JSON"
            class="absolute inset-0 !m-0 h-full w-full resize-none overflow-auto rounded-lg border-0 bg-transparent p-3 text-[11px] font-mono leading-[1.6] text-transparent caret-gray-100 outline-none selection:bg-accent-cyan/25 focus:border-0 focus:ring-0"
            style="color: transparent; -webkit-text-fill-color: transparent; caret-color: #e0e0e0;"
            @input="onJsonInput(($event.target as HTMLTextAreaElement).value)"
            @scroll="syncJsonScroll"
          />
        </div>
        <p v-if="jsonError" class="border-t border-accent-rose/20 px-3 py-2 text-xs text-accent-rose">{{ jsonError }}</p>
        <p class="border-t border-white/[0.06] px-3 py-2 text-xs text-gray-500">Edit the raw deployments array. Switch back to UI to validate the JSON.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.json-editor :deep(code[class*='language-']),
.json-editor :deep(pre[class*='language-']) {
  background: transparent;
  text-shadow: none;
  font-family: 'JetBrains Mono', monospace;
}

.json-editor :deep(.token.comment),
.json-editor :deep(.token.prolog),
.json-editor :deep(.token.doctype),
.json-editor :deep(.token.cdata) {
  color: #8b949e;
}

.json-editor :deep(.token.punctuation),
.json-editor :deep(.token.operator) {
  color: #c9d1d9;
}

.json-editor :deep(.token.property),
.json-editor :deep(.token.tag),
.json-editor :deep(.token.boolean),
.json-editor :deep(.token.number),
.json-editor :deep(.token.constant),
.json-editor :deep(.token.symbol) {
  color: #79c0ff;
}

.json-editor :deep(.token.selector),
.json-editor :deep(.token.attr-name),
.json-editor :deep(.token.string),
.json-editor :deep(.token.char),
.json-editor :deep(.token.builtin) {
  color: #a5d6ff;
}

.json-editor :deep(.token.atrule),
.json-editor :deep(.token.attr-value),
.json-editor :deep(.token.keyword) {
  color: #ff7b72;
}

.json-editor :deep(.token.function),
.json-editor :deep(.token.class-name) {
  color: #d2a8ff;
}

.json-editor :deep(.token.regex),
.json-editor :deep(.token.important),
.json-editor :deep(.token.variable) {
  color: #ffa657;
}
</style>
