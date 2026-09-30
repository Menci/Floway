import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';

import { CodexEditor } from '../../../src/components/models/codex-editor';
import { renderInApp } from '../../render';
import { settle } from '../../settle';
import type { CodexChatModelInfo } from '@floway-dev/protocols/common';

function Harness() {
  const [profile, setProfile] = useState<CodexChatModelInfo | undefined>();
  return <CodexEditor readOnly={false} value={profile} onChange={setProfile} />;
}

test('starts collapsed and mounts the main text box only after enabling custom instructions', async () => {
  renderInApp(<Harness />);
  const expander = screen.getByRole('button', { name: 'Codex' });
  expect(expander.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('textbox', { name: 'Model instructions' })).toBeNull();
  fireEvent.click(expander);
  await settle();
  fireEvent.click(screen.getByRole('switch', { name: 'Custom model instructions' }));
  await settle();
  fireEvent.change(screen.getByRole('textbox', { name: 'Model instructions' }), { target: { value: 'Keep this identity.' } });
  expect((screen.getByRole('textbox', { name: 'Model instructions' }) as HTMLTextAreaElement).value).toBe('Keep this identity.');
  fireEvent.click(screen.getByRole('switch', { name: 'Custom model instructions' }));
  await settle();
  expect(screen.queryByRole('textbox', { name: 'Model instructions' })).toBeNull();
});

test('Auto values remain readable but cannot modify the profile', async () => {
  const onChange = vi.fn();
  renderInApp(<CodexEditor readOnly value={{ default_context_window_tokens: 272000, model_messages: { instructions_template: 'Read only.' }, use_responses_lite: true }} onChange={onChange} />);
  expect(screen.queryByRole('spinbutton', { name: 'Default context window' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Model instructions' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  await settle();
  const windowInput = screen.getByRole('spinbutton', { name: 'Default context window' }) as HTMLInputElement;
  expect(windowInput.readOnly).toBe(true);
  fireEvent.change(windowInput, { target: { value: '100000' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Custom model instructions' }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  await settle();
  expect(windowInput.isConnected).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  await settle();
  expect(screen.getByRole('spinbutton', { name: 'Default context window' })).toBe(windowInput);
});

test('invalid advanced JSON cannot be applied and does not mutate metadata', async () => {
  const onChange = vi.fn();
  renderInApp(<CodexEditor readOnly={false} onChange={onChange} value={undefined} />);
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Other model instructions' }));
  await settle();
  fireEvent.change(screen.getByRole('textbox', { name: 'Other model instructions' }), { target: { value: '{invalid' } });
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});
