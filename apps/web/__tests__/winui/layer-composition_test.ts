import { describe, expect, it } from 'vitest';

import { winuiCss } from '../../src/winui';

// A control stylesheet that never reaches `winuiCss` paints nothing, and
// nothing else in the app would notice: the modules are strings, so a missing
// entry in the barrel is neither a type error nor a runtime one. The glob
// matches the directory rather than a list of names, so adding a control and
// forgetting the barrel fails here.
const controlModules = import.meta.glob<Record<string, unknown>>('../../src/winui/controls/*.css.ts', { eager: true });

describe('the WinUI layer', () => {
  it('carries every rule the controls directory declares', () => {
    expect(Object.keys(controlModules).length).toBeGreaterThan(0);

    for (const [path, exports] of Object.entries(controlModules)) {
      const stylesheets = Object.entries(exports).filter(([key]) => key.endsWith('Css'));
      expect(stylesheets.length, `${path} exports no stylesheet`).toBe(1);

      for (const [key, css] of stylesheets) expect(winuiCss, `${path} ${key}`).toContain(css as string);
    }
  });
});
