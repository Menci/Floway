<script setup lang="ts">
import Prism from 'prismjs';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-toml.js';
import { computed, ref } from 'vue';

import OverlayScrollbars from './OverlayScrollbars.vue';

const props = withDefaults(defineProps<{
  code: string;
  language?: 'bash' | 'toml' | 'json' | 'text';
  copyable?: boolean;
}>(), {
  copyable: true,
  language: 'text',
});

const copied = ref(false);

const copy = async () => {
  await navigator.clipboard.writeText(props.code);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
};

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const highlighted = computed(() => {
  const grammar = Prism.languages[props.language];
  return grammar ? Prism.highlight(props.code, grammar, props.language) : escapeHtml(props.code);
});
</script>

<template>
  <div class="code-block relative group">
    <OverlayScrollbars class="rounded-xl border border-white/[0.04] bg-surface-900" no-tabindex>
      <pre class="min-w-max p-4 pr-11 text-[11px] font-mono leading-[1.6] text-gray-200"><code :class="`language-${language}`" v-html="highlighted" /></pre>
    </OverlayScrollbars>
    <button
      v-if="copyable"
      type="button"
      class="absolute right-2.5 top-2.5 inline-flex size-7 items-center justify-center rounded-md bg-surface-700/80 text-gray-500 opacity-100 transition-all hover:bg-surface-600 hover:text-accent-cyan focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
      @click="copy"
    >
      <i :class="copied ? 'i-lucide-check text-accent-emerald' : 'i-lucide-clipboard'" class="size-3.5" />
      <span class="sr-only">{{ copied ? 'Copied' : 'Copy' }}</span>
    </button>
  </div>
</template>

<style scoped>
.code-block :deep(code[class*='language-']),
.code-block :deep(pre[class*='language-']) {
  background: transparent;
  text-shadow: none;
  font-family: 'JetBrains Mono', monospace;
}

.code-block :deep(.token.table) {
  display: inline;
}

.code-block :deep(.token.table .punctuation) {
  display: inline;
}

.code-block :deep(.token.comment),
.code-block :deep(.token.prolog),
.code-block :deep(.token.doctype),
.code-block :deep(.token.cdata) {
  color: #8b949e;
}

.code-block :deep(.token.punctuation) {
  color: #c9d1d9;
}

.code-block :deep(.token.property),
.code-block :deep(.token.tag),
.code-block :deep(.token.boolean),
.code-block :deep(.token.number),
.code-block :deep(.token.constant),
.code-block :deep(.token.symbol) {
  color: #79c0ff;
}

.code-block :deep(.token.selector),
.code-block :deep(.token.attr-name),
.code-block :deep(.token.string),
.code-block :deep(.token.char),
.code-block :deep(.token.builtin) {
  color: #a5d6ff;
}

.code-block :deep(.token.operator),
.code-block :deep(.token.entity),
.code-block :deep(.token.url) {
  color: #c9d1d9;
}

.code-block :deep(.token.atrule),
.code-block :deep(.token.attr-value),
.code-block :deep(.token.keyword) {
  color: #ff7b72;
}

.code-block :deep(.token.function),
.code-block :deep(.token.class-name) {
  color: #d2a8ff;
}

.code-block :deep(.token.regex),
.code-block :deep(.token.important),
.code-block :deep(.token.variable) {
  color: #ffa657;
}

.code-block :deep(.token.assign-left) {
  color: #c9d1d9;
}
</style>
