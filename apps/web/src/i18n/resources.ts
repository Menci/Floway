import en from "./locales/en";
import jaJP from "./locales/ja-JP";
import zhHansCN from "./locales/zh-Hans-CN";
import zhHantHK from "./locales/zh-Hant-HK";
import zhHantTW from "./locales/zh-Hant-TW";

export const resources = {
  en,
  "ja-JP": jaJP,
  "zh-Hans-CN": zhHansCN,
  "zh-Hant-HK": zhHantHK,
  "zh-Hant-TW": zhHantTW,
} as const;
