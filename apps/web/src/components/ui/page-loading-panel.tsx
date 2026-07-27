import { fluentComponents } from "../../fluent";
import { Panel } from "./panel";

const { Spinner, Text } = fluentComponents;

export function PageLoadingPanel({ label }: { label: string }) {
  return (
    <Panel className="!p-[22px_24px] flex items-center gap-[12px]">
      <Spinner size="tiny" />
      <Text size={300} className="text-fui-fg3">
        {label}
      </Text>
    </Panel>
  );
}
