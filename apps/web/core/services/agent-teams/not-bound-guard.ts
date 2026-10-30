/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — 未绑定项目创建工作项守卫（编排域闸门前端配套）。
 * 后端 409 PROJECT_NOT_BOUND 在各创建路径（弹窗/看板内联/列表 quick-add/
 * 日历/甘特）的统一识别与本地化提示；文案复用既有 unbound 键。
 */
import { translate } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";

export function isProjectNotBoundError(error: unknown): boolean {
  const err = error as { response?: { data?: { code?: string } }; message?: string };
  return err?.response?.data?.code === "PROJECT_NOT_BOUND" || String(err?.message ?? "").includes("PROJECT_NOT_BOUND");
}

/** 未绑定提示（i18next 全局实例——store/非组件上下文可用）。 */
export function notifyProjectNotBound(): void {
  setToast({
    type: TOAST_TYPE.ERROR,
    title: translate("agent_teams_project_unbound_title"),
    message: translate("agent_teams_wf_bind_semantics"),
  });
}
