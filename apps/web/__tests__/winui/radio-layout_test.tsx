import { expect, test } from 'vitest';

import { fluentComponents } from '../../src/fluent';
import { choiceCss } from '../../src/winui/controls/choice.css';
import { renderInApp } from '../render';

const { Radio, RadioGroup } = fluentComponents;

test.each(['horizontal', 'vertical'] as const)('uses native RadioGroup cell spacing for %s layout', layout => {
  const stylesheet = document.createElement('style');
  stylesheet.textContent = choiceCss;
  document.head.append(stylesheet);
  try {
    const { container } = renderInApp(<RadioGroup layout={layout}>
      <Radio label="First" value="first" />
      <Radio label="Second" value="second" />
    </RadioGroup>);
    const style = getComputedStyle(container.querySelector('.fui-RadioGroup')!);
    expect(style.columnGap).toBe('7px');
    expect(style.rowGap).toBe('8px');
  } finally {
    stylesheet.remove();
  }
});
