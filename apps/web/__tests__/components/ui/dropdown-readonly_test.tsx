import { fireEvent, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { Dropdown } from '../../../src/components/ui/fluent-form-controls';
import { fluentComponents } from '../../../src/fluent';
import { renderInApp } from '../../render';

const { Option } = fluentComponents;

test('a read-only dropdown refuses to open its option list', () => {
  renderInApp(<Dropdown readOnly value="Bearer">
    <Option value="bearer">Bearer</Option>
    <Option value="anthropic">Anthropic</Option>
  </Dropdown>);

  const trigger = screen.getByRole('combobox');
  expect(trigger.getAttribute('aria-readonly')).toBe('true');
  fireEvent.click(trigger);
  expect(screen.queryByRole('listbox')).toBeNull();
});
