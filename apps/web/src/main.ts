import '@unocss/reset/tailwind.css';
import 'virtual:uno.css';
import 'nprogress/nprogress.css';
import './styles/index.css';

import { createPinia } from 'pinia';
import { DataLoaderPlugin } from 'unplugin-vue-router/data-loaders';
import { createApp } from 'vue';

import App from './App.vue';
import { router } from './router.ts';

const app = createApp(App);
app.use(createPinia());
app.use(DataLoaderPlugin, { router });
app.use(router);
app.mount('#app');
