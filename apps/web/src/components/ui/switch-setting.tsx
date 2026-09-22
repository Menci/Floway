import type { InfoButtonProps } from '@fluentui/react-components';

import { Switch } from './fluent-form-controls';
import { fluentComponents } from '../../fluent';

const { InfoButton } = fluentComponents;

// A switch whose meaning needs a sentence. The info button sits outside the
// Switch rather than inside its label, because a Switch injects `htmlFor` into
// that label: a button placed there toggles the switch instead of opening its
// own popover, which is also why `infoLabelSlot` is not usable here.
export function SwitchSetting({ checked, description, label, onChange }: {
  checked: boolean;
  description: InfoButtonProps['info'];
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return <span className="inline-flex items-center gap-1">
    <Switch checked={checked} label={label} onChange={(_, data) => onChange(data.checked)} />
    <InfoButton info={description} />
  </span>;
}
