/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Outlet } from "react-router";
// components
import { NotificationsSidebarRoot } from "@/components/workspace-notifications/sidebar";
// agent teams extension (§12.6.4 — bridges the approvals tab list to the detail pane)
import { AgentApprovalsProvider } from "@/components/agent-teams/approvals-context";

export default function ProjectInboxIssuesLayout() {
  return (
    <div className="relative flex h-full w-full items-center overflow-hidden">
      <AgentApprovalsProvider>
        <NotificationsSidebarRoot />
        <div className="h-full w-full overflow-hidden overflow-y-auto">
          <Outlet />
        </div>
      </AgentApprovalsProvider>
    </div>
  );
}
