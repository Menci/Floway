<script setup lang="ts" generic="T">
import { useSortable } from '@vueuse/integrations/useSortable';
import { useTemplateRef } from 'vue';

// Generic SortableJS wrapper. `items` is v-modeled; useSortable mutates the
// array in place when a drop completes, then the consumer's @end handler
// fires so callers can persist the new order.
//
// `handle` is a CSS selector for the drag handle inside each item — keeping
// the handle separate from the item content lets buttons/inputs inside the
// item stay clickable without triggering a drag.
const items = defineModel<T[]>({ required: true });

const props = withDefaults(defineProps<{
  itemKey: (item: T) => string | number;
  handle?: string;
  disabled?: boolean;
  tag?: string;
  animation?: number;
}>(), {
  tag: 'div',
  animation: 200,
});

const emit = defineEmits<{
  end: [oldIndex: number, newIndex: number];
}>();

const listEl = useTemplateRef<HTMLElement>('listEl');

useSortable(listEl, items, {
  animation: props.animation,
  handle: props.handle,
  disabled: props.disabled,
  ghostClass: 'opacity-50',
  chosenClass: 'cursor-grabbing',
  onEnd: e => {
    if (typeof e.oldIndex === 'number' && typeof e.newIndex === 'number' && e.oldIndex !== e.newIndex) {
      emit('end', e.oldIndex, e.newIndex);
    }
  },
});
</script>

<template>
  <component :is="tag" ref="listEl">
    <slot v-for="(item, index) in items" :key="itemKey(item)" :item="item" :index="index" />
  </component>
</template>
