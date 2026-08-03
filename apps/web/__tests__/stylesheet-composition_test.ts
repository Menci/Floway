import { describe, expect, it } from 'vitest';

import { criticalCss } from '../src/critical.css';
import { winuiCss } from '../src/winui';

// A stylesheet module that reaches neither aggregator paints nothing, and
// nothing else in the app would notice: the modules are strings, so a missing
// entry in a barrel is neither a type error nor a runtime one. The glob matches
// the tree rather than a list of names, so adding a stylesheet and forgetting
// the barrel fails here. `critical.css.ts` is itself an aggregator, so it is
// the one module excluded.
const stylesheetModules = import.meta.glob<Record<string, unknown>>(
  ['../src/**/*.css.ts', '!../src/critical.css.ts'],
  { eager: true },
);

const layers = [criticalCss, winuiCss];

describe('the stylesheet layers', () => {
  it('carry every rule the source tree declares', () => {
    expect(Object.keys(stylesheetModules).length).toBeGreaterThan(0);

    for (const [path, exports] of Object.entries(stylesheetModules)) {
      const stylesheets = Object.entries(exports).filter(([key]) => key.endsWith('Css'));
      expect(stylesheets.length, `${path} exports no stylesheet`).toBe(1);

      // A module that builds its rules from arguments is reached through its
      // caller, and the caller's own export is what gets checked here.
      for (const [key, css] of stylesheets) {
        if (typeof css !== 'string') continue;
        expect(layers.some(layer => layer.includes(css)), `${path} ${key}`).toBe(true);
      }
    }
  });
});
