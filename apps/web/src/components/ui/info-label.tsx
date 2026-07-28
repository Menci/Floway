import type { InfoLabelProps, LabelProps } from '@fluentui/react-components';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { InfoLabel } = fluentComponents;

// Fluent hangs a control's explanation off an info button next to its label
// instead of trailing the control with hint text, which keeps a row of fields
// the same height and the same width.
// https://react.fluentui.dev/?path=/docs/components-infolabel--docs
export const infoLabelSlot = (label: ReactNode, info: InfoLabelProps['info']) =>
  (_: unknown, slotProps: LabelProps) => <InfoLabel {...slotProps} info={info}>{label}</InfoLabel>;
