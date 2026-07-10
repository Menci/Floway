<script setup lang="ts">
// One copyable setup command (shell or PowerShell). The command body carries the
// user's long-lived API key indirectly through a five-minute setup link, so the
// copy affordance stays a first-class, persistent button rather than the Code
// block's hover-only one — it must remain visible while disabled so the card can
// gate it during a draft sync, an expired lease, or a superseded session.
import { onScopeDispose, ref } from 'vue';

import { Button, Code } from '@floway-dev/ui';

const props = withDefaults(defineProps<{
  label: string;
  command: string;
  language?: 'bash' | 'text';
  disabled?: boolean;
}>(), { language: 'bash', disabled: false });

type CopyStatus = 'idle' | 'copied' | 'error';
const status = ref<CopyStatus>('idle');
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
      <span class="text-xs font-medium text-gray-400">{{ label }}</span>
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
          aria-label="Copy command"
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
