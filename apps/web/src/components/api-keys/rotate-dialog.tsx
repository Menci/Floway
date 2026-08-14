import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { keySourceFields, keyWriteBody, refineKeySource, type KeySourceValues } from './source';
import { KeySourceControl } from './source-field';
import { api, callApi } from '../../api/client';
import type { ApiKey } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { useDiscardGuard } from '../ui/use-discard-guard';

const { Button, DialogActions, DialogTitle, Text } = fluentComponents;

const rotateSchema = z.object(keySourceFields).superRefine(refineKeySource);

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
  const { control, formState: { errors }, handleSubmit, setValue } = useForm<KeySourceValues>({
    defaultValues: { customKey: '', keySource: 'generate' },
    resolver: zodResolver(rotateSchema),
  });
  const values = useWatch({ control }) as KeySourceValues;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({ onClose: close, values });
  const snapName = apiKey.name;
  const rotate = async (values: KeySourceValues) => {
    // disabledFocusable leaves the submit button submittable while the rotation
    // is in flight, so this guard is what makes a second press inert.
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const handle = toasts.start(t('dashboard.apiKeys.toast.rotate.pending', { name: snapName }));
      const result = await callApi(() => api.api.keys[':id'].rotate.$post({
        param: { id: apiKey.id },
        json: keyWriteBody(values.keySource, values.customKey),
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
    <>{discardConfirmation}<DialogShell
      open={open}
      onOpenChange={(_, data) => { if (!data.open && !saving) requestClose(); }}
      onSubmit={() => void handleSubmit(rotate)()}
      title={<DialogTitle>{t('dashboard.apiKeys.rotate.title')}</DialogTitle>}
      actions={
        <DialogActions>
          <Button disabled={saving} onClick={requestClose}>
            {t('common.cancel')}
          </Button>
          <Button appearance="primary" disabledFocusable={saving} type="submit">
            {t('dashboard.apiKeys.actions.rotate')}
          </Button>
        </DialogActions>
      }
    >
      <Text size={200} className="text-fui-fg2">
        {t('dashboard.apiKeys.rotate.message', { name: snapName })}
      </Text>
      <KeySourceControl
        customKey={values.customKey}
        disabled={saving}
        error={errors.customKey?.message ? t(errors.customKey.message) : undefined}
        onCustomKeyChange={value => setValue('customKey', value, { shouldValidate: true })}
        onSourceChange={value => setValue('keySource', value, { shouldValidate: true })}
        source={values.keySource}
      />
      {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    </DialogShell></>
  );
}
