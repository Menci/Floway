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
    backgroundColor: 'var(--colorNeutralBackground1)',
    // The edge is the shadow. In dark that shadow is the ring, so a border
    // here would be a second one.
    border: 0,
    outline: '1px solid transparent',
    boxShadow: bingCardShadow,
    borderRadius: bingComposerRadiusResting,
    paddingBlock: bingComposerPaddingBlock,
    paddingInline: `${bingComposerLeadingInset} ${bingComposerTrailingInset}`,
    transitionProperty: 'box-shadow, border-radius',
    transitionDuration: bingComposerTransitionDuration,
    transitionTimingFunction: bingComposerTransitionEasing,
    // Focus tightens the corners rather than deepening the shadow: the
    // original lists `:focus` alongside `has-text` on the one rule that
    // changes the corner, and changes no shadow anywhere.
    '&:focus-within, &[data-has-text="true"]': { borderRadius: bingComposerRadiusFilled },
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
    color: 'var(--colorNeutralForeground1)',
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
    '&::placeholder': { color: 'var(--colorNeutralForeground3)' },
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
    '&:hover': {
      color: bingAccentForegroundHover,
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
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
      transitionProperty: 'transform',
      transitionDuration: bingComposerTransitionDuration,
      transitionTimingFunction: bingComposerTransitionEasing,
    },
    '&:hover::before': { backgroundImage: bingAccentGradientHover },
    '&:active::before': {
      backgroundImage: bingAccentGradientActive,
      transform: 'scale3d(0.971, 0.9583, 1)',
    },
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
  broomIcon: {
    display: 'block',
    filter: 'brightness(0) invert(1)',
    height: '21px',
    width: '23px',
  },
});

type PlaygroundComposerProps = {
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
};

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
            <img alt="" aria-hidden="true" className={s.broomIcon} src={broomUrl} />
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
