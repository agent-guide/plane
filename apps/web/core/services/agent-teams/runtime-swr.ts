/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — SWR bindings for the Runtime read model (design
 * §12.6.6 thin extension). One polling principle everywhere: poll only while
 * something is actually running (executing run / waiting decision / binding
 * window), zero requests otherwise; focus revalidation still applies via the
 * global WEB_SWR_CONFIG.
 */
import useSWR from "swr";
import {
  orchestrationService,
  type OrchestrationApproval,
  type OrchestrationProjectRuntimeOverview,
} from "./orchestration.service";

const ACTIVE_POLL_MS = 5000;
// A just-created work item is bound a few seconds AFTER creation (webhook →
// projection → auto-start). Poll the "not bound" null only through that
// window, measured from the work item's own created_at (not panel mount);
// past it the work item is genuinely outside runtime scope — stop, so plain
// work items in non-runtime projects never poll.
/** Poll while the project has anything active (runs / decisions / agents). */
export function useProjectRuntimeOverview(workspaceSlug: string | undefined, projectId: string) {
  return useSWR(
    workspaceSlug && projectId ? (["orchestration", "project-overview", projectId] as const) : null,
    // 数据源切换（阶段 2′）：项目概览运行时区块改走编排域同源 API
    () => orchestrationService.getProjectRuntimeOverview(workspaceSlug as string, projectId),
    {
      keepPreviousData: true,
      refreshInterval: (latest: OrchestrationProjectRuntimeOverview | null | undefined) =>
        latest && (latest.counts.activeTasks > 0 || latest.counts.waitingHuman > 0 || latest.counts.runningAgents > 0)
          ? ACTIVE_POLL_MS
          : 0,
      shouldRetryOnError: false,
    }
  );
}

/**
 * Waiting human decisions (§12.6.4) — the third notifications-inbox tab and
 * the top-nav inbox badge share this key, so the count costs ONE request.
 * The endpoint only returns waiting items, so length IS the pending count.
 * Polling is presence-driven: tight while decisions wait, slow otherwise.
 */
export function usePendingApprovals(workspaceSlug: string | undefined) {
  const swr = useSWR(
    workspaceSlug ? (["agent-teams", "inbox"] as const) : null,
    // 数据源切换（阶段 2′）：审批改走编排域同源 API；列表含已办，取 pending
    async () =>
      (await orchestrationService.listMyApprovals(workspaceSlug as string)).filter((a) => a.result === "pending"),
    {
      keepPreviousData: true,
      refreshInterval: (latest: OrchestrationApproval[] | undefined) =>
        (latest?.length ?? 0) > 0 ? ACTIVE_POLL_MS : 30000,
      shouldRetryOnError: false,
    }
  );
  return { items: swr.data ?? [], count: swr.data?.length ?? 0, mutate: swr.mutate, isLoading: swr.isLoading };
}
