/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — new work item catch-up (design §6/§12.6.1).
 * In a runtime-managed project the binding/auto-start chain populates the
 * state within ~1s of creation, but the ASSIGNEE only projects on the first
 * member handoff (run start + node scheduling, ~10s later) — a freshly
 * created row otherwise sits on backlog / unassigned in the list. Watch the
 * runtime summary for THIS item: settle the row as soon as it binds, keep
 * watching until the current member appears (then settle again), and stop
 * early when the project turns out unbound.
 */
import runtimeService from "./runtime.service";
import { setExpertsWorkspaceSlug } from "./experts-auth";

const POLL_INTERVAL_MS = 4000;
const MAX_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * @param refresh the caller re-fetches the single work item into the store;
 *   called first when the item binds (state usually written by then) and
 *   once more when the assignee lands.
 * @returns true when at least one refresh was handed off.
 */
export async function catchUpCreatedWorkItem(
  workspaceSlug: string,
  projectId: string,
  issueId: string,
  refresh: () => Promise<unknown> | unknown
): Promise<boolean> {
  // The BFF exchange is workspace-scoped (§12.6.7); on list/board pages no
  // panel has set it yet, so scope it here or every call 403s and gives up.
  setExpertsWorkspaceSlug(workspaceSlug);

  let refreshed = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(POLL_INTERVAL_MS);
    let summary;
    try {
      summary = await runtimeService.getWorkItemRuntimeSummary(issueId);
    } catch {
      return refreshed; // runtime unreachable — quietly give up
    }
    if (summary) {
      if (!refreshed) {
        await refresh();
        refreshed = true;
      }
      if (summary.currentMemberName) {
        await refresh();
        return true;
      }
    } else {
      // Not bound yet. Distinguish "in flight" from "not a runtime project":
      // an unbound project ends the loop immediately instead of polling out.
      try {
        const overview = await runtimeService.getProjectRuntimeOverview(projectId);
        if (overview && !overview.binding) return refreshed;
      } catch {
        return refreshed;
      }
    }
  }
  return refreshed;
}
