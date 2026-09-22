import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { MetadataEditor } from '../../../src/components/model-alias/metadata-editor';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';
import type { AnnouncedMetadata } from '@floway-dev/protocols/common';

const imageDetailOriginalLabel = i18n.t('dashboard.modelAliases.metadata.imageDetailOriginal');

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

  it('holds both image switches in one row of the group that names them', () => {
    // The detail switch is subordinate to image input, and the group shows it:
    // one heading over one row carrying both switches, the shape the upstream
    // editor gives these fields.
    renderInApp(<DetailHarness initial={{ chat: { modalities: { input: ['text', 'image'], output: ['text'] }, image_detail_original: true } }} />);
    const group = screen.getByRole('group', { name: i18n.t('dashboard.modelAliases.metadata.imageInput') });

    // A switch's root carries `fui-Switch` and nests its input, so the row is
    // the second ancestor up.
    expect(group.querySelector('h4')).toBeNull();
    const detailSwitch = screen.getByRole('switch', { name: imageDetailOriginalLabel });
    expect(screen.getByRole('switch', { name: i18n.t('dashboard.modelAliases.metadata.imageInput') }).parentElement?.parentElement)
      .toBe(detailSwitch.parentElement?.parentElement);
  });

  it('hides the detail switch until image input is on', () => {
    renderInApp(<DetailHarness initial={{}} />);
    expect(screen.queryByRole('switch', { name: imageDetailOriginalLabel })).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: i18n.t('dashboard.modelAliases.metadata.imageInput') }));
    expect(screen.getByRole('switch', { name: imageDetailOriginalLabel })).toBeDefined();
    expect(screen.getByTestId('detail').textContent).toBe('false');
  });

  it('preserves an existing detail claim when image input is enabled', () => {
    renderInApp(<DetailHarness initial={{ chat: { image_detail_original: true } }} />);

    fireEvent.click(screen.getByRole('switch', { name: i18n.t('dashboard.modelAliases.metadata.imageInput') }));

    expect(screen.getByRole<HTMLInputElement>('switch', { name: imageDetailOriginalLabel }).checked).toBe(true);
    expect(screen.getByTestId('detail').textContent).toBe('true');
  });

  it('drops the detail claim when image input is switched off', () => {
    // The detail switch is only reachable while image input is on, so a stored
    // claim must not outlive its parent toggle.
    renderInApp(<DetailHarness initial={{ chat: { modalities: { input: ['text', 'image'], output: ['text'] }, image_detail_original: true } }} />);
    fireEvent.click(screen.getByRole('switch', { name: i18n.t('dashboard.modelAliases.metadata.imageInput') }));

    expect(screen.getByTestId('detail').textContent).toBe('undefined');

    fireEvent.click(screen.getByRole('switch', { name: i18n.t('dashboard.modelAliases.metadata.imageInput') }));
    expect(screen.getByRole<HTMLInputElement>('switch', { name: imageDetailOriginalLabel }).checked).toBe(false);
    expect(screen.getByTestId('detail').textContent).toBe('false');
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
