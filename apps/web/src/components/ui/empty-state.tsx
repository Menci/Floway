import type { ReactNode } from 'react';

import { TIGHT_STACK_CLASS } from './layout';
import { fluentComponents } from '../../fluent';

const { Text, mergeClasses } = fluentComponents;

// An empty state's words are the secondary foreground. `fg3` is the step for
// text that is subordinate to sibling content which is present -- a hint under
// a filled field, a unit beside a number -- and an empty state has no siblings,
// because it is what the region holds. The one thing that does not take it is a
// block's title, which is a heading and takes the ordinary foreground every
// other heading takes.
//
// Nothing here is transcribed. microsoft-ui-xaml's `controls/dev/` and the
// toolkit's `components/` present no empty state at all, and the Gallery's one
// instance is an unkeyed 28px page heading for "no search results" -- a
// different geometry from an empty list inside a panel. Every number below is
// ours: the 12px between the text and its action, the 480px measure, and the
// 180px a centred state fills before it starts growing its container.
const ALIGN_CLASS = {
  center: 'grid place-items-center text-center min-h-[180px]',
  start: 'grid justify-items-start',
} as const;

const STACK_ALIGN_CLASS = {
  center: 'justify-items-center',
  start: 'justify-items-start',
} as const;

// The block form: what is missing, optionally why or what to do about it, and
// optionally the control that does it. Centred in the space it is given, or
// leading-aligned for a pane whose other content is leading-aligned, where a
// centred block would read as a second column rather than as the pane's
// content.
export function EmptyState({ action, align = 'center', className, description, title }: {
  action?: ReactNode;
  align?: keyof typeof ALIGN_CLASS;
  className?: string;
  description?: ReactNode;
  title: ReactNode;
}) {
  return <div className={mergeClasses(ALIGN_CLASS[align], className)}>
    <div className={mergeClasses('grid gap-3 max-w-[480px]', STACK_ALIGN_CLASS[align])}>
      <div className={TIGHT_STACK_CLASS}>
        <Text size={300} weight="semibold">{title}</Text>
        {description !== undefined && <Text size={200} className="text-fui-fg2">{description}</Text>}
      </div>
      {action}
    </div>
  </div>;
}

// One sentence standing where content would be. It states no inset of its own:
// the inset belongs to the surface, and a flush panel, a section body and a
// legend row each hold their content off their edge by a different measure.
export function EmptyStateLine({ children, className }: { children: ReactNode; className?: string }) {
  return <Text block size={300} className={mergeClasses('text-fui-fg2', className)}>{children}</Text>;
}
