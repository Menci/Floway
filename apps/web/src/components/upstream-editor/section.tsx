import { useId } from 'react';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';
import { useDangerTextClass } from '../ui/danger';
import { SECTION_STACK_CLASS } from '../ui/layout';
import { SectionHeader } from '../ui/section-header';

const { Text } = fluentComponents;

// A titled block of the upstream editor. What it holds -- a hue rail, a
// credential flow, a proxy list, a row of endpoint checkboxes -- is a composite
// no single Fluent Field can speak for, so the block names itself as a group
// instead.
export function EditorSection({ children, description, error, hint, inline = false, level = 2, title }: {
  children: ReactNode;
  description?: string;
  error?: string;
  hint?: string;
  inline?: boolean;
  level?: 2 | 3;
  title: string;
}) {
  const dangerText = useDangerTextClass();
  const id = useId();
  const layout = inline
    ? 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4'
    : level === 2 ? 'grid gap-4' : SECTION_STACK_CLASS;
  return <section
    aria-describedby={hint ? `${id}-hint` : undefined}
    aria-labelledby={`${id}-title`}
    className={layout}
    role="group"
  >
    <SectionHeader description={description} level={level} title={title} titleId={`${id}-title`} />
    {children}
    {hint && <Text id={`${id}-hint`} size={200} className="text-fui-fg2">{hint}</Text>}
    {error && <Text className={`${dangerText} ${inline ? 'col-span-2' : ''}`} role="alert" size={200}>{error}</Text>}
  </section>;
}
