/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — team detail (workspace scoped).
 * Placeholder shell for the P1 structural slot: layout and routing only.
 */
import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs, ContentWrapper, Header } from "@plane/ui";
// icons
import { Users } from "lucide-react";
// components
import { AppHeader } from "@/components/core/app-header";
import { PageHead } from "@/components/core/page-title";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";
import type { Route } from "./+types/page";

function WorkspaceAgentTeamDetailPage({ params }: Route.ComponentProps) {
  const { teamId } = params;
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const { agentTeamsPath } = useAgentTeamsLinks();
  // derived values
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - Agent Team` : undefined;

  return (
    <>
      <PageHead title={pageTitle} />
      <div className="flex h-full w-full flex-col overflow-hidden">
        <AppHeader
          header={
            <Header>
              <Header.LeftItem>
                <Breadcrumbs>
                  <Breadcrumbs.Item
                    component={
                      <BreadcrumbLink
                        label="Agent Teams"
                        href={agentTeamsPath}
                        icon={<Users className="size-4 text-tertiary" />}
                      />
                    }
                  />
                  <Breadcrumbs.Item component={<BreadcrumbLink label={teamId} disableTooltip />} />
                </Breadcrumbs>
              </Header.LeftItem>
            </Header>
          }
        />
        <ContentWrapper>
          <div className="flex h-full w-full flex-col gap-4 p-4">
            <p className="max-w-2xl text-body-xs-regular text-tertiary">{t("agent_teams_detail_subtitle")}</p>
            <div className="rounded-lg border border-dashed border-subtle p-10 text-center text-body-sm-regular text-tertiary">
              {t("agent_teams_detail_pending")}
            </div>
          </div>
        </ContentWrapper>
      </div>
    </>
  );
}

export default observer(WorkspaceAgentTeamDetailPage);
