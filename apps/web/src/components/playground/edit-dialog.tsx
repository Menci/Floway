import { useCallback, useState } from 'react';

import type { PlaygroundMessage } from './request';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { Input, Textarea } from '../ui/fluent-form-controls';
import { useDiscardGuard } from '../ui/use-discard-guard';

const { Button, DialogActions, DialogTitle, Field } = fluentComponents;

export interface PlaygroundMessageDraft {
  imageUrl: string;
  text: string;
}

// Editing a transcript entry asks the one question the rest of the console asks
// through a dialog -- fill a short form, then cancel or commit -- so it is that
// dialog rather than an editor opened inside the bubble.
export function PlaygroundEditDialog({ imageEnabled, message, onOpenChange, onSave, open }: {
  imageEnabled: boolean;
  message: PlaygroundMessage;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: PlaygroundMessageDraft) => void;
  open: boolean;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(message.text);
  const [imageUrl, setImageUrl] = useState(message.imageUrl ?? '');
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({ onClose: close, values: { imageUrl, text } });

  return (
    <>{discardConfirmation}<DialogShell
      open={open}
      actions={<DialogActions>
        <Button onClick={requestClose}>{t('common.cancel')}</Button>
        <Button appearance="primary" disabled={!text.trim() && !imageUrl.trim()} type="submit">
          {t('dashboard.playground.actions.save')}
        </Button>
      </DialogActions>}
      onOpenChange={(_, data) => { if (!data.open) requestClose(); }}
      onSubmit={() => onSave({ imageUrl, text })}
      title={<DialogTitle>{t('dashboard.playground.edit.title')}</DialogTitle>}
    >
      <Field label={t('dashboard.playground.edit.message')}>
        <Textarea autoFocus rows={8} value={text} onChange={(_, data) => setText(data.value)} />
      </Field>
      {message.role === 'user' && imageEnabled && (
        <Field label={t('dashboard.playground.edit.imageUrl')}>
          <Input type="url" value={imageUrl} placeholder={t('dashboard.playground.imagePlaceholder')} onChange={(_, data) => setImageUrl(data.value)} />
        </Field>
      )}
    </DialogShell></>
  );
}
