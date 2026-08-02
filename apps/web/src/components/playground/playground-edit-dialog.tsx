import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PlaygroundMessage } from './request';
import { fluentComponents } from '../../fluent';
import { DialogShell } from '../ui/dialog-shell';
import { Input, Textarea } from '../ui/fluent-form-controls';

const { Button, DialogActions, DialogTitle, Field } = fluentComponents;

export interface PlaygroundMessageDraft {
  imageUrl: string;
  text: string;
}

// Editing a transcript entry asks the one question the rest of the console asks
// through a dialog -- fill a short form, then cancel or commit -- so it is that
// dialog. Inline it could not be: the transcript is pinned to Bing's design and
// withdraws from the WinUI restyle for its whole subtree, which a descendant
// cannot rejoin, leaving every control in an inline editor a bare Fluent one.
// See ../../winui/tokens.ts on the opt-out, which a portalled surface escapes.
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

  return (
    <DialogShell
      open={open}
      actions={<DialogActions>
        <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
        <Button appearance="primary" disabled={!text.trim() && !imageUrl.trim()} type="submit">
          {t('dashboard.playground.actions.save')}
        </Button>
      </DialogActions>}
      onOpenChange={(_, data) => onOpenChange(data.open)}
      onSubmit={() => onSave({ imageUrl, text })}
      title={<DialogTitle>{t('dashboard.playground.edit.title')}</DialogTitle>}
    >
      <Field label={t('dashboard.playground.edit.message')}>
        <Textarea autoFocus resize="vertical" rows={8} value={text} onChange={(_, data) => setText(data.value)} />
      </Field>
      {message.role === 'user' && imageEnabled && (
        <Field label={t('dashboard.playground.edit.imageUrl')}>
          <Input type="url" value={imageUrl} placeholder={t('dashboard.playground.imagePlaceholder')} onChange={(_, data) => setImageUrl(data.value)} />
        </Field>
      )}
    </DialogShell>
  );
}
