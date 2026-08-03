import {
  DismissRegular,
  ImageRegular,
  SendRegular,
  StopRegular,
} from '@fluentui/react-icons';

import {
  bingAccentForeground,
  bingAccentForegroundHover,
  bingAccentGradient,
  bingAccentWashActive,
  bingAccentWashHover,
  bingAccentWashResting,
  bingCardShadow,
  bingComposerFontSize,
  bingComposerFontWeight,
  bingComposerLineHeight,
  bingComposerButtonSize,
  bingComposerColumnGap,
  bingComposerGutterPadding,
  bingComposerLeadingInset,
  bingComposerTrailingInset,
  bingComposerMaxHeight,
  bingComposerPaddingBlock,
  bingComposerRadiusFilled,
  bingComposerRadiusResting,
  bingComposerTransitionDuration,
  bingComposerTransitionEasing,
  bingComposeButtonSize,
  bingComposePressScale,
  bingOnAccentForeground,
} from './bing-chat-tokens';
import broomUrl from '../../assets/broom.svg';
import { fluentComponents } from '../../fluent';
import { Input } from '../ui/fluent-form-controls';

const { Button, Tooltip, makeStyles, tokens } = fluentComponents;

const useStyles = makeStyles({
  inputShell: {
    position: 'relative',
    // A column, as the original's container is: the field's label is an
    // `inline-grid`, only ever a flex item there and so blockified. Left inside
    // a block it keeps its inline level and the line box under it reserves
    // descender space, which grew the bar by 5px while a response streamed.
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
    // The edge is the shadow, which in dark is itself the ring, so a border
    // would be a second one. The transparent outline beside it is the edge in
    // forced colors, where the shadow is gone and `outline-color` is
    // force-adjusted:
    // https://www.w3.org/TR/css-color-adjust-1/#forced-colors-properties
    border: 0,
    outline: '1px solid transparent',
    ...bingCardShadow,
    borderRadius: bingComposerRadiusResting,
    paddingBlock: bingComposerPaddingBlock,
    paddingInline: `${bingComposerLeadingInset} ${bingComposerTrailingInset}`,
    transitionProperty: 'box-shadow, border-radius',
    transitionDuration: bingComposerTransitionDuration,
    transitionTimingFunction: bingComposerTransitionEasing,
    // Corner radius alters perceived shape, so it is held to the motion
    // setting rather than to colour.
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    // The original lists hover, `:focus` and `has-text` on the one rule that
    // changes the corner, and changes no shadow anywhere.
    '&:hover, &:focus-within, &[data-has-text="true"]': { borderRadius: bingComposerRadiusFilled },
  },
  // Bing grew the field with no script: the `::after` mirrors the field's text
  // in the same grid cell, so the mirror's height is the row's height and the
  // field stretches to it. The trailing space reserves room for a just-typed
  // newline.
  textInput: {
    position: 'relative',
    display: 'inline-grid',
    width: '100%',
    maxHeight: bingComposerMaxHeight,
    // The mirror is hidden but still occupies its full, uncapped height, so
    // capping the field without clipping it lets it spill out of the bar and
    // draw a second edge down the page.
    overflow: 'hidden',
    '&::after': {
      content: 'attr(data-input) " "',
      visibility: 'hidden',
      whiteSpace: 'pre-wrap',
      gridArea: '1 / 1',
      wordBreak: 'break-word',
      fontFamily: 'inherit',
      fontSize: bingComposerFontSize,
      lineHeight: bingComposerLineHeight,
      fontWeight: bingComposerFontWeight,
    },
  },
  textarea: {
    gridArea: '1 / 1',
    position: 'relative',
    maxHeight: bingComposerMaxHeight,
    overflowX: 'hidden',
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: tokens.colorNeutralForeground1,
    fontFamily: 'inherit',
    fontSize: bingComposerFontSize,
    lineHeight: bingComposerLineHeight,
    fontWeight: bingComposerFontWeight,
    backgroundColor: 'transparent',
    border: 0,
    outlineStyle: 'none',
    resize: 'none',
    padding: 0,
    margin: 0,
    // The original's `foreground-neutral-secondary` resolves in dark to the
    // body foreground beside it, making a placeholder indistinguishable from
    // typed text; the tertiary text fill is dimmer than the body in both themes.
    '&::placeholder': { color: tokens.colorNeutralForeground3 },
    '&:disabled': {
      color: tokens.colorNeutralForegroundDisabled,
      cursor: 'not-allowed',
    },
  },
  // Pinned to the bar's top edge so the controls hold their place as the bar
  // grows downward.
  composerRow: { gap: bingComposerColumnGap },
  controlsRight: {
    position: 'absolute',
    insetInlineEnd: 0,
    top: 0,
    display: 'flex',
    padding: bingComposerGutterPadding,
    zIndex: 2,
  },
  // The subtle fill pair every icon button in the original answers with. The
  // action bar's own two state neither, and a control that dims when disabled
  // and does nothing when pressed reads as inert, so the pair is taken here:
  // https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L66-L67
  // https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/dark.scss#L58-L59
  // They are the original's fills rather than the layer's neutral hover, which
  // is a translucent near-white and moves three values out of 255 over the
  // plain white this bar sits on.
  imageButton: {
    height: bingComposerButtonSize,
    width: bingComposerButtonSize,
    color: bingAccentForeground.light,
    '@media (prefers-color-scheme: dark)': { color: bingAccentForeground.dark },
    backgroundColor: 'transparent',
    border: 0,
    // A button carries the browser's own `1px 6px`, leaving a content box
    // narrower than the glyph, which then settles against the leading edge.
    padding: 0,
    cursor: 'pointer',
    // The layer's own pointer fill duration, carrying the foreground as well as
    // the fill, which WinUI's button does not: here the pair is one accent step
    // and its disc, and a glyph that snaps under an easing disc reads as two
    // controls.
    transitionProperty: 'color, background-color',
    transitionDuration: 'var(--winui-control-faster-animation-duration)',
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    // A disabled button still matches `:hover` and `:active`; the original
    // never has to say so, because it takes the pointer away from the whole bar.
    '&:enabled:hover': {
      color: bingAccentForegroundHover.light,
      backgroundColor: 'rgba(0, 0, 0, 0.06)',
      '@media (prefers-color-scheme: dark)': {
        color: bingAccentForegroundHover.dark,
        backgroundColor: 'rgba(255, 255, 255, 0.06)',
      },
    },
    '&:enabled:active': {
      backgroundColor: 'rgba(0, 0, 0, 0.1)',
      '@media (prefers-color-scheme: dark)': { backgroundColor: 'rgba(255, 255, 255, 0.1)' },
    },
    // Focus is the user agent's ring, as in the original: nothing here writes
    // an outline for the ring to lose to.
    '&:disabled': {
      color: tokens.colorNeutralForegroundDisabled,
      cursor: 'not-allowed',
    },
  },
  // A pair of pseudo-elements filling a clipping button, as the original has
  // it: the fill scales down inside the clip while the label holds still.
  //
  // The original states the whole fill as one `background`. It is split here --
  // `::before` holds the gradient, the same in every state, and `::after` the
  // black wash, whose alpha is all hover and active change. Both take the press
  // scale, so the fill stays one shape while it runs.
  newTopicButton: {
    position: 'relative',
    height: bingComposeButtonSize,
    fontSize: bingComposerFontSize,
    lineHeight: bingComposerLineHeight,
    fontWeight: bingComposerFontWeight,
    color: bingOnAccentForeground,
    backgroundColor: 'transparent',
    border: 0,
    outline: '1px solid transparent',
    overflow: 'hidden',
    cursor: 'pointer',
    '&::before': {
      content: '""',
      position: 'absolute',
      inset: 0,
      borderRadius: 'inherit',
      backgroundImage: bingAccentGradient,
      transitionProperty: 'transform',
      transitionDuration: bingComposerTransitionDuration,
      transitionTimingFunction: bingComposerTransitionEasing,
      // The press alters the fill's perceived size, so the OS motion setting
      // applies and it is answered without travel.
      '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    },
    '&::after': {
      content: '""',
      position: 'absolute',
      inset: 0,
      borderRadius: 'inherit',
      backgroundColor: bingAccentWashResting,
      // Two departures from the capture, both about this button's pointer
      // feedback. Balanced writes its wash under the gradient, where the
      // opaque fill hides it -- followed literally, the composer's primary
      // button would darken on neither hover nor press; the wash sits above
      // the gradient here, the order Creative and Precise write.
      // https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/dark.scss#L268-L300
      // Its alpha is then interpolated over the layer's own button fill
      // duration, where the capture swaps an uninterpolatable background value
      // and snaps. The press keeps the original's timing, and under the OS
      // motion setting both collapse.
      transitionProperty: 'transform, background-color',
      transitionDuration: `${bingComposerTransitionDuration}, var(--winui-control-faster-animation-duration)`,
      transitionTimingFunction: `${bingComposerTransitionEasing}, ease`,
      '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    },
    '&:enabled:hover::after': { backgroundColor: bingAccentWashHover },
    '&:enabled:active::before': { transform: bingComposePressScale },
    '&:enabled:active::after': {
      backgroundColor: bingAccentWashActive,
      transform: bingComposePressScale,
    },
    // The resting outline is transparent, taking the focus ring's slot without
    // painting; the original hands it back at focus as a 2px ring. The same
    // declaration is the forced-colors edge, the one state the gradient does
    // not survive -- `background-image` computes to `none` without a `url()`.
    // https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L121
    // https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/dark.scss#L107
    '&:focus-visible': { outline: '2px solid #111111', '@media (prefers-color-scheme: dark)': { outline: '2px solid #FAF9F8' } },
    // Held to `:enabled` above, so a disabled button neither darkens nor
    // scales.
    '&:disabled': { opacity: 0.5, cursor: 'not-allowed' },
  },
  // Above both fill layers: the wash is generated after this one and would
  // otherwise paint over the label as well as over the gradient.
  newTopicContent: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  // The asset fills itself with `currentColor`, which an `<img>` throws away.
  // A mask over the button's foreground keeps it, and keeps it in forced colors
  // too, where `color` is force-adjusted and an image's pixels are not.
  broomIcon: {
    display: 'block',
    backgroundColor: 'currentColor',
    maskImage: `url("${broomUrl}")`,
    maskSize: '100% 100%',
    height: '21px',
    width: '23px',
  },
});

interface PlaygroundComposerProps {
  canSend: boolean;
  draft: string;
  imageEnabled: boolean;
  imageLabel: string;
  imagePlaceholder: string;
  imageUnsupportedLabel: string;
  imageUrl: string;
  newTopicDisabled: boolean;
  newTopicLabel: string;
  onNewTopic: () => void;
  onDraftChange: (value: string) => void;
  onImageUrlChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onToggleImage: () => void;
  placeholder: string;
  sendLabel: string;
  sending: boolean;
  showImage: boolean;
  stopLabel: string;
  cancelLabel: string;
}

export function PlaygroundComposer({
  canSend,
  cancelLabel,
  draft,
  imageEnabled,
  imageLabel,
  imagePlaceholder,
  imageUnsupportedLabel,
  imageUrl,
  newTopicDisabled,
  newTopicLabel,
  onNewTopic,
  onDraftChange,
  onImageUrlChange,
  onSend,
  onStop,
  onToggleImage,
  placeholder,
  sendLabel,
  sending,
  showImage,
  stopLabel,
}: PlaygroundComposerProps) {
  const s = useStyles();
  const imageActionLabel = imageEnabled ? imageLabel : imageUnsupportedLabel;

  return (
    <div className="grid gap-2">
      {showImage && (
        <div className="flex gap-2 px-1">
          <Input
            aria-label={imagePlaceholder}
            className="!flex-1"
            type="url"
            value={imageUrl}
            placeholder={imagePlaceholder}
            onChange={(_, data) => onImageUrlChange(data.value)}
          />
          <Tooltip content={cancelLabel} relationship="label">
            <Button
              appearance="subtle"
              aria-label={cancelLabel}
              icon={<DismissRegular />}
              onClick={onToggleImage}
            />
          </Tooltip>
        </div>
      )}
      <div className={`flex items-start min-w-0 ${s.composerRow}`}>
        <button
          type="button"
          className={`shrink-0 rounded-full px-3 flex items-center justify-center font-fui-regular ${s.newTopicButton}`}
          disabled={newTopicDisabled}
          onClick={onNewTopic}
        >
          <span className={s.newTopicContent}>
            <span aria-hidden="true" className={s.broomIcon} />
            <span>{newTopicLabel}</span>
          </span>
        </button>
        <div className={`min-w-0 flex-1 ${s.inputShell}`} data-has-text={draft.length > 0}>
          <label className={s.textInput} data-input={draft}>
            <textarea
              aria-label={placeholder}
              className={`block min-w-0 w-full ${s.textarea}`}
              disabled={sending}
              placeholder={placeholder}
              rows={1}
              value={draft}
              onChange={event => onDraftChange(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (canSend) onSend();
                }
              }}
            />
          </label>
          <div className={s.controlsRight}>
            <Tooltip content={imageActionLabel} relationship="label">
              <button
                type="button"
                aria-label={imageActionLabel}
                className={`shrink-0 rounded-full grid place-items-center text-fui-base600 ${s.imageButton}`}
                disabled={!imageEnabled || sending}
                onClick={onToggleImage}
              >
                <ImageRegular />
              </button>
            </Tooltip>
            <Tooltip content={sending ? stopLabel : sendLabel} relationship="label">
              <button
                type="button"
                aria-label={sending ? stopLabel : sendLabel}
                className={`shrink-0 rounded-full grid place-items-center text-fui-base500 ${s.imageButton}`}
                disabled={!sending && !canSend}
                onClick={sending ? onStop : onSend}
              >
                {sending ? <StopRegular /> : <SendRegular />}
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
