import type { PropsWithChildren } from "react";
import { fluentComponents } from "../fluent";

const { makeStyles } = fluentComponents;

const useStyles = makeStyles({
  root: {
    minHeight: "100vh",
    backgroundImage:
      "radial-gradient(circle at 50% 0%, #ffffff 0, #f7fbff 36%, transparent 64%), linear-gradient(180deg, #f6f8fb 0%, #eef2f6 100%)",
    "@media (prefers-color-scheme: dark)": {
      backgroundImage:
        "radial-gradient(circle at 50% 0%, #2d2d2d 0, #242424 38%, transparent 68%), linear-gradient(180deg, #1f1f1f 0%, #171717 100%)",
    },
  },
});

export function GradientBackground({ children }: PropsWithChildren) {
  const styles = useStyles();
  return <div className={styles.root}>{children}</div>;
}
