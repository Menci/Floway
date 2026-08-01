import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';

const { Switch, Text, makeStyles, mergeClasses, shorthands } = fluentComponents;

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
  // MinHeight 68, Padding 16, ControlCornerRadius, a 1px card stroke.
  //
  // The 24 between the text and the trailing control is a margin on the text
  // block rather than a gap on the row: a gap falls between every pair of
  // children, so it also landed between the icon and the text, which already
  // states its own 20 and ended up 44 away.
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
    ...shorthands.borderColor('var(--winui-card-stroke-default)'),
    borderRadius: 'var(--winui-control-corner-radius)',
    boxSizing: 'border-box',
    display: 'flex',
    minHeight: '68px',
    padding: '16px',
  },
  // A card only takes the pointer ramp when it does something when clicked.
  // The fill moves over the control's own duration; the toolkit leaves the
  // border instant.
  //
  // No reduce branch, deliberately, and this is a departure: WinUI gates its
  // BrushTransition on the same setting it gates motion with, so a real card
  // would cross-fade instantly. WCAG's definition of motion animation excludes
  // changes -- such as changes of colour or opacity -- that do not alter the
  // perceived size, shape, position or depth of the element, so an 83ms fill
  // change is not what the preference is about, and suppressing it buys nothing
  // while costing the clearest hover signal the card has.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L120-L166
  // https://github.com/w3c/wcag/blob/900ea026b967bc306a2cdbe0c586330a508d6759/guidelines/terms/21/motion-animation.html
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
      ...shorthands.borderColor('var(--winui-control-stroke-default)'),
    },
  },
  text: { display: 'grid', minWidth: 0, marginInlineEnd: 'auto', paddingInlineEnd: '24px' },
  // SettingsCardHeaderIconMaxSize 20 with SettingsCardHeaderIconMargin 2,0,20,0.
  // The holder collapses when there is no icon, so a card without one starts
  // its text at the padding rather than at an empty column.
  //
  // The 20 is what the glyph's INK fills, not the box it is laid out in. WinUI
  // holds the icon in a Viewbox, which scales the drawing until it meets that
  // bound; a Fluent icon cut for 20 carries its ink in the middle 16 of a 20
  // unit box and would come out a quarter small. The 24 cut carries 20 units of
  // ink, which is the same drawing at the size the Viewbox would have produced.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L103-L106
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L398-L402
  icon: {
    alignItems: 'center',
    color: 'var(--winui-text-fill-primary)',
    display: 'flex',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    fontSize: '24px',
    justifyContent: 'center',
    // A Viewbox bounds the drawing, not the box it is laid out in. The 24 cut
    // carries 20 units of ink in a 24 unit box, so rendering it at 24 puts 20
    // pixels of ink on screen -- which is the bound.
    '& svg': { height: '24px', width: '24px' },
    marginInlineEnd: '20px',
    marginInlineStart: '2px',
    width: '24px',
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
    ...shorthands.borderColor('var(--winui-card-stroke-default)'),
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
  // The chevron's box is 32 square around a 16px glyph, so it carries eight
  // pixels of its own air on every side, and that air is what spaces the glyph
  // rather than any margin.
  //
  // The header's right padding is 4 where a plain card's is 16, and the
  // difference is the eight of air plus the four that remains: the glyph ends
  // up twelve from the card's edge and eight from whatever precedes it, which
  // is why it reads as centred between the two without either gap being
  // written down. An explicit margin on top of that is what pushed it off
  // centre in both directions while I was moving one.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml#L15
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml#L540-L560
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L99
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
    // WinUI's expander chevron is an AnimatedIcon, and AnimatedIcon is gated on
    // UISettings.AnimationsEnabled: with animations off it displays the final
    // frame of the transition rather than playing it. The chevron lands in its
    // correct orientation either way, which is what carries the state.
    // https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/animated-icon
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedIcon.cpp#L432-L444
    '@media screen and (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  // Expander's open and close, which are asymmetric in both terms: 333ms on the
  // fast-out-slow-in spline opening, 167ms on a spline that leaves at once and
  // arrives slowly closing. CSS states one duration per transitioned property
  // rather than one per direction, so each direction's values sit on the rule
  // that is becoming active -- the closed base here, the open modifier below.
  //
  // WinUI translates the content by its own measured height under a static
  // clip. The region is a grid whose single row runs from zero to `1fr`
  // instead, which reaches the content's own height without anything having to
  // measure it first and reads the same.
  //
  // The reduce branch departs from shipped WinUI, which keeps sliding: the
  // Expander authors its motion as a VisualState storyboard rather than a
  // VisualTransition, and the gate only reaches Transition and Dynamic
  // storyboards, so the content still travels with animations off. That is an
  // unactioned bug -- microsoft-ui-xaml#3279 asks for exactly this gate, and a
  // WinUI PM called the general case a framework bug -- not a design, and a
  // region that grows from nothing to its full height is motion animation by
  // WCAG's own definition, which turns on perceived size and position.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander.xaml#L62-L90
  // https://github.com/microsoft/microsoft-ui-xaml/issues/3279
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/vsm/VisualStateManagerActuator.cpp#L590-L609
  contentFrame: {
    display: 'grid',
    gridTemplateRows: '0fr',
    transitionDuration: 'var(--winui-collapse-animation-duration)',
    transitionProperty: 'grid-template-rows',
    transitionTimingFunction: 'var(--winui-collapse-easing)',
    '@media screen and (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  contentFrameOpen: {
    gridTemplateRows: '1fr',
    transitionDuration: 'var(--winui-expand-animation-duration)',
    transitionTimingFunction: 'var(--winui-control-fast-out-slow-in-easing)',
    '@media screen and (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  contentClip: { minHeight: 0, overflow: 'hidden' },
  chevronOpen: { rotate: '180deg' },
  // A switch in a settings row reads its own state out, and the reading sits
  // BEFORE the track. WinUI's own ToggleSwitch template puts OnContent after it
  // -- column 2 of a three column grid, twelve along from the track in column 0
  // -- and a SettingsCard overrides exactly that: it pushes an implicit
  // ToggleSwitch style into its own content scope whose retemplate keeps the
  // same three columns and swaps what sits in them, the presenters taking
  // column 0 and the track column 2. The ordering is structural, which is why
  // it survives the row wrapping and the control moving below the text.
  //
  // That style also compacts the control: MinWidth 0 and Height 36, against the
  // 154 and the content-sized height a standalone switch takes.
  //
  // Fluent's switch carries eight pixels of margin around the track for a label
  // slot this one does not use; the trailing side is removed so the track ends
  // where the card's padding does.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L140-L145
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L483-L492
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L1000-L1053
  switchRow: {
    alignItems: 'center',
    columnGap: '12px',
    display: 'flex',
    height: '36px',
    justifyContent: 'flex-end',
    minWidth: 0,
  },
});

