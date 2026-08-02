// Fluent runs the indeterminate ProgressBar from the Web Animations API rather
// than a stylesheet -- one 33 per cent segment sweeping across in 3s, or a
// full-width opacity pulse under a reduced-motion preference -- so no rule can
// retime or reshape it. Its motion slot is documented as nullable, and emptying
// it here is what hands the state to ./progress-indeterminate.css, whose
// transcription of WinUI's own storyboard is the only shape this control has.
//
// Slot props from the caller are spread last, so a caller that states its own
// motion keeps it.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-progress/library/src/components/ProgressBar/progressBarMotions.ts#L8-L23
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-progress/library/src/components/ProgressBar/ProgressBar.types.ts#L13-L16
import * as React from 'react';

type FluentComponents = typeof import('@fluentui/react-components');
type PropCarrier = Record<string, unknown>;

export const withWinuiProgressIndeterminate = (components: FluentComponents): FluentComponents => {
  const elementType = components.ProgressBar as React.ElementType;

  const ProgressBar = React.forwardRef<unknown, PropCarrier>((props, ref) =>
    React.createElement(elementType, { indeterminateMotion: null, ...props, ref }));

  ProgressBar.displayName = components.ProgressBar.displayName;

  return { ...components, ProgressBar: ProgressBar as unknown as FluentComponents['ProgressBar'] };
};
