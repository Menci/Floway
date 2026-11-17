import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { MultiselectCombobox } from '../../../src/components/ui/multiselect-combobox';
import { renderInApp } from '../../render';

describe('multiselect combobox', () => {
  it('keeps a selected value operable after it leaves the available options', async () => {
    function Host() {
      const [value, setValue] = useState(['retired-model']);
      return <MultiselectCombobox
        ariaLabel="Models"
        clearLabel="All models"
        onChange={setValue}
        options={[{ value: 'current-model', label: 'Current model' }]}
        placeholder={value.length === 0 ? 'All models' : `${value.length} selected`}
        value={value}
      />;
    }

    renderInApp(<Host />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Models' }));

    expect(await screen.findByRole('menuitemcheckbox', { name: 'retired-model' })).toBeTruthy();
    const clear = screen.getByRole('menuitemcheckbox', { name: 'All models' });
    expect(clear.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(clear);
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Models' }).placeholder).toBe('All models');
    expect(screen.getByRole('menuitemcheckbox', { name: 'All models' }).getAttribute('aria-checked')).toBe('true');
  });

  it('selects a substring search result with Enter without activating clear', async () => {
    function Host() {
      const [value, setValue] = useState(['retired-model']);
      return <MultiselectCombobox
        ariaLabel="Models"
        clearLabel="All models"
        onChange={setValue}
        options={[{ value: 'current-model', label: 'Current model' }]}
        placeholder={`${value.length} selected`}
        value={value}
      />;
    }

    renderInApp(<Host />);
    const input = screen.getByRole('combobox', { name: 'Models' });
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'urrent' } });
    expect(screen.queryByRole('menuitemcheckbox', { name: 'All models' })).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input.getAttribute('placeholder')).toBe('2 selected');
  });
});
