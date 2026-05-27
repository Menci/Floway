<script setup lang="ts">
import { Chart, type ChartConfiguration } from 'chart.js/auto';
import 'chartjs-adapter-dayjs-4';
import { onMounted, onUnmounted, useTemplateRef, watch } from 'vue';

// Generic wrapper around Chart.js. The config is reactive — the watcher
// rebinds data/options on every change. Destroyed on unmount so route
// transitions don't leak canvases.
const props = defineProps<{
  config: ChartConfiguration;
}>();

const canvasRef = useTemplateRef<HTMLCanvasElement>('canvasRef');
let chart: Chart | null = null;

onMounted(() => {
  if (!canvasRef.value) return;
  chart = new Chart(canvasRef.value, props.config);
});

watch(() => props.config, next => {
  if (!chart) return;
  chart.data = next.data;
  chart.options = next.options ?? {};
  chart.update('none');
}, { deep: true });

onUnmounted(() => { chart?.destroy(); chart = null; });
</script>

<template>
  <div class="relative h-full w-full">
    <canvas ref="canvasRef" />
  </div>
</template>
