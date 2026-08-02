import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

import { fluentComponents } from '../src/fluent';
import { winuiLightTheme } from '../src/winui/theme';

const { FluentProvider } = fluentComponents;

// `src/root.tsx` mounts `winuiLightTheme` / `winuiDarkTheme`, never the stock
// Fluent theme they are built from. A suite that provides its own theme
// renders a tree the WinUI layer never reached, so every DOM suite goes
// through here and sees the tokens the app actually ships.
export const renderInApp = (node: ReactNode) =>
  render(<FluentProvider theme={winuiLightTheme}>{node}</FluentProvider>);
