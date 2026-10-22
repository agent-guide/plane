/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 成员头像（首字母标 + 类型点 overlay）。
 * 与项目成员列表形态一致（设计 2026-10-20 整改）。
 */
import { useTranslation } from "@plane/i18n";
import type { AgentTeamMember } from "@/services/agent-teams/runtime.service";

export function MemberAvatar({ member }: { member: AgentTeamMember }) {
  const { t } = useTranslation();
  return (
    <span
      className={`relative flex size-7 flex-shrink-0 items-center justify-center rounded-full text-caption-sm-medium ${
        member.kind === "agent" ? "bg-accent-subtle text-accent-primary" : "bg-layer-3 text-secondary"
      }`}
      title={member.kind === "agent" ? t("agent_teams_kind_agent") : t("agent_teams_kind_human")}
    >
      {member.displayName.slice(0, 1).toUpperCase()}
      <span
        className={`border-layer-1 absolute -right-0.5 -bottom-0.5 size-2 rounded-full border ${
          member.enabled === false ? "bg-tertiary" : member.kind === "agent" ? "bg-accent-primary" : "bg-secondary"
        }`}
        aria-hidden
      />
    </span>
  );
}
