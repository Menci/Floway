import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { keyWriteBody, type KeySource } from './key-source';
import { KeySourceControl } from './key-source-control';
import { callApi } from '../../api/auth';
import { api } from '../../api/client';
import type { ApiKey } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { DialogShell } from '../ui/dialog-shell';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
const { Button, DialogActions, DialogTitle, Text } = fluentComponents;

export function RotateKeyDialog({
  apiKey,
  onOpenChange,
  open,
  onSaved,
}: {
  apiKey: ApiKey;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [keySource, setKeySource] = useState<KeySource>('generate');
  const [customKey, setCustomKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapName = apiKey.name;
  const rotate = async () => {
    const trimmed = customKey.trim();
    if (keySource === 'custom' && !trimmed) {
      setError(t('dashboard.apiKeys.validation.customKeyRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const handle = toasts.start(t('dashboard.apiKeys.toast.rotate.pending', { name: snapName }));
      const result = await callApi(() => api.api.keys[':id'].rotate.$post({
        param: { id: apiKey.id },
        json: keyWriteBody(keySource, trimmed),
      }));
      if (result.error) {
        handle.settle();
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      handle.succeed(t('dashboard.apiKeys.toast.rotate.success', { name: snapName }));
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogShell
      open={open}
      onOpenChange={(_, data) => !saving && onOpenChange(data.open)}
      title={<DialogTitle>{t('dashboard.apiKeys.rotate.title')}</DialogTitle>}
      actions={
        <DialogActions>
          <Button disabled={saving} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button appearance="primary" disabled={saving} onClick={() => void rotate()}>
            {saving ? t('dashboard.apiKeys.actions.saving') : t('dashboard.apiKeys.actions.rotate')}
          </Button>
        </DialogActions>
      }
    >
      <Text size={200} className="text-fui-fg2 leading-[1.35] m-0">
        {t('dashboard.apiKeys.rotate.message', { name: snapName })}
      </Text>
      <KeySourceControl
        customKey={customKey}
        disabled={saving}
        error={keySource === 'custom' ? error ?? undefined : undefined}
        onCustomKeyChange={setCustomKey}
        onSourceChange={value => { setKeySource(value); setError(null); }}
        source={keySource}
      />
      {error && keySource !== 'custom' && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    </DialogShell>
  );
}
