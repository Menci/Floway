<script setup lang="ts">
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';

withDefaults(defineProps<{
  content: string;
  delayDuration?: number;
  side?: 'top' | 'right' | 'bottom' | 'left';
}>(), {
  delayDuration: 200,
  side: 'top',
});
</script>

<template>
  <TooltipProvider :delay-duration="delayDuration">
    <TooltipRoot>
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          :side="side"
          :side-offset="6"
          class="z-50 max-w-xs rounded-[10px] bg-surface-800 border border-white/[0.1] px-2.5 py-1.5 text-xs text-white shadow-lg"
        >
          {{ content }}
          <TooltipArrow class="fill-surface-800" :width="10" :height="5" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
