import { fluentComponents } from "./fluent";
import type { BrandVariants } from "@fluentui/react-components";

const { createDarkTheme, createLightTheme, webDarkTheme, webLightTheme } = fluentComponents;

export const australianBrand: BrandVariants = {
  10: "#06112e",
  20: "#0b1d50",
  30: "#102a72",
  40: "#173895",
  50: "#1d47b8",
  60: "#2358d7",
  70: "#2770ea",
  80: "#4385f0",
  90: "#6199f4",
  100: "#7eacf7",
  110: "#9abefa",
  120: "#b5d0fc",
  130: "#cde0fd",
  140: "#dfebfe",
  150: "#eef5ff",
  160: "#f7faff",
};

const fontOverrides = {
  fontFamilyBase: "sans-serif",
  fontFamilyMonospace: "monospace",
  fontFamilyNumeric: "sans-serif",
  fontSizeBase100: "10px",
  fontSizeBase200: "12px",
  fontSizeBase300: "14px",
  fontSizeBase400: "16px",
  fontSizeBase500: "18px",
  fontSizeBase600: "22px",
} as const;

export const australianLightTheme = { ...createLightTheme(australianBrand), ...fontOverrides };
export const australianDarkTheme = { ...createDarkTheme(australianBrand), ...fontOverrides };

export const flowayLightTheme = { ...webLightTheme, ...fontOverrides };
export const flowayDarkTheme = { ...webDarkTheme, ...fontOverrides };

/** @deprecated use flowayLightTheme or flowayDarkTheme instead */
export const flowayTheme = flowayLightTheme;
