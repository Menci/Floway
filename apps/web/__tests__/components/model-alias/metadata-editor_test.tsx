import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { MetadataEditor } from '../../../src/components/model-alias/metadata-editor';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';
import type { AnnouncedMetadata } from '@floway-dev/protocols/common';

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

  it('hides the detail switch until image input is on', () => {
    renderInApp(<DetailHarness initial={{}} />);
    const detailLabel = i18n.t('dashboard.modelAliases.metadata.imageDetailOriginal');
    expect(screen.queryByRole('switch', { name: detailLabel })).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: i18n.t('dashboard.modelAliases.metadata.imageInput') }));
    expect(screen.getByRole('switch', { name: detailLabel })).toBeDefined();
  });

  it('drops the detail claim when image input is switched off', () => {
    // A model with no image modality cannot be accepting detail 'original', so
    // the flag must not outlive the modality that justifies it.
    renderInApp(<DetailHarness initial={{ chat: { modalities: { input: ['text', 'image'], output: ['text'] }, image_detail_original: true } }} />);
    fireEvent.click(screen.getByRole('switch', { name: i18n.t('dashboard.modelAliases.metadata.imageInput') }));

    expect(screen.getByTestId('detail').textContent).toBe('undefined');
  });

  it('round-trips a false detail claim rather than collapsing it to absent', () => {
    // `false` is the upstream stating it rejects detail 'original', not the
    // absence of a statement, so switching the claim off stores `false` rather
    // than deleting the field the way `reasoning.adaptive` does.
    renderInApp(<DetailHarness initial={{ chat: { modalities: { input: ['text', 'image'], output: ['text'] }, image_detail_original: true } }} />);
    fireEvent.click(screen.getByRole('switch', { name: i18n.t('dashboard.modelAliases.metadata.imageDetailOriginal') }));

    expect(screen.getByTestId('detail').textContent).toBe('false');
  });
});
