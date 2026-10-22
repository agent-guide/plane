/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — runtime 调用失败的用户可读分类。
 *
 * 换签走 fork 侧 BFF（apps/api/.../agent_teams_runtime.py），失败状态码本身
 * 就说明了「重试有没有用」：
 *   409 → 工作区没有登记的 runtime webhook：工作区没接入，重试永远不会成功；
 *   503 → 部署没配运行服务地址；502 → 换签上游不可达。两者都归「服务不可用」，
 *         稍后重试可能恢复。
 * 其余错误维持通用的「加载失败，可重试」。
 */
export type RuntimeFailureKind = "not_connected" | "unavailable" | "unknown";

export function classifyRuntimeFailure(error: unknown): RuntimeFailureKind {
  const response = (error as { response?: { status?: number; data?: { error?: string } } })?.response;
  const status = response?.status;
  const detail = response?.data?.error ?? "";
  if (status === 409 && /not connected to the runtime/i.test(detail)) return "not_connected";
  if (status === 503 || status === 502) return "unavailable";
  return "unknown";
}

/** 分类对应的 i18n 键（标题 / 说明）；unknown 由页面用通用失败文案兜底。 */
export const RUNTIME_FAILURE_COPY = {
  not_connected: {
    titleKey: "agent_teams_runtime_not_connected_title",
    hintKey: "agent_teams_runtime_not_connected_hint",
  },
  unavailable: {
    titleKey: "agent_teams_runtime_unavailable_title",
    hintKey: "agent_teams_runtime_unavailable_hint",
  },
} as const;
