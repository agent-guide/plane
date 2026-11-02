/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * 连接列表（设计 §5.1）：状态灯 + 使用情况 + 测试/编辑/删除。
 */
"use client";

import { useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { CircleDot, MoreHorizontal, Pencil, Plug, RefreshCw, Trash2 } from "lucide-react";
import { CustomMenu, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { Button } from "@plane/propel/button";
import {
  connectionsService,
  type ExternalConnection,
} from "@/services/agent-teams/connections.service";

export const ConnectionsList = observer(function ConnectionsList({
  workspaceSlug,
  onAdd,
}: {
  workspaceSlug: string;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const { data, isLoading, mutate } = useSWR(
    `CONNECTIONS_${workspaceSlug}`,
    () => connectionsService.listConnections(workspaceSlug),
    { revalidateOnFocus: false },
  );
  const [testingId, setTestingId] = useState("");
  const [deleteFor, setDeleteFor] = useState<ExternalConnection | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      await connectionsService.testConnection(workspaceSlug, id);
      await mutate();
    } finally {
      setTestingId("");
    }
  };

  const handleDelete = async () => {
    if (!deleteFor) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await connectionsService.deleteConnection(workspaceSlug, deleteFor.id);
      setDeleteFor(null);
      await mutate();
    } catch (error) {
      setDeleteError((error as Error).message || t("connections.delete_failed"));
    } finally {
      setDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="rounded-lg border border-subtle px-4 py-8 text-center text-body-sm-regular text-tertiary">
        {t("connections.loading")}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="rounded-lg border border-subtle px-4 py-12 text-center">
        <p className="text-body-sm-medium text-secondary">{t("connections.empty_title")}</p>
        <p className="mx-auto mt-1 max-w-md text-body-xs-regular text-tertiary">
          {t("connections.empty_hint")}
        </p>
        <Button variant="primary" size="sm" className="mt-4" onClick={onAdd}>
          {t("connections.add")}
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="divide-y divide-subtle rounded-lg border border-subtle">
        {data.map((conn: ExternalConnection) => (
          <div key={conn.id} className="flex items-center gap-3 px-4 py-3">
            <Plug className="size-4 flex-shrink-0 text-tertiary" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body-sm-medium text-primary">{conn.name}</p>
              <p className="truncate text-caption-sm-regular text-tertiary">
                {t(`connections.type_${conn.type}`)}
                {conn.usageCount > 0
                  ? ` · ${t("connections.used_by", { count: conn.usageCount })}`
                  : ` · ${t("connections.unused")}`}
              </p>
            </div>
            {/* 状态灯：绿=正常 / 红=失败（悬浮原因）/ 灰=未测试 */}
            <span
              className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-caption-sm-medium ${
                conn.status === "active"
                  ? "bg-success-primary/10 text-success-primary"
                  : conn.status === "unreachable"
                    ? "bg-danger-primary/10 text-danger-primary"
                    : "bg-layer-3 text-tertiary"
              }`}
              title={conn.statusNote || undefined}
            >
              <CircleDot className="size-3" aria-hidden />
              {t(
                conn.status === "active"
                  ? "connections.status_active"
                  : conn.status === "unreachable"
                    ? "connections.status_unreachable"
                    : "connections.status_untested",
              )}
            </span>
            <span className="flex-shrink-0 text-caption-sm-regular text-placeholder">
              {new Date(conn.updatedAt).toLocaleDateString()}
            </span>
            <CustomMenu
              customButton={
                <MoreHorizontal className="size-4 flex-shrink-0 text-tertiary hover:text-primary" aria-hidden />
              }
              placement="bottom-end"
              closeOnSelect
            >
              <CustomMenu.MenuItem
                onClick={() => void handleTest(conn.id)}
                className="flex items-center gap-2"
              >
                <RefreshCw className={`size-3.5 ${testingId === conn.id ? "animate-spin" : ""}`} aria-hidden />
                {t("connections.test")}
              </CustomMenu.MenuItem>
              <CustomMenu.MenuItem onClick={() => void handleTest(conn.id)} className="hidden" >
                {/* 编辑入口由父层弹层承载（onEdit 回调待接线） */}
                <Pencil className="size-3.5" aria-hidden />
              </CustomMenu.MenuItem>
              <CustomMenu.MenuItem
                onClick={() => {
                  setDeleteError("");
                  setDeleteFor(conn);
                }}
                className="flex items-center gap-2 text-danger-primary"
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t("connections.delete")}
              </CustomMenu.MenuItem>
            </CustomMenu>
          </div>
        ))}
      </div>

      {/* 删除确认（被引用时不给删除按钮，只给引导） */}
      <ModalCore
        isOpen={!!deleteFor}
        handleClose={() => setDeleteFor(null)}
        position={EModalPosition.TOP}
        width={EModalWidth.SM}
      >
        <div className="flex flex-col gap-3 p-5">
          <h3 className="text-body-lg-medium text-primary">{t("connections.delete")}</h3>
          {deleteError ? (
            <p className="m-0 rounded-md bg-danger-primary/5 px-3 py-2 text-body-xs-regular text-danger-primary">
              {deleteError}
            </p>
          ) : (
            <p className="m-0 text-body-sm-regular text-secondary">
              {t("connections.delete_confirm", { name: deleteFor?.name ?? "" })}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDeleteFor(null)}>
              {t("cancel")}
            </Button>
            {!deleteError ? (
              <Button variant="error-fill" size="sm" loading={deleting} onClick={() => void handleDelete()}>
                {t("connections.delete")}
              </Button>
            ) : null}
          </div>
        </div>
      </ModalCore>
    </>
  );
});
