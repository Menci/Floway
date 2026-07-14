import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { expect, test } from 'vitest';

import CliSnippet from './CliSnippet.vue';
import type { ControlPlaneModel } from '../../api/types.ts';

const CodeStub = defineComponent({
  name: 'Code',
  props: {
    code: { type: String, required: true },
  },
  template: '<pre>{{ code }}</pre>',
});

const codexModel: ControlPlaneModel = {
  id: 'gpt-5.4',
  object: 'model',
  type: 'model',
  display_name: 'GPT-5.4',
  limits: {},
  kind: 'chat',
  endpoints: { responses: {} },
  upstreams: [],
};

test('Codex snippet opts the Floway provider into the supported ChatGPT-auth surface', () => {
  const wrapper = mount(CliSnippet, {
    props: { apiKey: 'floway-key', models: [codexModel] },
    global: { stubs: { Code: CodeStub } },
  });
  const config = wrapper.findAll('pre').map(block => block.text()).find(code => code.includes('[model_providers.floway]'));
  expect(config).toBeDefined();
  expect(config).toContain('requires_openai_auth = true');
  expect(config).toContain('[features]\napps = false\nuse_agent_identity = false');
  expect(config!.indexOf('requires_openai_auth = true')).toBeLessThan(config!.indexOf('[features]'));
});
