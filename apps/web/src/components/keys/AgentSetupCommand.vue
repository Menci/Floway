<script setup lang="ts">
// A first-class copy button that stays visible while its parent disables it,
// unlike the Code block's hover-only copy affordance.
import { onScopeDispose, shallowRef } from 'vue';

import { Button, Code } from '@floway-dev/ui';

const props = withDefaults(defineProps<{
  label: string;
  command: string;
  language: 'bash' | 'powershell' | 'text';
  disabled?: boolean;
}>(), { disabled: false });

defineSlots<{
  header?: () => unknown;
}>();

type CopyStatus = 'idle' | 'copied' | 'error';
const status = shallowRef<CopyStatus>('idle');
let resetTimer: ReturnType<typeof setTimeout> | null = null;

const flash = (next: Exclude<CopyStatus, 'idle'>) => {
  status.value = next;
  if (resetTimer !== null) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => { status.value = 'idle'; resetTimer = null; }, 2000);
};

// Re-check the gate at click time: a disabled DOM button already swallows the
// click, but a programmatic dispatch must not slip a clipboard write past a lease
// that went stale between render and click.
const copy = async () => {
  if (props.disabled) return;
  try {
    await navigator.clipboard.writeText(props.command);
    flash('copied');
  } catch (error) {
    console.error('[agent-setup] clipboard write failed', error);
    flash('error');
  }
};

onScopeDispose(() => { if (resetTimer !== null) clearTimeout(resetTimer); });
</script>

<template>
  <div>
    <div class="mb-2 flex items-center justify-between gap-2">
      <slot name="header">
        <span class="text-xs font-medium text-gray-400">{{ label }}</span>
      </slot>
      <div class="flex items-center gap-2">
        <span
          role="status"
          aria-live="polite"
          class="text-xs"
          :class="status === 'error' ? 'text-accent-rose' : 'text-accent-emerald'"
        >{{ status === 'copied' ? 'Copied' : status === 'error' ? 'Copy failed' : '' }}</span>
        <Button
          variant="secondary"
          size="sm"
          :aria-label="`Copy ${label} command`"
          :disabled="disabled"
          @click="copy"
        >
          <i :class="status === 'copied' ? 'i-lucide-check' : 'i-lucide-clipboard'" class="size-3.5" />
          Copy
        </Button>
      </div>
    </div>
    <Code :code="command" :language="language" :copyable="false" />
  </div>
</template>
