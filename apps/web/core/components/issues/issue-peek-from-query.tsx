"use client";

/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * 深链 peek 桥（agent-teams 扩展）：Plane CE 工作项详情是列表页上的 peek
 * 浮层（纯 store 状态、不认 URL），`/issues?issueId=` 落地后浮层不会自动
 * 打开。此组件在项目 issues 页读取 issueId 查询参数并唤起 peek——供项目
 * 概览、团队页等处深链直达工作项详情。
 */
import { useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";

export function IssuePeekFromQuery({ projectId }: { projectId: string }) {
  const params = useParams<{ workspaceSlug: string }>();
  const searchParams = useSearchParams();
  const { setPeekIssue } = useIssueDetail();
  // 只对同一个参数值触发一次（重复渲染/依赖变化不重置浮层）。
  const lastPeeked = useRef<string>("");

  const issueId = searchParams.get("issueId");
  const workspaceSlug = params?.workspaceSlug;

  useEffect(() => {
    if (!issueId || !workspaceSlug || lastPeeked.current === issueId) return;
    lastPeeked.current = issueId;
    setPeekIssue({ workspaceSlug, projectId, issueId, nestingLevel: 0 });
  }, [issueId, workspaceSlug, projectId, setPeekIssue]);

  return null;
}
