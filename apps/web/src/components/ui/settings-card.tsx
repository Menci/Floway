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
      borderTopColor: 'var(--winui-control-elevation-border-color)',
      borderRightColor: 'var(--winui-control-elevation-border-color)',
      borderBottomColor: 'var(--winui-control-elevation-border-color)',
      borderLeftColor: 'var(--winui-control-elevation-border-color)',
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
  // The header takes no TextBlock style in the toolkit: it inherits the control
  // content size, which is the body step at the regular weight. The description
  // is the caption, a step quieter, and the two lines carry no gap between them.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L424
  description: { color: 'var(--winui-text-fill-secondary)' },
  // The expander's header keeps the card's leading padding and gives the
  // chevron its own room at the trailing edge; open, its bottom corners square
  // off against the region below.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml
  expanderHeader: { paddingInlineEnd: '4px' },
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
  // A 32px square holding a 16px glyph, the way the toolkit sizes it, sitting
  // after the trailing control rather than before it.
  chevron: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderTopStyle: 'none',
    borderRightStyle: 'none',
    borderBottomStyle: 'none',
    borderLeftStyle: 'none',
    borderRadius: 'var(--winui-control-corner-radius)',
    color: 'var(--winui-text-fill-primary)',
    cursor: 'pointer',
    display: 'flex',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    height: '32px',
    justifyContent: 'center',
    padding: 0,
    width: '32px',
    '&:hover': { backgroundColor: 'var(--winui-subtle-fill-secondary)' },
    '&:active': { backgroundColor: 'var(--winui-subtle-fill-tertiary)' },
  },
  chevronGlyph: {
    transitionDuration: 'var(--winui-control-faster-animation-duration)',
    transitionProperty: 'rotate',
  },
  chevronOpen: { rotate: '180deg' },
});

function CardText({ description, header, id }: { description?: string; header: ReactNode; id?: string }) {
  const s = useStyles();
  return <span className={s.text}>
    <Text block id={id}>{header}</Text>
    {description !== undefined && <Text block size={200} className={s.description}>{description}</Text>}
  </span>;
}

export function SettingsCard({ action, description, header, onClick }: {
  action?: ReactNode;
  description?: string;
  header: ReactNode;
  onClick?: () => void;
}) {
  const s = useStyles();
  const className = mergeClasses(s.card, onClick && s.interactive);
  const content = <>
    <CardText description={description} header={header} />
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
export function SettingsExpander({ action, children, defaultOpen = false, description, expandLabel, header }: {
  action?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  description?: string;
  expandLabel: string;
  header: ReactNode;
}) {
  const s = useStyles();
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  const headerId = useId();
  return <div>
    <div className={mergeClasses(s.card, s.expanderHeader, open && s.expanderHeaderOpen)}>
      <CardText description={description} header={header} id={headerId} />
      {action}
      <button
        aria-controls={contentId}
        aria-expanded={open}
        aria-label={expandLabel}
        className={s.chevron}
        onClick={() => setOpen(value => !value)}
        type="button"
      >
        <svg aria-hidden className={mergeClasses(s.chevronGlyph, open && s.chevronOpen)} width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.15 5.65c.2-.2.5-.2.7 0L8 9.79l4.15-4.14a.5.5 0 0 1 .7.7l-4.5 4.5a.5.5 0 0 1-.7 0l-4.5-4.5a.5.5 0 0 1 0-.7Z" />
        </svg>
      </button>
    </div>
    {open && <div aria-labelledby={headerId} className={s.content} id={contentId} role="group">{children}</div>}
  </div>;
}
