<script setup lang="ts">
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui';

interface Tab {
  value: string;
  label: string;
  disabled?: boolean;
}

const active = defineModel<string>();

defineProps<{
  tabs: Tab[];
}>();
</script>

<template>
  <TabsRoot v-model="active" class="w-full">
    <TabsList class="inline-flex items-center gap-1 rounded-[10px] bg-surface-800 p-1">
      <TabsTrigger
        v-for="tab in tabs"
        :key="tab.value"
        :value="tab.value"
        :disabled="tab.disabled"
        class="rounded-md px-3 py-1.5 text-sm font-medium text-gray-500 transition-colors hover:text-gray-300 data-[state=active]:bg-surface-600 data-[state=active]:text-white disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {{ tab.label }}
      </TabsTrigger>
    </TabsList>
    <TabsContent
      v-for="tab in tabs"
      :key="tab.value"
      :value="tab.value"
      class="mt-4 focus-visible:outline-none"
    >
      <slot :name="tab.value" />
    </TabsContent>
  </TabsRoot>
</template>
