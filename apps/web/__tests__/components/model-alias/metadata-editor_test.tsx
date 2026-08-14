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
});
