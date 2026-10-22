/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * 团队生命周期状态图标（2026-10-22 定稿组合）：活跃=Activity 脉搏 /
 * 草稿=CircleDashed / 归档=ArchiveX。语义图标替代装饰圆点——详情页横幅
 * 状态药丸与侧栏团队行共用同一渲染。
 */
import { Activity, ArchiveX, CircleDashed } from "lucide-react";
import type { AgentTeam } from "@/services/agent-teams/runtime.service";

const STATUS_ICONS: Record<string, typeof Activity> = {
  active: Activity,
  draft: CircleDashed,
  archived: ArchiveX,
};

/** 侧栏行用色：活跃=主题色，草稿/归档=三级灰（与原状态点配色语义一致）。 */
const SIDEBAR_COLORS: Record<string, string> = {
  active: "text-accent-primary",
  draft: "text-tertiary",
  archived: "text-tertiary",
};

export function TeamStatusIcon({
  status,
  className = "size-3.5",
  // 图标颜色 class；缺省用侧栏配色（详情页横幅可传墨色 class 或 style）。
  color,
  strokeWidth,
  style,
}: {
  status: AgentTeam["status"];
  className?: string;
  color?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}) {
  const Icon = STATUS_ICONS[status] ?? CircleDashed;
  return (
    <Icon
      className={`${className} flex-shrink-0 ${color ?? SIDEBAR_COLORS[status] ?? "text-tertiary"}`}
      strokeWidth={strokeWidth}
      style={style}
      aria-hidden
    />
  );
}
