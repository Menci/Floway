import type { CardProps } from "@fluentui/react-components";
import { fluentComponents } from "../../fluent";

const { Card, mergeClasses } = fluentComponents;

export type PanelRadius = 8 | 12;

export type PanelProps = CardProps & {
  radius?: PanelRadius;
};

const radiusClasses: Record<PanelRadius, string> = {
  8: "!rounded-lg",
  12: "!rounded-xl",
};

export function Panel({ className, radius = 8, ...props }: PanelProps) {
  return (
    <Card
      {...props}
      className={mergeClasses(className, radiusClasses[radius])}
    />
  );
}
