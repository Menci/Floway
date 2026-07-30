import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Text, makeStyles, mergeClasses } = fluentComponents;

// The row the Windows Settings app is built out of: an icon, a header, a
// description, and a control at the trailing edge -- and a variant of the same
// row that also opens to reveal more.
//
// This pair is the Community Toolkit's SettingsCard and SettingsExpander rather
// than anything in microsoft-ui-xaml, so the metrics below come from
// CommunityToolkit/Windows at commit c076d3dd722e43204ffbeb16057090f8498c8166,
// components/SettingsControls/. The brushes are named there and resolved here
// through the WinUI vocabulary the layer already carries.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L98-L112
const useStyles = makeStyles({
  // MinHeight 68, Padding 16, ControlCornerRadius, a 1px card stroke. The
  // header and the trailing control are 24 apart.
  card: {
    alignItems: 'center',
    backgroundColor: 'var(--winui-card-background-fill-default)',
    borderTopStyle: 'solid',
    borderRightStyle: 'solid',
    borderBottomStyle: 'solid',
    borderLeftStyle: 'solid',
    borderTopWidth: '1px',
    borderRightWidth: '1px',
    borderBottomWidth: '1px',
    borderLeftWidth: '1px',
    borderTopColor: 'var(--winui-card-stroke-default)',
    borderRightColor: 'var(--winui-card-stroke-default)',
    borderBottomColor: 'var(--winui-card-stroke-default)',
    borderLeftColor: 'var(--winui-card-stroke-default)',
    borderRadius: 'var(--winui-control-corner-radius)',
    boxSizing: 'border-box',
    columnGap: '24px',
    display: 'flex',
    minHeight: '68px',
    padding: '16px',
  },
  // A card only takes the pointer ramp when it does something when clicked.
  // The fill moves over the control's own duration; the toolkit leaves the
  // border instant.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L120-L166
  interactive: {
    cursor: 'pointer',
    transitionDuration: 'var(--winui-control-faster-animation-duration)',
    transitionProperty: 'background-color',
    '&:hover': {
      backgroundColor: 'var(--winui-control-fill-secondary)',
      // ControlElevationBorderBrush is a gradient with a heavier bottom edge,
      // which the vocabulary carries as a three-value border-color shorthand.
      // Griffel will not take a shorthand beside the longhands this rule needs,
      // so the two stops it is composed of are named directly.
      borderTopColor: 'var(--winui-control-stroke-default)',
      borderRightColor: 'var(--winui-control-stroke-default)',
      borderBottomColor: 'var(--winui-control-stroke-secondary)',
      borderLeftColor: 'var(--winui-control-stroke-default)',
    },
    '&:active': {
      backgroundColor: 'var(--winui-control-fill-tertiary)',
      borderTopColor: 'var(--winui-control-stroke-default)',
      borderRightColor: 'var(--winui-control-stroke-default)',
      borderBottomColor: 'var(--winui-control-stroke-default)',
      borderLeftColor: 'var(--winui-control-stroke-default)',
    },
  },
  text: { display: 'grid', minWidth: 0, marginInlineEnd: 'auto' },
  // SettingsCardHeaderIconMaxSize 20 with SettingsCardHeaderIconMargin 2,0,20,0.
  // The holder collapses when there is no icon, so a card without one starts
  // its text at the padding rather than at an empty column.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L23-L26
  icon: {
    alignItems: 'center',
    color: 'var(--winui-text-fill-primary)',
    display: 'flex',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    fontSize: '20px',
    justifyContent: 'center',
    marginInlineEnd: '20px',
    marginInlineStart: '2px',
    width: '20px',
  },
  // The header takes no TextBlock style in the toolkit: it inherits the control
  // content size, which is the body step at the regular weight. The description
  // is the caption, a step quieter, and the two lines carry no gap between them.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L424
  description: { color: 'var(--winui-text-fill-secondary)' },
  // The expander's header keeps the card's leading padding and gives the
  // chevron its own room at the trailing edge; open, its bottom corners square
  // off against the region below.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml
  expanderHeader: {
    backgroundColor: 'var(--winui-card-background-fill-default)',
    borderTopColor: 'var(--winui-card-stroke-default)',
    borderRightColor: 'var(--winui-card-stroke-default)',
    borderBottomColor: 'var(--winui-card-stroke-default)',
    borderLeftColor: 'var(--winui-card-stroke-default)',
    color: 'var(--winui-text-fill-primary)',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    paddingInlineEnd: '4px',
    textAlign: 'start',
    width: '100%',
  },
  expanderHeaderOpen: { borderEndStartRadius: 0, borderEndEndRadius: 0 },
  // The content region is the quieter step of the card ramp, and the edge it
  // shares with the header above is suppressed rather than drawn twice.
  content: {
    backgroundColor: 'var(--winui-card-background-fill-secondary)',
    borderRightStyle: 'solid',
    borderBottomStyle: 'solid',
    borderLeftStyle: 'solid',
    borderRightWidth: '1px',
    borderBottomWidth: '1px',
    borderLeftWidth: '1px',
    borderRightColor: 'var(--winui-card-stroke-default)',
    borderBottomColor: 'var(--winui-card-stroke-default)',
    borderLeftColor: 'var(--winui-card-stroke-default)',
    borderEndStartRadius: 'var(--winui-control-corner-radius)',
    borderEndEndRadius: 'var(--winui-control-corner-radius)',
    boxSizing: 'border-box',
    padding: '16px',
  },
  // A 32px square holding a 16px glyph. It is a ContentControl in the toolkit,
  // not a button: its background is SubtleFillColorTransparent and it states no
  // pointer states of its own, because the whole header row is the button and
  // the chevron only shows which way that button is pointing.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml#L540-L574
  chevron: {
    alignItems: 'center',
    color: 'var(--winui-text-fill-primary)',
    display: 'flex',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    height: '32px',
    justifyContent: 'center',
    width: '32px',
  },
  chevronGlyph: {
    transitionDuration: 'var(--winui-control-normal-animation-duration)',
    transitionProperty: 'rotate',
    transitionTimingFunction: 'var(--winui-control-fast-out-slow-in-easing)',
  },
  // Expander opens with a framework ExpandDownThemeAnimation, which states no
  // numbers in any dictionary, so the control's own normal duration and curve
  // stand in rather than a value invented for it. The region is a grid whose
  // single row runs from zero to `1fr`, which animates to the content's own
  // height without anything having to measure it first.
  contentFrame: {
    display: 'grid',
    gridTemplateRows: '0fr',
    transitionDuration: 'var(--winui-control-normal-animation-duration)',
    transitionProperty: 'grid-template-rows',
    transitionTimingFunction: 'var(--winui-control-fast-out-slow-in-easing)',
  },
  contentFrameOpen: { gridTemplateRows: '1fr' },
  contentClip: { minHeight: 0, overflow: 'hidden' },
  chevronOpen: { rotate: '180deg' },
});

