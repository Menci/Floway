import { useState } from 'react';

import { DialogShell } from './dialog-shell';
import { Textarea } from './fluent-form-controls';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';

const { Button, DialogActions, DialogTitle, Field } = fluentComponents;

export function JsonObjectDialog({ onApply, onClose, open, readOnly, title, validate, value }: {
  onApply: (value: Record<string, unknown>) => void;
  onClose: () => void;
  open: boolean;
  readOnly: boolean;
  title: string;
  validate?: (value: Record<string, unknown>) => void;
  value: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const serialized = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState({ source: serialized, text: serialized });
  const [previousOpen, setPreviousOpen] = useState(open);
  if (open !== previousOpen) {
    setPreviousOpen(open);
    if (open) setDraft({ source: serialized, text: serialized });
  }
  if (draft.source !== serialized) setDraft({ source: serialized, text: serialized });
  let parsed: Record<string, unknown> | undefined;
  try {
    const candidate: unknown = JSON.parse(draft.text);
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      validate?.(record);
      parsed = record;
    }
  } catch {
    // Invalid JSON stays in the dialog draft and cannot replace model metadata.
  }
  const apply = () => {
    if (readOnly || parsed === undefined) return;
    onApply(parsed);
    onClose();
  };
  return <DialogShell
    open={open}
    width="editor"
    onOpenChange={(_, data) => { if (!data.open) onClose(); }}
    onSubmit={apply}
    title={<DialogTitle>{title}</DialogTitle>}
    actions={<DialogActions>
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      {!readOnly && <Button appearance="primary" disabled={parsed === undefined} onClick={apply}>{t('common.apply')}</Button>}
    </DialogActions>}
  >
    <Field label={title} validationState={parsed === undefined ? 'error' : undefined} validationMessage={parsed === undefined ? t('common.invalidJsonObject') : undefined}>
      <Textarea className="font-mono w-full" readOnly={readOnly} rows={14} value={draft.text} onChange={(_, data) => setDraft({ source: serialized, text: data.value })} />
    </Field>
  </DialogShell>;
}
