import { fireEvent } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { fluentComponents } from '../../src/fluent';
import { winuiAppearanceAttribute, winuiCheckedAttribute } from '../../src/winui/appearance';
import { renderInApp } from '../render';

const {
  Button,
  Card,
  CardFooter,
  CardHeader,
  CardPreview,
  Checkbox,
  Combobox,
  CompoundButton,
  Dropdown,
  Input,
  Link,
  Menu,
  MenuButton,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Select,
  SplitButton,
  Table,
  TableBody,
  TableRow,
  TableSelectionCell,
  Textarea,
  ToggleButton,
  Toolbar,
  ToolbarButton,
  ToolbarRadioButton,
  ToolbarRadioGroup,
  ToolbarToggleButton,
  Tooltip,
} = fluentComponents;

describe('appearance on the DOM', () => {
  it('stamps each component with its own Fluent default', () => {
    const view = renderInApp(
      <>
        <Button>default button</Button>
        <ToggleButton>default toggle</ToggleButton>
        <Toolbar>
          <ToolbarButton>default toolbar button</ToolbarButton>
        </Toolbar>
        <Link href="#">default link</Link>
      </>,
    );

    const stamped = [...view.container.querySelectorAll(`[${winuiAppearanceAttribute}]`)].map(element =>
      element.getAttribute(winuiAppearanceAttribute));

    expect(stamped).toEqual(['secondary', 'secondary', 'subtle', 'default']);
  });

  it('stamps the explicit appearance when one is given', () => {
    const view = renderInApp(<Button appearance="primary">accent</Button>);

    expect(view.container.querySelector('button')?.getAttribute(winuiAppearanceAttribute)).toBe('primary');
  });

  it('distinguishes the borderless appearances from the default one', () => {
    const view = renderInApp(
      <>
        <Button appearance="subtle">subtle</Button>
        <Button appearance="transparent">transparent</Button>
        <Button appearance="outline">outline</Button>
      </>,
    );

    const stamped = [...view.container.querySelectorAll('button')].map(element =>
      element.getAttribute(winuiAppearanceAttribute));

    expect(stamped).toEqual(['subtle', 'transparent', 'outline']);
  });
});

describe('components whose root is not their primary slot', () => {
  it('reaches the root as well as the inner control', () => {
    const view = renderInApp(
      <>
        <Input aria-label="input" />
        <Textarea aria-label="textarea" />
        <Select aria-label="select" />
        <Combobox aria-label="combobox" />
        <Dropdown aria-label="dropdown" />
      </>,
    );

    for (const [rootClass, primary] of [
      ['fui-Input', 'input'],
      ['fui-Textarea', 'textarea'],
      ['fui-Select', 'select'],
      ['fui-Combobox', 'input'],
      ['fui-Dropdown', 'button'],
    ]) {
      const root = view.container.querySelector(`.${rootClass}`);
      expect(root?.getAttribute(winuiAppearanceAttribute), rootClass).toBe('outline');
      expect(root?.querySelector(primary)?.getAttribute(winuiAppearanceAttribute), `${rootClass} ${primary}`).toBe(
        'outline',
      );
    }
  });

  it('carries a non-default appearance through to the attribute', () => {
    const view = renderInApp(<Input appearance="filled-darker" aria-label="input" />);

    expect(view.container.querySelector('.fui-Input')?.getAttribute(winuiAppearanceAttribute)).toBe('filled-darker');
  });

  it('accepts a root slot given as shorthand rather than as a props object', () => {
    const view = renderInApp(<Input root="shorthand" aria-label="input" />);

    expect(view.container.querySelector('.fui-Input')?.getAttribute(winuiAppearanceAttribute)).toBe('outline');
    expect(view.container.querySelector('input')).not.toBeNull();
  });

  it('merges into a root slot given as a props object', () => {
    const view = renderInApp(<Input root={{ className: 'own-root-class' }} aria-label="input" />);

    const root = view.container.querySelector('.own-root-class');

    expect(root?.getAttribute(winuiAppearanceAttribute)).toBe('outline');
  });
});

