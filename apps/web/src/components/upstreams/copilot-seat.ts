import type { CopilotRecord } from './copilot-quota';

// The seat's plan, named as GitHub names it. The SKU is what the token exchange
// carries, so this is the reading that stays fresh on its own; the same fact
// reaches `copilot_internal/user` as `access_type_sku`, which only the
// operator's refresh ever fetches.
//
// No first-party client maps a SKU to a plan name: VS Code tests the SKU for two
// booleans and takes the plan from `copilot_plan`, a separate and coarser
// namespace that never rides on the token. Each entry below is therefore
// assembled from two first-party facts -- VS Code either matches the SKU itself,
// or its entitlement tests pair that SKU with the `copilot_plan` whose plan name
// VS Code then states:
//   free_limited_copilot, free_educational_quota   matched directly (L1013-L1016)
//   monthly_subscriber_quota       -> individual      -> Pro   (test L223 / L1021)
//   plus_monthly_subscriber_quota  -> individual_pro  -> Pro+  (test L26  / L1023)
//   copilot_enterprise_seat_multi_quota -> enterprise -> Ent.  (test L268 / L1029)
// https://github.com/microsoft/vscode/blob/b285c0292b56772e2784d014ac1dbcf809c58a17/src/vs/workbench/services/chat/common/chatEntitlementService.ts#L1013-L1030
// https://github.com/microsoft/vscode/blob/b285c0292b56772e2784d014ac1dbcf809c58a17/src/vs/workbench/contrib/chat/test/common/chatEntitlementService.test.ts#L26-L30
//
// The names are the ones GitHub sells under.
// https://github.com/github/docs/blob/60321755e16a2252417e95479ac5faaf854c660a/data/variables/copilot.yml#L7-L20
//
// The namespace is open -- Microsoft types its own as `WellKnownSku | string`,
// whose well-known arm is only the two free SKUs -- and it spans two generations
// of naming, so this is a best-effort label and never a closed set. A seat on a
// SKU no first-party source attests, Max and Business among them, names its
// provider rather than a plan this table guessed at.
// https://github.com/microsoft/vscode/blob/5fb9376dbdc8b0f1bdc9eb8186f429e023503f92/extensions/copilot/src/platform/authentication/common/copilotToken.ts#L306-L314
const PLAN_NAMES: Record<string, string> = {
  free_limited_copilot: 'Free',
  free_educational_quota: 'Student',
  monthly_subscriber_quota: 'Pro',
  plus_monthly_subscriber_quota: 'Pro+',
  copilot_enterprise_seat_multi_quota: 'Enterprise',
};

// A SKU this table does not know names no plan: unlike a ChatGPT plan type,
// these are internal identifiers and none of them reads as a product name, so
// the row falls back to naming the provider.
export const planLabel = (record: CopilotRecord): string | null => {
  const sku = record.state?.copilotToken?.sku ?? null;
  if (sku === null) return null;
  const plan = PLAN_NAMES[sku];
  return plan === undefined ? null : `Copilot ${plan}`;
};
