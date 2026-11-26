// `premium_interactions` is metered in GitHub AI Credits, and 1 AI credit is $0.01 USD:
// https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
// VS Code labels the same bucket's `{used} / {entitlement}` as "Credits":
// https://github.com/microsoft/vscode/blob/9afe2783a7239c915d5fc6d1bd9c842f9ca06c2e/src/vs/workbench/contrib/chat/browser/chatStatus/chatStatusDashboard.ts#L860-L875
// `chat` and `completions` are request counts on a free seat (200 and 2000), not credits.
export const isCopilotCreditQuota = (quotaId: string): boolean => quotaId === 'premium_interactions';

export const copilotCreditsToUsd = (credits: number): number => credits / 100;
