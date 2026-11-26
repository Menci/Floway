import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { switchCss } from '../../../src/winui/controls/switch.css';

const declarationsFor = (selector: string): Map<string, string> => {
  const root = postcss.parse(switchCss);
  const declarations = new Map<string, string>();
  root.walkRules(rule => {
    if (rule.parent !== root || rule.selector.trim() !== selector) return;
    rule.walkDecls(decl => {
      declarations.set(decl.prop, decl.value);
    });
  });
  return declarations;
};

describe('WinUI switch stacking context', () => {
  it('isolates the indicator so the knob z-index stays inside the track', () => {
    const knob = declarationsFor('.fui-Switch__indicator.fui-Switch__indicator > svg');
    const indicator = declarationsFor('.fui-Switch__indicator.fui-Switch__indicator');

    expect(knob.get('z-index')).toBe('1');
    expect(indicator.get('isolation')).toBe('isolate');
  });
});
