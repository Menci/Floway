import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { MetadataEditor } from '../../../src/components/model-alias/metadata-editor';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';
import type { AnnouncedMetadata } from '@floway-dev/protocols/browser';

const imageInputLabel = i18n.t('dashboard.upstreamEditor.models.imageInput');
const imageDetailOriginalLabel = i18n.t('dashboard.upstreamEditor.models.imageDetailOriginal');

const initialValue: AnnouncedMetadata = {
  chat: {
    reasoning: {
      effort: { supported: ['low'], default: 'low' },
    },
  },
};

function Harness() {
  const [value, setValue] = useState(initialValue);
  return <>
    <MetadataEditor disabled={false} issues={{}} kind="chat" onChange={setValue} readOnly={false} value={value} />
    <output>{JSON.stringify(value.chat?.reasoning?.effort?.supported)}</output>
  </>;
}

function DetailHarness({ initial }: { initial: AnnouncedMetadata }) {
  const [value, setValue] = useState(initial);
  return <>
    <MetadataEditor disabled={false} issues={{}} kind="chat" onChange={setValue} readOnly={false} value={value} />
    <output data-testid="detail">{String(value.chat?.image_detail_original)}</output>
  </>;
}

describe('model alias metadata editor', () => {
  it('preserves a comma while another supported effort is being entered', () => {
    renderInApp(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: i18n.t('dashboard.modelAliases.metadata.efforts') });

    fireEvent.change(input, { target: { value: 'low,' } });
    expect(input.value).toBe('low,');

    fireEvent.change(input, { target: { value: 'low, custom' } });
    expect(input.value).toBe('low, custom');
    expect(screen.getByRole('status').textContent).toBe('["low","custom"]');

    fireEvent.blur(input);
    expect(input.value).toBe('low, custom');
  });

  it('keeps audio input enabled when changing image support', () => {
    renderInApp(<DetailHarness initial={{}} />);
    const audio = screen.getByRole<HTMLInputElement>('switch', { name: i18n.t('dashboard.upstreamEditor.models.audioInput') });
    const image = screen.getByRole<HTMLInputElement>('switch', { name: imageInputLabel });
    fireEvent.click(audio);
    fireEvent.click(image);
    expect(audio.checked && image.checked).toBe(true);
    fireEvent.click(image);
    expect(audio.checked).toBe(true);
  });

  it('can select audio alone and cannot deselect the last input', () => {
    renderInApp(<DetailHarness initial={{}} />);
    const text = screen.getByRole<HTMLInputElement>('switch', { name: i18n.t('dashboard.upstreamEditor.models.textInput') });
    const audio = screen.getByRole<HTMLInputElement>('switch', { name: i18n.t('dashboard.upstreamEditor.models.audioInput') });
    expect(text.disabled).toBe(true);
    fireEvent.click(audio);
    fireEvent.click(text);
    expect(text.checked).toBe(false);
    expect(audio.checked && audio.disabled).toBe(true);
  });

  it('round-trips a false detail claim rather than collapsing it to absent', () => {
    // `false` is the upstream stating it rejects detail 'original', not the
    // absence of a statement, so switching the claim off stores `false` rather
    // than deleting the field the way `reasoning.adaptive` does.
    renderInApp(<DetailHarness initial={{ chat: { modalities: { input: ['text', 'image'], output: ['text'] }, image_detail_original: true } }} />);
    fireEvent.click(screen.getByRole('switch', { name: imageDetailOriginalLabel }));

    expect(screen.getByTestId('detail').textContent).toBe('false');
  });
});
