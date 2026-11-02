/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * 工作区设置 — 连接（连接管理设计 §5.1）：外部系统凭据的列表与新建/编辑。
 */
"use client";

import { useState } from "react";
import { observer } from "mobx-react";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { NotAuthorizedView } from "@/components/auth-screens/not-authorized-view";
import { PageHead } from "@/components/core/page-title";
import { SettingsContentWrapper } from "@/components/settings/content-wrapper";
import { ConnectionsList, ConnectionFormModal } from "@/components/connections";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUserPermissions } from "@/hooks/store/user";
import type { Route } from "./+types/page";

function ConnectionsPage({ params }: Route.ComponentProps) {
  const { workspaceSlug } = params;
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const { allowPermissions } = useUserPermissions();
  const [modalOpen, setModalOpen] = useState(false);

  const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  const pageTitle = currentWorkspace?.name
    ? `${currentWorkspace.name} - ${t("workspace_settings.settings.connections.title")}`
    : undefined;

  if (!isAdmin) {
    return <NotAuthorizedView section="settings" />;
  }

  return (
    <>
      <PageHead title={pageTitle} />
      <SettingsContentWrapper>
        <div className="flex items-center justify-between gap-4 pb-6">
          <div className="min-w-0">
            <h3 className="text-h4-medium m-0 text-primary">
              {t("workspace_settings.settings.connections.title")}
            </h3>
            <p className="mt-1 text-13 text-tertiary">
              {t("workspace_settings.settings.connections.description")}
            </p>
          </div>
          <Button variant="primary" size="sm" className="flex-shrink-0" onClick={() => setModalOpen(true)}>
            {t("connections.add")}
          </Button>
        </div>
        <ConnectionsList workspaceSlug={workspaceSlug} onAdd={() => setModalOpen(true)} />
      </SettingsContentWrapper>
      <ConnectionFormModal
        isOpen={modalOpen}
        handleClose={() => setModalOpen(false)}
        workspaceSlug={workspaceSlug}
      />
    </>
  );
}

export default observer(ConnectionsPage);
