/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 流程发布轮询（从 team-workflows-section 拆出）。
 * 发布 202 后按 2s 间隔轮询版本状态直到 published/failed/timeout（最长 300s）。
 */
import workflowService from "@/services/agent-teams/workflow.service";

// 串行间隔轮询（2s/最长 300s）用 then 链表达：无循环 await，链上每步有返回值。
export function pollPublish(
  teamId: string,
  workflowId: string,
  versionId: string,
  onSettled: (status: string, versionNumber?: number, error?: string) => void
): Promise<void> {
  const deadline = Date.now() + 300_000;
  const tick = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 2000))
      .then(() => workflowService.getTeamWorkflowVersion(teamId, workflowId, versionId))
      .then((version) => {
        if (version.status === "published") {
          onSettled("published", version.version);
          return;
        }
        if (version.status === "failed") {
          onSettled("failed", undefined, version.publishError ?? "");
          return;
        }
        if (Date.now() >= deadline) {
          onSettled("timeout");
          return;
        }
        return tick();
      })
      // 瞬时网络抖动不该中断观测——吞掉后继续下一轮直到 deadline。
      .catch(() => {
        if (Date.now() >= deadline) {
          onSettled("timeout");
          return;
        }
        return tick();
      });
  return tick();
}
