<script setup lang="ts">
import { ClickScrollPlugin, OverlayScrollbars } from 'overlayscrollbars';
import 'overlayscrollbars/overlayscrollbars.css';
import type { HTMLAttributes } from 'vue';
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from 'vue';

import { cn } from './utils/cn.ts';

OverlayScrollbars.plugin(ClickScrollPlugin);

export interface OverlayScrollbarsInitializedEvent {
  instance: OverlayScrollbars;
  root: HTMLDivElement;
  contentWrapper: HTMLDivElement;
}

const props = defineProps<{
  class?: HTMLAttributes['class'];
  style?: HTMLAttributes['style'];
  contentClass?: HTMLAttributes['class'];
  noTabindex?: boolean;
  vScrollbarOffset?: { x?: number; y?: number };
  hScrollbarOffset?: { x?: number; y?: number };
  scrollbarZIndex?: number;
}>();

const emit = defineEmits<{
  initialized: [event: OverlayScrollbarsInitializedEvent];
  destroyed: [];
}>();

const rootRef = useTemplateRef<HTMLDivElement>('rootRef');
const contentWrapperRef = useTemplateRef<HTMLDivElement>('contentWrapperRef');
const osRef = shallowRef<OverlayScrollbars>();
const nativeScrollbarSize = ref(0);

let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;

const measureNativeScrollbars = () => {
  const outer = document.createElement('div');
  outer.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;';
  const inner = document.createElement('div');
  inner.style.cssText = 'width:200px;height:200px;';
  outer.appendChild(inner);
  document.body.appendChild(outer);
  nativeScrollbarSize.value = Math.max(outer.offsetWidth - outer.clientWidth, outer.offsetHeight - outer.clientHeight);
  document.body.removeChild(outer);
};

const shouldUseOverlay = computed(() => nativeScrollbarSize.value > 0);

const update = () => {
  void nextTick(() => osRef.value?.update({ force: true }));
};

const destroy = () => {
  if (!osRef.value) return;
  osRef.value.destroy();
  osRef.value = undefined;
  emit('destroyed');
};

const init = () => {
  if (!shouldUseOverlay.value) {
    destroy();
    return;
  }
  if (!rootRef.value || !contentWrapperRef.value) return;
  if (osRef.value?.elements().viewport === contentWrapperRef.value) return;
  destroy();
  osRef.value = OverlayScrollbars({
    target: rootRef.value,
    elements: {
      viewport: contentWrapperRef.value,
      content: contentWrapperRef.value,
    },
  }, {
    scrollbars: {
      clickScroll: true,
    },
  }, {
    initialized(instance) {
      if (props.noTabindex) instance.elements().viewport.removeAttribute('tabindex');
      emit('initialized', { instance, root: rootRef.value!, contentWrapper: contentWrapperRef.value! });
    },
  });
};

watch(shouldUseOverlay, init);

onMounted(() => {
  measureNativeScrollbars();
  init();
  if (rootRef.value) {
    resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(rootRef.value);
    if (contentWrapperRef.value) resizeObserver.observe(contentWrapperRef.value);
  }
  if (contentWrapperRef.value) {
    mutationObserver = new MutationObserver(update);
    mutationObserver.observe(contentWrapperRef.value, { childList: true, subtree: true, characterData: true });
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
  destroy();
});

const hScrollbarMarginRight = computed(() => `${-(props.hScrollbarOffset?.x ?? 0)}px`);
const hScrollbarMarginBottom = computed(() => `${-(props.hScrollbarOffset?.y ?? 0)}px`);
const vScrollbarMarginRight = computed(() => `${-(props.vScrollbarOffset?.x ?? 0)}px`);
const vScrollbarMarginBottom = computed(() => `${-(props.vScrollbarOffset?.y ?? 0)}px`);
const scrollbarZIndex = computed(() => props.scrollbarZIndex ?? 'unset');

const scrollElement = computed(() => shouldUseOverlay.value ? contentWrapperRef.value : rootRef.value);

defineExpose({
  root: rootRef,
  contentWrapper: contentWrapperRef,
  scrollElement,
  update,
});
</script>

<template>
  <div
    ref="rootRef"
    :class="cn('relative', !shouldUseOverlay && 'overflow-auto', props.class)"
    :style="[{ scrollbarWidth: shouldUseOverlay ? 'none' : 'initial' }, props.style]"
  >
    <div
      ref="contentWrapperRef"
      data-overlayscrollbars-contents=""
      :class="contentClass"
    >
      <slot :os-enabled="shouldUseOverlay" />
    </div>
  </div>
</template>

<style scoped>
[data-overlayscrollbars=host] :deep(.os-scrollbar-horizontal) {
  margin-right: v-bind(hScrollbarMarginRight);
  margin-bottom: v-bind(hScrollbarMarginBottom);
  z-index: v-bind(scrollbarZIndex);
}

[data-overlayscrollbars=host] :deep(.os-scrollbar-vertical) {
  margin-right: v-bind(vScrollbarMarginRight);
  margin-bottom: v-bind(vScrollbarMarginBottom);
  z-index: v-bind(scrollbarZIndex);
}

[data-overlayscrollbars=host] :deep(.os-scrollbar) {
  --os-size: 12px;
  --os-size-inactive: 4px;
}

[data-overlayscrollbars=host] :deep(.os-scrollbar-horizontal:not(:hover) .os-scrollbar-handle) {
  height: var(--os-size-inactive);
}

[data-overlayscrollbars=host] :deep(.os-scrollbar-vertical:not(:hover) .os-scrollbar-handle) {
  width: var(--os-size-inactive);
}

[data-overlayscrollbars=host]:not(:hover) :deep(.os-scrollbar-auto-hide) {
  opacity: 0 !important;
}

[data-overlayscrollbars=host] :deep(.os-scrollbar-handle) {
  background: rgba(148, 163, 184, 0.32);
}

[data-overlayscrollbars=host] :deep(.os-scrollbar-handle:hover) {
  background: rgba(148, 163, 184, 0.5);
}

[data-overlayscrollbars=host] :deep(.os-scrollbar-handle:active) {
  background: rgba(148, 163, 184, 0.7);
}
</style>
