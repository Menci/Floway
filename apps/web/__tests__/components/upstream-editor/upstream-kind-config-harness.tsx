import { FormProvider, useForm } from 'react-hook-form';
import { vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { UpstreamKindConfigSection } from '../../../src/components/upstream-editor/upstream-kind-config';

// The section reads its fields out of the surrounding form, so it is mounted
// the way the editor page mounts it.
export const ProviderConfigHarness = ({ record }: { record: UpstreamRecord }) => {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return (
    <FormProvider {...form}>
      <UpstreamKindConfigSection record={record} onPatch={vi.fn()} />
    </FormProvider>
  );
};
