/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — 状态深链（#4）：概览页状态计数（含「N 项待确认」）
 * 点击跳到工作项页并自动落上状态过滤。参数：?state_group=backlog|unstarted|
 * started|completed|cancelled 或 ?waiting=1（等待确认 = external_id 标签态）。
 * 过滤走富表达式实例的 addCondition（与筛选行同一条写入路径）；应用一次后
 * 清参，避免刷新/返回重复叠加。
 */
import { useEffect, useRef } from "react";
import { useSearchParams, useParams } from "next/navigation";
// plane imports
import { LOGICAL_OPERATOR } from "@plane/types";
// hooks
import { useProjectState } from "@/hooks/store/use-project-state";
import type { IWorkItemFilterInstance } from "@plane/shared-state";

const GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;

export function IssueStateDeepLink({ filter }: { filter: IWorkItemFilterInstance | null }) {
  const searchParams = useSearchParams();
  const { workspaceSlug: wsParam, projectId: projectParam } = useParams();
  const workspaceSlug = wsParam?.toString();
  const projectId = projectParam?.toString();
  const { getProjectStates } = useProjectState();
  const appliedRef = useRef(false);

  const stateGroup = searchParams.get("state_group");
  const waiting = searchParams.get("waiting");

  useEffect(() => {
    if (appliedRef.current || !filter || !workspaceSlug || !projectId) return;
    if (!stateGroup && !waiting) return;
    if (!filter.expression && !filter.initialFilterExpression) return; // 实例未就绪

    const states = getProjectStates(projectId) ?? [];
    if (waiting) {
      const target = states.find((state) => state.external_id === "waiting_human");
      if (target) {
        filter.addCondition(LOGICAL_OPERATOR.AND, {
          property: "state_id",
          operator: "in",
          value: [target.id],
        }, false);
      }
    } else if (stateGroup && (GROUPS as readonly string[]).includes(stateGroup)) {
      const ids = states.filter((state) => state.group === stateGroup).map((state) => state.id);
      if (ids.length > 0) {
        filter.addCondition(LOGICAL_OPERATOR.AND, {
          property: "state_id",
          operator: "in",
          value: ids,
        }, false);
      }
    }
    appliedRef.current = true;
    // 清参防重复叠加（保留其余查询参数，如 issueId peek）
    const next = new URLSearchParams(searchParams.toString());
    next.delete("state_group");
    next.delete("waiting");
    window.history.replaceState(null, "", `?${next.toString()}`);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 参数与实例就绪即应用一次
  }, [filter, stateGroup, waiting, workspaceSlug, projectId]);

  return null;
}
