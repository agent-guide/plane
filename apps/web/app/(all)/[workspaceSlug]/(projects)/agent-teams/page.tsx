/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — team list (workspace scoped).
 * Placeholder shell for the P1 structural slot: layout and routing only.
 * Data will come from the Agent Team Runtime API once the Phase 4 console
 * contract is frozen; this page must not import Runtime source code.
 */
import { observer } from "mobx-react";
import { useRouter } from "next/navigation";
// plane imports
import { Button } from "@plane/propel/button";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs, ContentWrapper, Header } from "@plane/ui";
// icons
import { Inbox, Users } from "lucide-react";
// components
import { AppHeader } from "@/components/core/app-header";
import { PageHead } from "@/components/core/page-title";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";

function WorkspaceAgentTeamsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { currentWorkspace } = useWorkspace();
  const { approvalInboxPath } = useAgentTeamsLinks();
  // derived values
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - Agent Teams` : undefined;

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
                        disableTooltip
                        icon={<Users className="size-4 text-tertiary" />}
                      />
                    }
                  />
                </Breadcrumbs>
              </Header.LeftItem>
              <Header.RightItem>
                {/* Approval Inbox entry (design §12.6.4) */}
                <Button
                  variant="secondary"
                  size="lg"
                  prependIcon={<Inbox />}
                  onClick={() => router.push(approvalInboxPath)}
                >
                  {t("agent_teams_inbox_title")}
                </Button>
              </Header.RightItem>
            </Header>
          }
        />
        <ContentWrapper>
          <div className="flex h-full w-full flex-col gap-4 p-4">
            <p className="max-w-2xl text-body-xs-regular text-tertiary">{t("agent_teams_page_subtitle")}</p>
            <div className="rounded-lg border border-dashed border-subtle p-10 text-center text-body-sm-regular text-tertiary">
              {t("agent_teams_list_pending")}
            </div>
          </div>
        </ContentWrapper>
      </div>
    </>
  );
}

export default observer(WorkspaceAgentTeamsPage);
