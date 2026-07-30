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
  bingBody2FontSize,
  bingBody2FontWeight,
  bingBody2LineHeight,
  bingComposerButtonSize,
  bingComposerGutterPadding,
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
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    boxShadow: tokens.shadow4,
    borderRadius: bingComposerRadiusResting,
    paddingBlock: bingComposerPaddingBlock,
    transitionProperty: 'border-color, box-shadow, border-radius',
    transitionDuration: bingComposerTransitionDuration,
    transitionTimingFunction: bingComposerTransitionEasing,
    '&:focus-within': { boxShadow: tokens.shadow8 },
    '&[data-has-text="true"]': { borderRadius: bingComposerRadiusFilled },
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
      fontSize: bingBody2FontSize,
      lineHeight: bingBody2LineHeight,
      fontWeight: bingBody2FontWeight,
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
    fontSize: bingBody2FontSize,
    lineHeight: bingBody2LineHeight,
    fontWeight: bingBody2FontWeight,
    backgroundColor: 'transparent',
    border: 0,
    outlineStyle: 'none',
    resize: 'none',
    padding: 0,
    margin: 0,
    '&::placeholder': { color: tokens.colorNeutralForeground3 },
    '&:disabled': {
      color: tokens.colorNeutralForegroundDisabled,
      cursor: 'not-allowed',
    },
  },
  // Pinned to the bar's top edge rather than laid out beside the field, so the
  // controls hold their place as the bar grows downward.
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
  newTopicButton: {
    height: bingComposeButtonSize,
    color: bingOnAccentForeground,
    backgroundImage: bingAccentGradient,
    border: 0,
    boxShadow: tokens.shadow4,
    cursor: 'pointer',
    transitionProperty: 'transform',
    transitionDuration: tokens.durationFaster,
    '&:hover': { backgroundImage: bingAccentGradientHover },
    '&:active': { backgroundImage: bingAccentGradientActive, transform: 'translateY(1px)' },
    '&:disabled': { opacity: 0.45, cursor: 'not-allowed', boxShadow: 'none' },
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
      <div className="flex items-start gap-3 min-w-0">
        <button
          type="button"
          className={`shrink-0 rounded-full px-3 flex items-center justify-center gap-1.5 font-fui-regular ${s.newTopicButton}`}
          disabled={newTopicDisabled}
          onClick={onNewTopic}
        >
          <img alt="" aria-hidden="true" className={s.broomIcon} src={broomUrl} />
          <span>{newTopicLabel}</span>
        </button>
        <div className={`min-w-0 flex-1 pl-5 pr-[88px] ${s.inputShell}`} data-has-text={draft.length > 0}>
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
            <Tooltip content={imageEnabled ? imageLabel : imageUnsupportedLabel} relationship="label">
              <button
                type="button"
                aria-label={imageLabel}
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
