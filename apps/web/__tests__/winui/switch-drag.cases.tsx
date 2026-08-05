import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { fluentComponents } from '../../src/fluent';
import { renderInApp } from '../render';

const { Switch } = fluentComponents;

describe('WinUI switch drag wrapper', () => {
  it('composes the root event handlers a caller supplied', () => {
    const onClickCapture = vi.fn();
    const onPointerDown = vi.fn();
    renderInApp(<Switch
      label="Model discovery"
      root={{ onClickCapture, onPointerDown }}
    />);
    const input = screen.getByRole('switch', { name: 'Model discovery' });
    const root = input.closest<HTMLElement>('.fui-Switch');
    if (!root) throw new Error('The Switch rendered no root');

    fireEvent.pointerDown(root, { button: 1, isPrimary: true });
    fireEvent.click(root);

    expect(onPointerDown).toHaveBeenCalledOnce();
    expect(onClickCapture).toHaveBeenCalledOnce();
  });
});
