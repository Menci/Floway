import type { PropsWithChildren } from "react";

export function LoadingMessage({ children }: PropsWithChildren) {
  return (
    <p className="text-[#616161] text-[13px] dark:text-[#c7c7c7]">
      {children}
    </p>
  );
}