function CardText({ description, header, icon, id }: { description?: string; header: ReactNode; icon?: ReactNode; id?: string }) {
  const s = useStyles();
  return <>
    {icon !== undefined && <span aria-hidden className={s.icon}>{icon}</span>}
    <span className={s.text}>
      <Text block id={id}>{header}</Text>
      {description !== undefined && <Text block size={200} className={s.description}>{description}</Text>}
    </span>
  </>;
}

export function SettingsCard({ action, description, header, icon, onClick }: {
  action?: ReactNode;
  description?: string;
  header: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
}) {
  const s = useStyles();
  const className = mergeClasses(s.card, onClick && s.interactive);
  const content = <>
    <CardText description={description} header={header} icon={icon} />
    {action}
  </>;
  return onClick
    ? <div className={className} onClick={onClick} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }} role="button" tabIndex={0}>{content}</div>
    : <div className={className}>{content}</div>;
}

// The disclosure and the trailing control are independent: the switch can be
// thrown without opening the row and the row can be opened without touching the
// switch. In the toolkit that falls out of routed events -- the whole header is
// a ToggleButton and the trailing control marks the pointer handled before it
// gets there -- which the DOM does not do on its own, so the chevron is its own
// button rather than the header being one.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml
export function SettingsExpander({ action, children, defaultOpen = false, description, expandLabel, header, icon }: {
  action?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  description?: string;
  expandLabel: string;
  header: ReactNode;
  icon?: ReactNode;
}) {
  const s = useStyles();
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  const headerId = useId();
  return <div>
    <button
      aria-controls={contentId}
      aria-expanded={open}
      className={mergeClasses(s.card, s.interactive, s.expanderHeader, open && s.expanderHeaderOpen)}
      onClick={() => setOpen(value => !value)}
      type="button"
    >
      <CardText description={description} header={header} icon={icon} id={headerId} />
      {/* The trailing control is inside the button, which is how the toolkit
          nests it too. There a routed event stops at the control that handled
          it; in the DOM the click would carry on to the header, so it is
          stopped here -- the switch throws without the row opening. */}
      {action !== undefined && <span onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>{action}</span>}
      <span aria-hidden className={s.chevron} title={expandLabel}>
        <svg className={mergeClasses(s.chevronGlyph, open && s.chevronOpen)} width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.15 5.65c.2-.2.5-.2.7 0L8 9.79l4.15-4.14a.5.5 0 0 1 .7.7l-4.5 4.5a.5.5 0 0 1-.7 0l-4.5-4.5a.5.5 0 0 1 0-.7Z" />
        </svg>
      </span>
    </button>
    <div className={mergeClasses(s.contentFrame, open && s.contentFrameOpen)}>
      <div className={s.contentClip}>
        <div aria-labelledby={headerId} className={s.content} hidden={!open} id={contentId} role="group">{children}</div>
      </div>
    </div>
  </div>;
}
