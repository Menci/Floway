import type { ReactNode } from 'react';

import { Dropdown } from '../ui/fluent-form-controls';
import { MultiselectCombobox, type MultiselectOption } from '../ui/multiselect-combobox';
import { fluentComponents } from '../../fluent';

const { Field, Option } = fluentComponents;

export interface TelemetryDimension<Key extends string> {
  key: Key;
  groupLabel: string;
  filterLabel: string;
  allLabel: string;
  options: readonly MultiselectOption[];
}

export function TelemetryDimensionControls<Key extends string>({
  dimensions,
  filterDimensions = dimensions,
  filters,
  groupBy,
  groupByAdornment,
  groupByLabel,
  onFilterChange,
  onGroupByChange,
  selectedLabel,
}: {
  dimensions: readonly TelemetryDimension<Key>[];
  filterDimensions?: readonly TelemetryDimension<Key>[];
  filters: Record<Key, readonly string[]>;
  groupBy: Key;
  groupByAdornment?: ReactNode;
  groupByLabel: string;
  onFilterChange: (key: Key, values: string[]) => void;
  onGroupByChange: (key: Key) => void;
  selectedLabel: (count: number) => string;
}) {
  const selectedGroup = dimensions.find(dimension => dimension.key === groupBy);
  if (!selectedGroup) throw new RangeError(`Unknown telemetry grouping dimension: ${groupBy}`);

  return <div className="flex items-end gap-3 min-w-0 flex-wrap">
    <Field className="w-[160px] flex-none" label={groupByLabel}>
      <div aria-label={groupByLabel} className="flex items-center gap-2" role="group">
        <Dropdown
          aria-label={groupByLabel}
          className="flex-1"
          selectedOptions={[groupBy]}
          value={selectedGroup.groupLabel}
          onOptionSelect={(_, data) => data.optionValue !== undefined && onGroupByChange(data.optionValue as Key)}
        >
          {dimensions.map(dimension => <Option key={dimension.key} value={dimension.key}>{dimension.groupLabel}</Option>)}
        </Dropdown>
        {groupByAdornment}
      </div>
    </Field>
    {filterDimensions
      .filter(dimension => dimension.key !== groupBy)
      .map(dimension => <Field className="min-w-[150px] flex-[1_1_150px]" key={dimension.key} label={dimension.filterLabel}>
        <MultiselectCombobox
          className="w-full"
          clearLabel={dimension.allLabel}
          onChange={values => onFilterChange(dimension.key, values)}
          options={dimension.options}
          placeholder={filters[dimension.key].length === 0
            ? dimension.allLabel
            : selectedLabel(filters[dimension.key].length)}
          value={filters[dimension.key]}
        />
      </Field>)}
  </div>;
}