function CardText({ description, header, icon, id }: { description?: string; header: ReactNode; icon?: ReactNode; id?: string }) {
  const styles = useStyles();
  return <>
    {icon !== undefined && <span aria-hidden className={styles.icon}>{icon}</span>}
    <span className={styles.text}>
      <Text block id={id}>{header}</Text>
      {description !== undefined && <Text block size={200} className={styles.description}>{description}</Text>}
    </span>
  </>;
}

// A switch that reads its own state out, the way every toggle in a settings row
// does.
export function SettingsSwitch({ checked, disabled, label, onChange }: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  return <span className={styles.switchRow}>
    <Text>{t(checked ? 'common.on' : 'common.off')}</Text>
    <Switch aria-label={label} checked={checked} disabled={disabled} onChange={(_, data) => onChange(data.checked)} />
  </span>;
}

export function SettingsCard({ action, description, header, icon, onClick }: {
  action?: ReactNode;
  description?: string;
  header: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
}) {
  const styles = useStyles();
  const className = mergeClasses(styles.card, onClick && styles.interactive);
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
export function SettingsExpander({ action, children, defaultOpen = false, description, expandLabel, header, icon, revealOn, toggledOn }: {
  action?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  description?: string;
  expandLabel: string;
  header: ReactNode;
  icon?: ReactNode;
  /**
   * Whether the region currently holds something the operator has to see --
   * a validation message that refused their submit. Rising, it opens the row:
   * an answer behind a closed disclosure is an answer nobody reads, and the
   * control that produced it is in here too. Falling, it does nothing, because
   * closing the row while someone is still editing inside it takes their work
   * off the screen mid-correction.
   */
  revealOn?: boolean;
  /**
   * The state of the switch in `action`, when there is one. Throwing it opens
   * the row, and turning it off closes the row again -- what the switch admits
   * is what the region configures, so there is nothing to read while it is off
   * and nothing to hide once it is on. The disclosure stays independent either
   * way: the row can still be opened and closed by hand without touching the
   * switch, and this only moves it when the switch itself changes.
   */
  toggledOn?: boolean;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(defaultOpen);
  const [toggleWas, setToggleWas] = useState(toggledOn);
  if (toggledOn !== undefined && toggledOn !== toggleWas) {
    setToggleWas(toggledOn);
    setOpen(toggledOn);
  }
  const [revealWas, setRevealWas] = useState(revealOn);
  if (revealOn !== revealWas) {
    setRevealWas(revealOn);
    if (revealOn === true) setOpen(true);
  }
  const contentId = useId();
  const headerId = useId();
  return <div>
    <button
      aria-controls={contentId}
      aria-expanded={open}
      className={mergeClasses(styles.card, styles.interactive, styles.expanderHeader, open && styles.expanderHeaderOpen)}
      onClick={() => setOpen(value => !value)}
      type="button"
    >
      <CardText description={description} header={header} icon={icon} id={headerId} />
      {/* The trailing control is inside the button, which is how the toolkit
          nests it too. There a routed event stops at the control that handled
          it; in the DOM the click would carry on to the header, so it is
          stopped here -- the switch throws without the row opening. */}
      {action !== undefined && <span onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>{action}</span>}
      <span aria-hidden className={styles.chevron} title={expandLabel}>
        <svg className={mergeClasses(styles.chevronGlyph, open && styles.chevronOpen)} width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.15 5.65c.2-.2.5-.2.7 0L8 9.79l4.15-4.14a.5.5 0 0 1 .7.7l-4.5 4.5a.5.5 0 0 1-.7 0l-4.5-4.5a.5.5 0 0 1 0-.7Z" />
        </svg>
      </span>
    </button>
    <div className={mergeClasses(styles.contentFrame, open && styles.contentFrameOpen)}>
      <div className={styles.contentClip}>
        {/* Closed, the region is inert rather than hidden. `hidden` is
            `display: none`, which takes the content out of flow in the same
            frame the row starts collapsing, leaving the row nothing to
            animate towards -- it just vanished. `inert` takes it out of the
            tab order and away from assistive technology without touching
            layout, so the row can close over its own duration. */}
        <div aria-labelledby={headerId} className={styles.content} id={contentId} inert={!open} role="group">{children}</div>
      </div>
    </div>
  </div>;
}
