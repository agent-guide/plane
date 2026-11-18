/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 成员头像（首字母标 + 类型点 overlay）。
 * 与项目成员列表形态一致（设计 2026-10-20 整改）。
 */
import { useTranslation } from "@plane/i18n";
import { teamInk } from "@/components/agent-teams/helper";
/** 头像渲染所需的最小成员结构（结构化接口，避免消费方强转完整类型）。 */
export type AvatarMember = {
  kind: string;
  role: string;
  displayName?: string | null;
  enabled?: boolean;
};

export function MemberAvatar({ member }: { member: AvatarMember }) {
  const { t } = useTranslation();
  return (
    <span
      className={`flex size-7 flex-shrink-0 items-center justify-center rounded-full text-caption-sm-medium ${
        member.kind === "agent" ? "bg-accent-subtle text-accent-primary" : "bg-layer-3 text-secondary"
      }`}
      title={member.kind === "agent" ? t("agent_teams_kind_agent") : t("agent_teams_kind_human")}
    >
      {(member.displayName ?? member.role).slice(0, 1).toUpperCase()}
    </span>
  );
}


/** 团队色标（与侧栏团队菜单/团队横幅同源：名字 hash 取墨色 + 白字 + 方形圆角）。 */
export function TeamAvatar({ name }: { name: string }) {
  return (
    <span
      className="grid size-7 flex-shrink-0 place-items-center rounded-full text-caption-sm-medium font-bold text-white"
      style={{ backgroundColor: teamInk(name) }}
      aria-hidden
    >
      {(name || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}
