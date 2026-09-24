/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — Project Team panel rendered inline on the project
 * list card (design §12.2): responsible team, workflow, active agents and
 * waiting human decisions in one compact line. Renders nothing when the
 * project is not bound; the team name deep-links to the team page (§12.1).
 * Per-card queries need a batch endpoint before 联调 (§9 has none).
 */
import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useRouter, useParams } from "next/navigation";
// i18n
import { useTranslation } from "@plane/i18n";
// icons
import { Bot } from "lucide-react";
// components
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
import runtimeService, { type ProjectTeamPanel } from "@/services/agent-teams/runtime.service";
import { setExpertsWorkspaceSlug } from "@/services/agent-teams/experts-auth";

export const ProjectTeamBadge = observer(function ProjectTeamBadge({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { agentTeamDetailPath, approvalInboxPath } = useAgentTeamsLinks();
  const [panel, setPanel] = useState<ProjectTeamPanel | null>(null);
  const routerParams = useParams<{ workspaceSlug?: string }>();
  // §12.6.7 BFF 身份交换按 workspace 取作用域（身份映射 connection+scope）。
  useEffect(() => {
    if (routerParams.workspaceSlug) setExpertsWorkspaceSlug(routerParams.workspaceSlug);
  }, [routerParams.workspaceSlug]);

  const load = useCallback(async () => {
    try {
      setPanel(await runtimeService.getProjectTeamPanel(projectId));
    } catch (error) {
      // 未绑定是 200+null 的正常态（service 直取 panel）；这里仅捕获传输故障，
      // 并保留控制台痕迹——不再静默吞错（assumed-endpoint 404 数周未察觉的教训）。
      console.error("agent-team-panel load failed", error);
      setPanel(null);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!panel) return null;

  return (
    // One line inside the fixed-height card footer: identity+context on the
    // left (truncates first when long), stats+action on the right
    // (shrink-0 — the waiting badge must never be squeezed out).
    <div className="flex w-full items-center justify-between gap-2">
      <div className="flex min-w-0 items-baseline gap-1.5 text-caption-sm-regular text-tertiary">
        <Bot className="size-3.5 shrink-0 self-center text-accent-primary" aria-hidden />
        <button
          type="button"
          onClick={(e) => {
            // The card itself is a link — opt out before navigating.
            e.preventDefault();
            e.stopPropagation();
            router.push(agentTeamDetailPath(panel.teamId));
          }}
          className="hover:text-accent-primary-hover shrink-0 cursor-pointer text-caption-sm-medium text-accent-primary hover:underline"
        >
          {panel.teamName}
        </button>
        {panel.workflowName && (
          <span className="truncate">
            · {panel.workflowName}
            {panel.workflowVersion != null ? ` v${panel.workflowVersion}` : ""} · Agent {panel.activeAgentCount ?? 0}
          </span>
        )}
      </div>
      {(panel.waitingDecisionCount ?? 0) > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            router.push(`${approvalInboxPath}?project=${panel.projectId}`);
          }}
          className="shrink-0 cursor-pointer rounded bg-accent-subtle px-1.5 py-0.5 text-caption-sm-medium text-accent-primary hover:bg-accent-primary-hover hover:text-on-color"
        >
          {t("agent_teams_card_waiting", { count: panel.waitingDecisionCount })}
        </button>
      )}
    </div>
  );
});
