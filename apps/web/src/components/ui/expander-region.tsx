import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { makeStyles, mergeClasses } = fluentComponents;
const useStyles = makeStyles({
  // Expander's open and close, asymmetric in duration as the source is: 333ms
  // opening, 167ms closing. CSS states one duration per property rather than
  // per direction, so each direction's values sit on the rule becoming active.
  //
  // What travels is the region's own height, a simplification of ours: WinUI
  // translates the content under a composition clip. Animating the height
  // reflows everything below for the length of the transition, and the close
  // runs on the fast-out-slow-in spline rather than WinUI's
  // cubic-bezier(1, 1, 0, 1). Nothing sources that substituted spline.
  //
  // The reduce branch departs from shipped WinUI, which keeps sliding: the
  // Expander authors its motion as a VisualState storyboard, and the animations
  // gate only reaches Transition and Dynamic storyboards. A region growing from
  // nothing to full height is motion animation by WCAG's definition, so the
  // preference is honoured here.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander.xaml#L62-L90
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/vsm/VisualStateManagerActuator.cpp#L590-L609
  // https://github.com/w3c/wcag/blob/900ea026b967bc306a2cdbe0c586330a508d6759/guidelines/terms/21/motion-animation.html
  contentFrame: {
    display: 'grid',
    gridTemplateRows: '0fr',
    overflow: 'hidden',
    transitionDuration: 'var(--winui-collapse-animation-duration)',
    transitionProperty: 'grid-template-rows',
    transitionTimingFunction: 'var(--winui-control-fast-out-slow-in-easing)',
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  contentFrameOpen: {
    gridTemplateRows: '1fr',
    transitionDuration: 'var(--winui-expand-animation-duration)',
    transitionTimingFunction: 'var(--winui-control-fast-out-slow-in-easing)',
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  // Keep descendants laid out at their final height while the frame clips the
  // reveal. Sizing this child to the animated track gives responsive content
  // transient heights, which left empty bands inside the region.
  contentBody: { height: 'fit-content', minHeight: 0 },
});

export function ExpanderRegion({ open, children, onCollapsed }: { open: boolean; children: ReactNode; onCollapsed?: () => void }) {
  const styles = useStyles();
  return <div className={mergeClasses(styles.contentFrame, open && styles.contentFrameOpen)} inert={!open}
    onTransitionEnd={event => { if (event.target === event.currentTarget && !open) onCollapsed?.(); }}>
    <div className={styles.contentBody}>{children}</div>
  </div>;
}
