import type { CardProps } from '@fluentui/react-components';

import { fluentComponents } from '../../fluent';

const { Card } = fluentComponents;

export type PanelProps = CardProps;

// A Card, and nothing else. The WinUI layer gives every card the overlay corner
// radius, so a panel has no radius to state; the one surface that wants a
// larger one states it at its own call site.
export function Panel(props: PanelProps) {
  return <Card {...props} />;
}
