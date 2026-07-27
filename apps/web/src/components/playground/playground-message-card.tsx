import type { PropsWithChildren } from "react";

import type { PlaygroundMessage } from "./playground-logic";
import { fluentComponents } from "../../fluent";

const { Card, makeStyles, tokens } = fluentComponents;

const useStyles = makeStyles({
  user: {
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundImage:
      "linear-gradient(to right, light-dark(#2770ea, #244b8f), light-dark(#1b4aef, #203581))",
  },
});

type PlaygroundMessageCardProps = PropsWithChildren<{
  role: PlaygroundMessage["role"];
}>;

export function PlaygroundMessageCard({ children, role }: PlaygroundMessageCardProps) {
  const s = useStyles();

  return (
    <Card
      className={`min-w-0 break-words overflow-hidden !rounded-xl after:!rounded-xl ${role === "user" ? s.user : ""}`}
      size="medium"
    >
      {children}
    </Card>
  );
}
