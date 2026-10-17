import { fireEvent, screen } from '@testing-library/react';
import { createRef } from 'react';
import { expect, test, vi } from 'vitest';

import { fluentComponents } from '../../src/fluent';
import { renderInApp } from '../render';

const { Badge, Button, CounterBadge, Input, Menu, MenuItem, MenuItemCheckbox, MenuList, MenuPopover, MenuTrigger, NavDrawer, NavItem, Tab, TabList, Textarea } = fluentComponents;

test('wraps button text runs together and leaves icon-only buttons without a label', () => {
  const { container } = renderInApp(<>
    <Button>{'Save '}{3}</Button>
    <Button><>Fragment label</></Button>
    <Button aria-label="Refresh" icon={<svg />} />
  </>);
  const labels = [...container.querySelectorAll('.floway-control-label')];
  expect(labels.map(label => label.textContent)).toEqual(['Save 3', 'Fragment label']);
  expect(screen.getByRole('button', { name: 'Refresh' }).querySelector('.floway-control-label')).toBeNull();
});

test('preserves structured labels, refs, events and disabled state', () => {
  const ref = createRef<HTMLButtonElement>();
  const onClick = vi.fn();
  renderInApp(<>
    <Button onClick={onClick} ref={ref}><span data-custom-label="">Custom layout</span></Button>
    <Button disabled>Unavailable</Button>
  </>);
  expect(ref.current!.firstElementChild!.hasAttribute('data-custom-label')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Custom layout' }));
  expect(onClick).toHaveBeenCalledOnce();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Unavailable' }).disabled).toBe(true);
});

test('keeps badge labels and native zero, overflow and dot semantics', () => {
  const { container } = renderInApp(<>
    <Badge>Enabled</Badge>
    <CounterBadge count={0} showZero />
    <CounterBadge count={120} />
    <CounterBadge count={12} overflowCount={9} />
    <CounterBadge count={0} />
    <CounterBadge count={12} dot />
  </>);
  expect([...container.querySelectorAll('.floway-control-label')].map(label => label.textContent)).toEqual(['Enabled', '0', '99+', '9+']);
});

test('trims tab and navigation labels while retaining selection and accessible names', () => {
  const { container } = renderInApp(<>
    <TabList defaultSelectedValue="users"><Tab value="users">Users</Tab><Tab value="groups">Groups</Tab></TabList>
    <NavDrawer selectedValue="permissions" open type="inline"><NavItem value="permissions">Permissions</NavItem></NavDrawer>
  </>);
  expect(screen.getByRole('tab', { name: 'Users' }).getAttribute('aria-selected')).toBe('true');
  expect(container.querySelector('.fui-NavItem .floway-control-label')!.textContent).toBe('Permissions');
  expect(container.querySelector('.fui-Tab__content .floway-control-label')!.textContent).toBe('Users');
});

test('retains menu trigger and checkable-item behavior with trimmed labels', () => {
  const { baseElement } = renderInApp(<Menu>
    <MenuTrigger disableButtonEnhancement><Button>Open menu</Button></MenuTrigger>
    <MenuPopover><MenuList><MenuItem>Action</MenuItem><MenuItemCheckbox name="wrap" value="on">Wrap</MenuItemCheckbox></MenuList></MenuPopover>
  </Menu>);
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  expect(screen.getByRole('menuitem', { name: 'Action' }).querySelector('.floway-control-label')).toBeTruthy();
  const check = screen.getByRole('menuitemcheckbox', { name: 'Wrap' });
  fireEvent.click(check);
  expect(baseElement.querySelector('.fui-MenuItemCheckbox')).toBeTruthy();
});

test('leaves editable text and its slots unwrapped', () => {
  const { container } = renderInApp(<><Input aria-label="Name" defaultValue="alice" /><Textarea aria-label="Description" defaultValue="Paragraph" /></>);
  expect(container.querySelector('.floway-control-label')).toBeNull();
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('alice');
});
