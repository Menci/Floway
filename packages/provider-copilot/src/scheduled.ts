import { assertCopilotUpstreamRecord } from './config.ts';
import { fetchCopilotUsage, projectCopilotSeat, projectCopilotUsageResponse, putCopilotQuota, putCopilotSeat, type CopilotUsageResponse } from './quota.ts';
import { readCopilotUpstreamState } from './state.ts';
import { runScheduledUsageRefresh, type ProviderScheduledOptions, type UpstreamRecord } from '@floway-dev/provider';

export const runCopilotScheduledTask = async (record: UpstreamRecord, options: ProviderScheduledOptions): Promise<void> => {
  const snapshot = readCopilotUpstreamState(record.state).quotaSnapshot;
  await runScheduledUsageRefresh(record, options, snapshot?.fetchedAt ?? null, async (fresh, fetcher) => {
    const { config } = assertCopilotUpstreamRecord(fresh);
    const response = await fetchCopilotUsage(config.githubHost, config.githubToken, fetcher);
    if (!response.ok) throw new Error(`Copilot usage returned ${response.status}: ${(await response.text()).slice(0, 256)}`);
    const body = await response.json() as CopilotUsageResponse;
    const now = new Date();
    const quota = projectCopilotUsageResponse(body, now);
    const seat = projectCopilotSeat(body, now);
    if (quota !== null) await putCopilotQuota(fresh.id, quota);
    if (seat !== null) await putCopilotSeat(fresh.id, seat);
  });
};
