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
  bingAccentGradientActive,
  bingAccentGradientHover,
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
  bingOnAccentForeground,
} from './bing-chat-tokens';
import broomUrl from '../../assets/broom.svg';
import { fluentComponents } from '../../fluent';
import { Input } from '../ui/fluent-form-controls';

const { Button, Tooltip, makeStyles, tokens } = fluentComponents;

const useStyles = makeStyles({
  inputShell: {
    position: 'relative',
    // A column, as the original's container is. The field's label is an
    // `inline-grid`, which is only ever a flex item there and so is blockified
    // before it can sit on a line box; left inside a block it keeps its inline
    // level, and the line box under it reserves descender space that appears
    // and disappears with the field's own baseline — the bar grew by 5px for
    // as long as a response was streaming and snapped back when it finished.
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
    // The edge is the shadow. In dark that shadow is the ring, so a border here
    // would be a second one. The transparent outline beside it is the
    // original's, and it is the edge in forced colors: the shadow is gone there
    // while `outline-color` is force-adjusted, so the one declaration that
    // paints in neither theme is the only one that paints under the system's
    // palette. https://www.w3.org/TR/css-color-adjust-1/#forced-colors-properties
    border: 0,
    outline: '1px solid transparent',
    boxShadow: bingCardShadow,
    borderRadius: bingComposerRadiusResting,
    paddingBlock: bingComposerPaddingBlock,
    paddingInline: `${bingComposerLeadingInset} ${bingComposerTrailingInset}`,
    transitionProperty: 'box-shadow, border-radius',
    transitionDuration: bingComposerTransitionDuration,
    transitionTimingFunction: bingComposerTransitionEasing,
    // Corner radius alters perceived shape, so it goes with motion rather than
    // with colour; the shadow rides along on the one duration the pair share.
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    // Pointer, focus and content all tighten the corners rather than deepening
    // the shadow: the original lists hover, `:focus` and `has-text` together on
    // the one rule that changes the corner, and changes no shadow anywhere.
    '&:hover, &:focus-within, &[data-has-text="true"]': { borderRadius: bingComposerRadiusFilled },
  },
  // Bing grew the field with no script at all. The label is an `inline-grid`
  // whose `::after` mirrors the field's text — same wrap, same metrics, hidden
  // — and both share one grid cell, so the mirror's height is the row's height
  // and the field is stretched to it. The trailing space in the content is what
  // reserves room for a just-typed newline.
  textInput: {
    position: 'relative',
    display: 'inline-grid',
    width: '100%',
    maxHeight: bingComposerMaxHeight,
    // The mirror is hidden but still occupies its full, uncapped height. Bing
    // never had to clip it because the shipped desktop path set no ceiling at
    // all; capping the field without clipping the mirror lets it spill out of
    // the bar and draw a second edge down the page.
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
    // The original's own placeholder step is `foreground-neutral-secondary`,
    // which its dark dictionary resolves to the same value as the body
    // foreground beside it -- a placeholder there is indistinguishable from
    // typed text. The tertiary text fill is dimmer than the body in both
    // themes, which is what a placeholder has to be.
    '&::placeholder': { color: tokens.colorNeutralForeground3 },
    '&:disabled': {
      color: tokens.colorNeutralForegroundDisabled,
      cursor: 'not-allowed',
    },
  },
  // Pinned to the bar's top edge rather than laid out beside the field, so the
  // controls hold their place as the bar grows downward.
  composerRow: { gap: bingComposerColumnGap },
  controlsRight: {
    position: 'absolute',
    insetInlineEnd: 0,
    top: 0,
    display: 'flex',
    padding: bingComposerGutterPadding,
    zIndex: 2,
  },
  // The subtle fill pair -- secondary under the pointer, tertiary while the
  // button is held -- is what every icon button in the original answers with.
  // The action bar's own two are the one place it states neither, and a control
  // that dims when it is disabled and does nothing when it is pressed reads as
  // inert, so the pair is taken here:
  // https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L66-L67
  // https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/dark.scss#L58-L59
  //
  // They are the original's fills rather than the layer's neutral hover. This
  // bar sits on SolidBackgroundFillColorQuarternary, which is plain white in
  // light; WinUI's hover fill is a translucent near-white, and over white it
  // moves three values out of 255.
  imageButton: {
    height: bingComposerButtonSize,
    width: bingComposerButtonSize,
    color: bingAccentForeground,
    backgroundColor: 'transparent',
    border: 0,
    // A button carries the browser's own `1px 6px`, which leaves a content box
    // narrower than the glyph inside it. Centring then has nothing symmetric to
    // work with and the glyph settles against the leading edge.
    padding: 0,
    cursor: 'pointer',
    // Both states are held to `:enabled`. A disabled button still matches
    // `:hover` and `:active`; the original never has to say so, because it
    // takes the pointer away from the whole bar while the bar is disabled.
    '&:enabled:hover': {
      color: bingAccentForegroundHover,
      backgroundColor: 'light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06))',
    },
    '&:enabled:active': {
      backgroundColor: 'light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1))',
    },
    // Focus is the user agent's ring, as it is in the original: nothing here
    // writes an outline for the ring to lose to.
    '&:disabled': {
      color: tokens.colorNeutralForegroundDisabled,
      cursor: 'not-allowed',
    },
  },
  // The paint is a pseudo-element filling a clipping button, as the original
  // has it. That is what keeps the button unlifted, and it is also what the
  // press animation acts on: the fill scales down inside the clip while the
  // label it sits behind holds still.
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
      // Both of the things the fill changes are transitioned. The press scales
      // it and the pointer swaps its gradient, and animating one while the
      // other cuts leaves the button answering a hover instantly and a press
      // over time.
      transitionProperty: 'transform, background-image',
      transitionDuration: bingComposerTransitionDuration,
      transitionTimingFunction: bingComposerTransitionEasing,
      // The press scales the fill, which alters its perceived size, so it is
      // the kind of motion the OS setting is about. The gradient swap beside it
      // is colour and stays, so the button still answers a press when animation
      // is off -- it just answers without travel.
      '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    },
    '&:enabled:hover::before': { backgroundImage: bingAccentGradientHover },
    '&:enabled:active::before': {
      backgroundImage: bingAccentGradientActive,
      transform: 'scale3d(0.971, 0.9583, 1)',
    },
    // The resting outline is transparent, so it takes the focus ring's slot
    // without painting; the original hands the slot back at focus as a 2px ring
    // in the focus stroke colour, and without that the button answers a tab
    // with nothing at all. The same declaration is the button's forced-colors
    // edge, which is the state its gradient does not survive: `background-image`
    // computes to `none` unless it holds a `url()`.
    // https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L121
    // https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/dark.scss#L107
    '&:focus-visible': { outline: '2px solid light-dark(#111111, #FAF9F8)' },
    // Held to `:enabled` above, so a disabled button neither brightens under
    // the pointer nor scales when it is pressed on.
    '&:disabled': { opacity: 0.5, cursor: 'not-allowed' },
  },
  // Above the fill, which is absolutely positioned and would otherwise paint
  // over the label and the broom.
  newTopicContent: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  // The asset fills itself with `currentColor`, which an `<img>` throws away --
  // an external document takes no colour from the page. Drawn as a mask over
  // the button's own foreground the intent holds, and it holds in forced colors
  // too, where the button's `color` is force-adjusted and an image's pixels are
  // not.
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
