/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// plane imports
import type { TNotificationTab } from "@plane/constants";
import { ENotificationTab, NOTIFICATION_TABS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Header, Row, ERowVariant, EHeaderVariant, ContentWrapper } from "@plane/ui";
import { cn, getNumberCount } from "@plane/utils";
// components
import { CountChip } from "@/components/common/count-chip";
// agent teams extension (design §12.6.4 — third inbox tab)
import { AgentApprovalCardList } from "@/components/agent-teams/approval-card-list";
import { usePendingApprovals } from "@/services/agent-teams/runtime-swr";
// hooks
import { useWorkspaceNotifications } from "@/hooks/store/notifications";
import { useWorkspace } from "@/hooks/store/use-workspace";
// local imports
import { NotificationEmptyState } from "./empty-state";
import { AppliedFilters } from "./filters/applied-filter";
import { NotificationSidebarHeader } from "./header";
import { NotificationsLoader } from "./loader";
import { NotificationCardListRoot } from "../notification-card/root";

export const NotificationsSidebarRoot = observer(function NotificationsSidebarRoot() {
  const { workspaceSlug } = useParams();
  // hooks
  const { getWorkspaceBySlug } = useWorkspace();
  const {
    currentSelectedNotificationId,
    unreadNotificationsCount,
    loader,
    notificationIdsByWorkspaceId,
    currentNotificationTab,
    setCurrentNotificationTab,
  } = useWorkspaceNotifications();

  const { t } = useTranslation();
  // Agent teams approvals share the tab bar; count comes from the runtime
  // inbox (same SWR key as the top-nav badge — one request drives both).
  const { count: pendingApprovals } = usePendingApprovals(workspaceSlug?.toString());
  // derived values
  const workspace = workspaceSlug ? getWorkspaceBySlug(workspaceSlug.toString()) : undefined;
  const notificationIds = workspace ? notificationIdsByWorkspaceId(workspace.id) : undefined;
  const isApprovalsTab = currentNotificationTab === ENotificationTab.TEAM_APPROVALS;

  const handleTabClick = useCallback(
    (tabValue: TNotificationTab) => {
      if (currentNotificationTab !== tabValue) {
        setCurrentNotificationTab(tabValue);
      }
    },
    [currentNotificationTab, setCurrentNotificationTab]
  );

  if (!workspaceSlug || !workspace) return <></>;

  return (
    <div
      className={cn(
        "relative z-[10] h-full flex-shrink-0 border-0 border-subtle bg-surface-1 transition-all max-md:overflow-hidden md:border-r",
        currentSelectedNotificationId ? "w-0 md:w-3/12" : "w-full md:w-3/12"
      )}
    >
      <div className="relative flex h-full w-full flex-col">
        <Row className="flex h-header flex-shrink-0 border-b border-subtle">
          <NotificationSidebarHeader workspaceSlug={workspaceSlug.toString()} />
        </Row>

        <Header variant={EHeaderVariant.SECONDARY} className="justify-start">
          {NOTIFICATION_TABS.map((tab) => (
            // oxlint-disable-next-line jsx_a11y/click-events-have-key-events oxlint-disable-next-line jsx_a11y/no-static-element-interactions
            <div
              key={tab.value}
              className="relative h-full cursor-pointer px-3"
              onClick={() => handleTabClick(tab.value)}
            >
              <div
                className={cn(
                  "relative flex h-full items-center justify-center gap-1 text-body-xs-medium transition-all",
                  {
                    "text-accent-primary": currentNotificationTab === tab.value,
                    "text-primary hover:text-secondary": currentNotificationTab !== tab.value,
                  }
                )}
              >
                <div className="font-medium">{t(tab.i18n_label)}</div>
                {tab.count(unreadNotificationsCount) > 0 && (
                  <CountChip count={getNumberCount(tab.count(unreadNotificationsCount))} />
                )}
              </div>
              {currentNotificationTab === tab.value && (
                <div className="absolute right-0 bottom-0 left-0 rounded-t-md border border-accent-strong" />
              )}
            </div>
          ))}
          {/* agent teams approvals tab — same interaction, count from the runtime inbox */}
          {/* oxlint-disable-next-line jsx_a11y/click-events-have-key-events oxlint-disable-next-line jsx_a11y/no-static-element-interactions */}
          <div
            className="relative h-full cursor-pointer px-3"
            onClick={() => handleTabClick(ENotificationTab.TEAM_APPROVALS as TNotificationTab)}
          >
            <div
              className={cn(
                "relative flex h-full items-center justify-center gap-1 text-body-xs-medium transition-all",
                {
                  "text-accent-primary": isApprovalsTab,
                  "text-primary hover:text-secondary": !isApprovalsTab,
                }
              )}
            >
              <div className="font-medium">{t("notification.tabs.team_approvals")}</div>
              {pendingApprovals > 0 && <CountChip count={getNumberCount(pendingApprovals)} />}
            </div>
            {isApprovalsTab && (
              <div className="absolute right-0 bottom-0 left-0 rounded-t-md border border-accent-strong" />
            )}
          </div>
        </Header>

        {/* applied filters — not applicable to the approvals tab */}
        {!isApprovalsTab && <AppliedFilters workspaceSlug={workspaceSlug.toString()} />}

        {/* rendering notifications / approvals */}
        {isApprovalsTab ? (
          <ContentWrapper variant={ERowVariant.HUGGING}>
            <AgentApprovalCardList workspaceSlug={workspaceSlug.toString()} />
          </ContentWrapper>
        ) : loader === "init-loader" ? (
          <div className="relative h-full w-full overflow-hidden">
            <NotificationsLoader />
          </div>
        ) : (
          <>
            {notificationIds && notificationIds.length > 0 ? (
              <ContentWrapper variant={ERowVariant.HUGGING}>
                <NotificationCardListRoot workspaceSlug={workspaceSlug.toString()} workspaceId={workspace?.id} />
              </ContentWrapper>
            ) : (
              <div className="relative flex h-full w-full items-center justify-center">
                <NotificationEmptyState currentNotificationTab={currentNotificationTab} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
