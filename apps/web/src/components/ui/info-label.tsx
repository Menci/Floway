import type { InfoLabelProps, LabelProps } from '@fluentui/react-components';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { InfoLabel } = fluentComponents;

// Fluent hangs a control's explanation off an info button next to its label
// instead of trailing the control with hint text, which keeps a row of fields
// the same height and the same width.
//
// This is for a Field, whose label names its control without being its hit
// target. A Switch is not: it injects `htmlFor` into whatever it is handed as a
// label, and the browser activates a labelled control from anywhere inside that
// label -- so an info button placed there throws the switch and never opens,
// before any handler of its own can run. A switch that wants one puts it beside
// the control instead.
// https://react.fluentui.dev/?path=/docs/components-infolabel--docs
export const infoLabelSlot = (label: ReactNode, info: InfoLabelProps['info']) =>
  (_: unknown, slotProps: LabelProps) => <InfoLabel {...slotProps} info={info}>{label}</InfoLabel>;
