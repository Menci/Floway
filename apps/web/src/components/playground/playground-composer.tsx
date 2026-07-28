import {
  DismissRegular,
  ImageRegular,
  SendRegular,
  StopRegular,
} from '@fluentui/react-icons';
import { useLayoutEffect, useRef } from 'react';

import broomUrl from '../../assets/broom.svg';
import { fluentComponents } from '../../fluent';
import { Input } from '../ui/fluent-form-controls';
import { ScrollArea } from '../ui/scroll-area';

const { Button, Tooltip, makeStyles, tokens } = fluentComponents;

const useStyles = makeStyles({
  inputShell: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    boxShadow: tokens.shadow4,
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: tokens.durationFaster,
    '&:focus-within': {
      boxShadow: tokens.shadow8,
    },
  },
  textarea: {
    color: tokens.colorNeutralForeground1,
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    backgroundColor: 'transparent',
    border: 0,
    outlineStyle: 'none',
    resize: 'none',
    '&::placeholder': { color: tokens.colorNeutralForeground3 },
    '&:disabled': {
      color: tokens.colorNeutralForegroundDisabled,
      cursor: 'not-allowed',
    },
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

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
      <div className="flex items-stretch gap-2 min-w-0">
        <Button
          appearance="primary"
          className="!min-h-[44px] shrink-0"
          disabled={newTopicDisabled}
          icon={<img alt="" aria-hidden="true" className={s.broomIcon} src={broomUrl} />}
          onClick={onNewTopic}
          shape="circular"
          size="large"
        >
          {newTopicLabel}
        </Button>
        <div className={`min-w-0 flex-1 min-h-[44px] rounded-full pl-5 pr-1 py-1 flex items-center gap-2 ${s.inputShell}`}>
          <ScrollArea axes="vertical" className="min-w-0 flex-1 max-h-[144px]" noTabIndex>
            <textarea
              ref={textareaRef}
              aria-label={placeholder}
              className={`block min-w-0 w-full overflow-hidden py-[3px] ${s.textarea}`}
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
          </ScrollArea>
          <div className="shrink-0 flex items-center gap-0">
            <Tooltip content={imageEnabled ? imageLabel : imageUnsupportedLabel} relationship="label">
              <Button
                appearance="subtle"
                aria-label={imageLabel}
                disabled={!imageEnabled || sending}
                icon={<ImageRegular />}
                onClick={onToggleImage}
                shape="circular"
              />
            </Tooltip>
            <Tooltip content={sending ? stopLabel : sendLabel} relationship="label">
              <Button
                appearance="primary"
                aria-label={sending ? stopLabel : sendLabel}
                disabled={!sending && !canSend}
                icon={sending ? <StopRegular /> : <SendRegular />}
                onClick={sending ? onStop : onSend}
                shape="circular"
              />
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
