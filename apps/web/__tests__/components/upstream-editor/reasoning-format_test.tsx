import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { MemoryRouter } from 'react-router';
import { expect, test, vi } from 'vitest';

import { updateBody, valuesFromRecord, type UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { ReasoningFormatEditor } from '../../../src/components/upstream-editor/reasoning-format';
import { UpstreamWorkspace } from '../../../src/components/upstream-editor/workspace';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import type { ChatCompletionsReasoningOverrides } from '@floway-dev/protocols/openai-chat-completions';

const label = (key: 'text' | 'data' | 'passthrough' | 'title') => i18n.t(`dashboard.upstreamEditor.reasoningFormat.${key}`);

function FormatHarness() {
  const [value, setValue] = useState<ChatCompletionsReasoningOverrides>({});
  return <>
    <ReasoningFormatEditor defaults={{ text: 'reasoning-content', data: 'passthrough' }} value={value} onChange={setValue} />
    <output aria-label="Stored reasoning options">{JSON.stringify(value)}</output>
  </>;
}

test('reasoning selectors show field names and let both channels preserve unchanged', async () => {
  renderInApp(<FormatHarness />);
  const text = screen.getByRole('combobox', { name: label('text') });
  const data = screen.getByRole('combobox', { name: label('data') });
  expect(text.textContent).toContain('reasoning_content');
  expect(text.querySelector('.font-mono')?.textContent).toBe('reasoning_content');
  expect(data.textContent).toContain(label('passthrough'));
  fireEvent.click(text);
  const reasoningText = await screen.findByRole('option', { name: 'reasoning_text' });
  expect(reasoningText.querySelector('.font-mono')?.textContent).toBe('reasoning_text');
  fireEvent.click(reasoningText);
  fireEvent.click(data);
  const details = await screen.findByRole('option', { name: 'OpenRouter reasoning_details' });
  expect(details.querySelector('.font-mono')?.textContent).toBe('reasoning_details');
  fireEvent.click(details);
  await waitFor(() => expect(screen.getByLabelText('Stored reasoning options').textContent).toBe('{"text":"reasoning-text","data":"openrouter-reasoning-details"}'));
  for (const control of [text, data]) {
    fireEvent.click(control);
    fireEvent.click(await screen.findByRole('option', { name: label('passthrough') }));
  }
  await waitFor(() => expect(screen.getByLabelText('Stored reasoning options').textContent).toBe('{"text":"passthrough","data":"passthrough"}'));
});

test.each([
  { inherited: { text: 'reasoning-text', data: 'openrouter-reasoning-details' }, value: {}, fields: ['reasoning_text', 'reasoning', 'reasoning_details', 'reasoning_opaque'] },
  { inherited: { text: 'reasoning-text', data: 'openrouter-reasoning-details' }, value: { data: 'passthrough' }, fields: ['reasoning_text', 'reasoning'] },
  { inherited: { text: 'reasoning-text', data: 'openrouter-reasoning-details' }, value: { text: 'passthrough' }, fields: ['reasoning_details', 'reasoning_opaque'] },
  { inherited: { text: 'reasoning-text', data: 'openrouter-reasoning-details' }, value: { text: 'passthrough', data: 'passthrough' }, fields: [] },
] as const)('client response hint uses computed channel decisions ($value)', ({ inherited, value, fields }) => {
  const { container } = renderInApp(<ReasoningFormatEditor defaults={{ text: 'passthrough', data: 'passthrough' }} inherited={inherited} value={value} onChange={vi.fn()} />);
  const hint = container.querySelector('.text-fui-fg2');
  expect(hint?.textContent).toContain('Clients connected to Floway');
  expect([...hint!.querySelectorAll('.font-mono')].map(node => node.textContent)).toEqual(fields);
  if (fields.length < 4) expect(hint?.textContent).toContain("server's original format");
});

test('hiding the upstream reasoning fields retains their values in the submitted payload', async () => {
  const options: ChatCompletionsReasoningOverrides = { text: 'reasoning-text', data: 'litellm-thinking-blocks' };
  const record = upstreamRecord('up_test', {
    kind: 'custom',
    state: null,
    chat_completions_reasoning_overrides: options,
    config: { baseUrl: 'https://example.com', authStyle: 'none', ingressHeadersRules: [], endpoints: { openaiResponses: {} }, modelsFetch: { enabled: false }, models: [{ upstreamModelId: 'manual-chat', kind: 'chat', endpoints: { openaiChatCompletions: {} } }] },
  });
  const submitted = vi.fn();
  function VisibilityHarness() {
    const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
    const submit = form.handleSubmit(values => { submitted(updateBody(record, values)); });
    return <MemoryRouter initialEntries={['/?tab=flags']}><FormProvider {...form}>
      <form onSubmit={event => { void submit(event); }}>
        <button type="button" onClick={() => form.setValue('config', { ...form.getValues('config'), endpoints: { openaiChatCompletions: {} } })}>Enable upstream Chat</button>
        <button type="button" onClick={() => form.setValue('config', { ...form.getValues('config'), endpoints: { openaiResponses: {} } })}>Disable upstream Chat</button>
        <button type="submit">Submit</button>
        <UpstreamWorkspace discovered={[]} modelsYamlDraft={null} modelsError={null} modelsLoading={false} onModelsYamlDraftChange={vi.fn()} onRefreshModels={vi.fn()} record={record} />
      </form>
    </FormProvider></MemoryRouter>;
  }
  renderInApp(<VisibilityHarness />);
  expect(screen.queryByRole('group', { name: label('title') })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Enable upstream Chat' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: label('text') }).textContent).toBe('reasoning_text'));
  expect(screen.getByRole('combobox', { name: label('data') }).textContent).toBe('LiteLLM thinking_blocks');
  fireEvent.click(screen.getByRole('button', { name: 'Disable upstream Chat' }));
  await waitFor(() => expect(screen.queryByRole('group', { name: label('title') })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ chat_completions_reasoning_overrides: options })));
});