describe('what the wrappers must not break', () => {
  it('forwards the ref to the same element type Fluent renders', () => {
    const buttonRef = React.createRef<HTMLButtonElement>();
    const inputRef = React.createRef<HTMLInputElement>();

    renderInApp(
      <>
        <Button ref={buttonRef}>ref</Button>
        <Input aria-label="input" ref={inputRef} />
      </>,
    );

    expect(buttonRef.current?.tagName).toBe('BUTTON');
    expect(inputRef.current?.tagName).toBe('INPUT');
  });

  it('keeps the displayName parents and devtools read', () => {
    expect([Button.displayName, Input.displayName, Dropdown.displayName, Link.displayName]).toEqual([
      'Button',
      'Input',
      'Dropdown',
      'Link',
    ]);
  });

  it('still works as a cloned trigger child', () => {
    const view = renderInApp(
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Tooltip content="tip" relationship="label">
            <Button>trigger</Button>
          </Tooltip>
        </MenuTrigger>
        <MenuPopover>
          <MenuList />
        </MenuPopover>
      </Menu>,
    );

    const trigger = view.container.querySelector('button');

    expect(trigger?.getAttribute(winuiAppearanceAttribute)).toBe('secondary');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger?.getAttribute('aria-label')).toBe('tip');

    fireEvent.click(trigger!);

    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(view.baseElement.querySelector('[role="menu"]')).not.toBeNull();
  });
});

describe('the rest of the button family', () => {
  it('stamps every component that renders a Fluent button root', () => {
    const view = renderInApp(
      <>
        <CompoundButton secondaryContent="secondary">compound</CompoundButton>
        <MenuButton>menu</MenuButton>
        <Toolbar>
          <ToolbarToggleButton name="toggle" value="one">
            toolbar toggle
          </ToolbarToggleButton>
          <ToolbarRadioGroup>
            <ToolbarRadioButton name="radio" value="one">
              toolbar radio
            </ToolbarRadioButton>
          </ToolbarRadioGroup>
        </Toolbar>
      </>,
    );

    const stamped = [...view.container.querySelectorAll('button')].map(element =>
      element.getAttribute(winuiAppearanceAttribute));

    expect(stamped).toEqual(['secondary', 'secondary', 'subtle', 'subtle']);
  });

  it('stamps both buttons a SplitButton renders from its own slots', () => {
    const view = renderInApp(<SplitButton appearance="primary">split</SplitButton>);

    const stamped = [...view.container.querySelectorAll('button')].map(element =>
      element.getAttribute(winuiAppearanceAttribute));

    expect(stamped).toEqual(['primary', 'primary']);
  });

  it('leaves a suppressed SplitButton slot suppressed', () => {
    const view = renderInApp(<SplitButton menuButton={null}>split</SplitButton>);

    expect(view.container.querySelectorAll('button')).toHaveLength(1);
  });
});

