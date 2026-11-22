import type { Facts, RunEvent, StageEdge } from '@floway-dev/pipeline';

export const runEvent: RunEvent = {
  k: 'run', runId: 'run-1', pipeline: 'ingress', startedAt: 10, seq: 1, tMs: 0,
};

export const enter = (seq: number, stageId: number, facts: Facts, parentStageId: number | null = null, edge: StageEdge = 'root'): RunEvent => ({
  k: 'enter', seq, tMs: seq, stageId, parentStageId, edge, pipeline: 'ingress', name: `stage-${stageId}`, facts,
});

export const leave = (seq: number, stageId: number, facts: Facts, baseChildId?: number): RunEvent => ({
  k: 'leave', seq, tMs: seq, stageId, facts, ...(baseChildId === undefined ? {} : { baseChildId }),
});

export const closed = (seq: number, stageId: number, ok = true): RunEvent => ({
  k: 'closed', seq, tMs: seq, stageId, ok,
});

export const done = (seq: number, ok = true): RunEvent => ({ k: 'done', seq, tMs: seq, ok });
