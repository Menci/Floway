import { cleanup, fireEvent, render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { fluentComponents } from '../../src/fluent';
import { flowayLightTheme } from '../../src/theme';
import { winuiAppearanceAttribute } from '../../src/winui/appearance';

const {
  Button,
  Combobox,
  CompoundButton,
  Dropdown,
  FluentProvider,
  Input,
  Link,
  Menu,
  MenuButton,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Select,
  SplitButton,
  Textarea,
  ToggleButton,
  Toolbar,
  ToolbarButton,
  ToolbarRadioButton,
  ToolbarRadioGroup,
  ToolbarToggleButton,
  Tooltip,
} = fluentComponents;

const inProvider = (children: React.ReactNode) =>
  render(<FluentProvider theme={flowayLightTheme}>{children}</FluentProvider>);

afterEach(cleanup);

describe('appearance on the DOM', () => {
  it('stamps each component with its own Fluent default', () => {
    const view = inProvider(
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
    const view = inProvider(<Button appearance="primary">accent</Button>);

    expect(view.container.querySelector('button')?.getAttribute(winuiAppearanceAttribute)).toBe('primary');
  });

  it('distinguishes the borderless appearances from the default one', () => {
    const view = inProvider(
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
    const view = inProvider(
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

  it('keeps the underline appearance nameable', () => {
    const view = inProvider(<Input appearance="underline" aria-label="input" />);

    expect(view.container.querySelector('.fui-Input')?.getAttribute(winuiAppearanceAttribute)).toBe('underline');
  });

  it('accepts a root slot given as shorthand rather than as a props object', () => {
    const view = inProvider(<Input root="shorthand" aria-label="input" />);

    expect(view.container.querySelector('.fui-Input')?.getAttribute(winuiAppearanceAttribute)).toBe('outline');
    expect(view.container.querySelector('input')).not.toBeNull();
  });

  it('merges into a root slot given as a props object', () => {
    const view = inProvider(<Input root={{ className: 'own-root-class' }} aria-label="input" />);

    const root = view.container.querySelector('.own-root-class');

    expect(root?.getAttribute(winuiAppearanceAttribute)).toBe('outline');
  });
});

describe('what the wrappers must not break', () => {
  it('forwards the ref to the same element type Fluent renders', () => {
    const buttonRef = React.createRef<HTMLButtonElement>();
    const inputRef = React.createRef<HTMLInputElement>();

    inProvider(
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
    const view = inProvider(
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
    const view = inProvider(
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
    const view = inProvider(<SplitButton appearance="primary">split</SplitButton>);

    const stamped = [...view.container.querySelectorAll('button')].map(element =>
      element.getAttribute(winuiAppearanceAttribute));

    expect(stamped).toEqual(['primary', 'primary']);
  });

  it('leaves a suppressed SplitButton slot suppressed', () => {
    const view = inProvider(<SplitButton menuButton={null}>split</SplitButton>);

    expect(view.container.querySelectorAll('button')).toHaveLength(1);
  });
});

describe('the checked axis the WinUI rules read', () => {
  it('exposes a checked ToggleButton as aria-pressed alongside its stamp', () => {
    const view = inProvider(<ToggleButton checked>checked</ToggleButton>);

    const toggle = view.container.querySelector('button');

    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(toggle?.getAttribute(winuiAppearanceAttribute)).toBe('secondary');
  });

  it('exposes a checked toolbar radio button as aria-checked instead', () => {
    const view = inProvider(
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
});