describe('the checked axis the WinUI rules read', () => {
  it('exposes a checked ToggleButton as aria-pressed alongside its stamp', () => {
    const view = renderInApp(<ToggleButton checked>checked</ToggleButton>);

    const toggle = view.container.querySelector('button');

    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(toggle?.getAttribute(winuiAppearanceAttribute)).toBe('secondary');
  });

  it('exposes a checked toolbar radio button as aria-checked instead', () => {
    const view = renderInApp(
      <Toolbar checkedValues={{ radio: ['one'] }}>
        <ToolbarRadioGroup>
          <ToolbarRadioButton name="radio" value="one">
            checked radio
          </ToolbarRadioButton>
        </ToolbarRadioGroup>
      </Toolbar>,
    );

    const radio = view.container.querySelector('button');

    expect(radio?.getAttribute('aria-checked')).toBe('true');
    expect(radio?.getAttribute('aria-pressed')).toBeNull();
    expect(radio?.getAttribute(winuiAppearanceAttribute)).toBe('subtle');
  });

  // The WinUI mixed rules cannot read :indeterminate, because the browser clears
  // that property when the user activates the box and Fluent re-asserts it only
  // from an effect keyed on the mixed flag -- which does not re-run while the box
  // stays mixed. Clearing the property here is the activation behavior a real
  // engine performs and happy-dom does not; the stamp has to outlive it.
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-checkbox/library/src/components/Checkbox/useCheckbox.tsx#L163-L169
  // https://html.spec.whatwg.org/multipage/input.html#the-input-element:legacy-pre-activation-behavior
  it('keeps a check box held at mixed stamped across a click', () => {
    const view = renderInApp(<Checkbox checked="mixed" label="mixed" />);

    const input = view.container.querySelector('input')!;

    expect(input.getAttribute(winuiCheckedAttribute)).toBe('mixed');

    input.indeterminate = false;
    fireEvent.click(input);

    expect(input.getAttribute(winuiCheckedAttribute)).toBe('mixed');
    expect(input.indeterminate).toBe(false);
  });

  it('follows an uncontrolled check box onto the state its own change reported', () => {
    const view = renderInApp(<Checkbox defaultChecked label="uncontrolled" />);

    const input = view.container.querySelector('input')!;

    expect(input.getAttribute(winuiCheckedAttribute)).toBe('true');

    fireEvent.click(input);

    expect(input.getAttribute(winuiCheckedAttribute)).toBe('false');
  });

  it('stamps the check box a table selection cell builds for itself', () => {
    const view = renderInApp(
      <Table>
        <TableBody>
          <TableRow>
            <TableSelectionCell checked="mixed" />
          </TableRow>
          <TableRow>
            <TableSelectionCell checked />
          </TableRow>
          <TableRow>
            <TableSelectionCell />
          </TableRow>
        </TableBody>
      </Table>,
    );

    const stamped = [...view.container.querySelectorAll('.fui-Checkbox input')].map(element =>
      element.getAttribute(winuiCheckedAttribute));

    expect(stamped).toEqual(['mixed', 'true', 'false']);
  });

  it('follows a selection cell check box the cell left to itself', () => {
    const view = renderInApp(
      <Table>
        <TableBody>
          <TableRow>
            <TableSelectionCell />
          </TableRow>
        </TableBody>
      </Table>,
    );

    const input = view.container.querySelector('.fui-Checkbox input')!;

    expect(input.getAttribute(winuiCheckedAttribute)).toBe('false');

    fireEvent.click(input);

    expect(input.getAttribute(winuiCheckedAttribute)).toBe('true');
  });

  // Fluent puts the cell's own `checked` in the slot's defaultProps, so a slot
  // that states its own outranks it. The stamp reads the slot through the same
  // order, rather than replacing what the slot asked for.
  it('follows a check box state the caller put on the indicator slot', () => {
    const view = renderInApp(
      <Table>
        <TableBody>
          <TableRow>
            <TableSelectionCell checkboxIndicator={{ checked: true }} />
          </TableRow>
        </TableBody>
      </Table>,
    );

    const input = view.container.querySelector<HTMLInputElement>('.fui-Checkbox input')!;

    expect(input.checked).toBe(true);
    expect(input.getAttribute(winuiCheckedAttribute)).toBe('true');
  });

  it('leaves a selection cell that draws no check box alone', () => {
    const view = renderInApp(
      <Table>
        <TableBody>
          <TableRow>
            <TableSelectionCell type="radio" checked />
          </TableRow>
          <TableRow>
            <TableSelectionCell checkboxIndicator={null} />
          </TableRow>
        </TableBody>
      </Table>,
    );

    expect(view.container.querySelectorAll('.fui-Checkbox')).toHaveLength(0);
    expect(view.container.querySelectorAll('.fui-Radio')).toHaveLength(1);
  });
});

describe('the card surface', () => {
  it('stamps the appearance the WinUI card rules are partitioned by', () => {
    const view = renderInApp(
      <>
        <Card>default card</Card>
        <Card appearance="filled-alternative">alternative card</Card>
        <Card appearance="outline">outline card</Card>
        <Card appearance="subtle">subtle card</Card>
      </>,
    );

    const stamped = [...view.container.querySelectorAll('.fui-Card')].map(element =>
      element.getAttribute(winuiAppearanceAttribute));

    expect(stamped).toEqual(['filled', 'filled-alternative', 'outline', 'subtle']);
  });

  it('leaves the card parts that have no appearance unstamped', () => {
    const view = renderInApp(
      <Card>
        <CardPreview>preview</CardPreview>
        <CardHeader header="header" />
        <CardFooter>footer</CardFooter>
      </Card>,
    );

    const stamped = [...view.container.querySelectorAll(`[${winuiAppearanceAttribute}]`)];

    expect(stamped).toEqual([view.container.querySelector('.fui-Card')]);
  });
});
