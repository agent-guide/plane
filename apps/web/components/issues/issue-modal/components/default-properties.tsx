/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * 工作项表单属性行：精简为「附件 + 链接 + 负责人 + 标签」。
 * 附件/链接复用工作卡详情页同一组件与交互（软依赖 issueId：新建态先上传/录入 →
 * 建卡 → 关联，编辑态即时绑定）。回显采用详情页同款 chip 样式，数据为本会话
 * 草稿（新建态无 store 数据，编辑态已有项仍在卡片详情列表）。
 */
import { useState } from "react";
import { observer } from "mobx-react";
import type { Control } from "react-hook-form";
import { Controller } from "react-hook-form";
import { ETabIndices, EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { LinkIcon } from "@/plane-compat/propel-icons";
import { Paperclip } from "lucide-react";
// types
import { EIssueServiceType, type TIssue, type TIssueLink } from "@plane/types";
// components
import { Collapsible, CollapsibleButton } from "@/core/ui-compat";
import { MemberSelect } from "@/components/dropdowns/member/member-select";
import { LabelSelect } from "@/components/dropdowns/label/label-select";
import { IssueAttachmentActionButton } from "@/components/issues/issue-detail-widgets/attachments";
import { AttachmentsCollapsible } from "@/components/issues/issue-detail-widgets/attachments";
import { IssueLinksActionButton } from "@/components/issues/issue-detail-widgets/links";
import { LinksCollapsible } from "@/components/issues/issue-detail-widgets/links";
import { IssueDetailWidgetButton } from "@/components/issues/issue-detail-widgets/widget-button";
import { IssueLinkItem } from "@/components/issues/issue-detail/links/link-item";
// hooks
import { useUserPermissions } from "@/hooks/store/user";
import { usePlatformOS } from "@/hooks/use-platform-os";
import { getTabIndex } from "@plane/utils";

export type LinkDraft = { title: string; url: string };

type StagedAttachment = { id: string; name: string; size?: number };

type TIssueDefaultPropertiesProps = {
  control: Control<TIssue>;
  id: string | undefined;
  projectId: string | null;
  workspaceSlug: string;
  handleFormChange: () => void;
  /** 附件 asset_id 上报（新建态由 base 建卡后 bulk 关联） */
  onAssetUpload?: (assetId: string) => void;
  /** 删除暂存附件时同步移除登记（防「隐形附件」） */
  onAssetRemove?: (assetId: string) => void;
  /** 链接草稿上报（新建态建卡后落库） */
  onLinksChange?: (links: LinkDraft[]) => void;
};

export const IssueDefaultProperties = observer(function IssueDefaultProperties(props: TIssueDefaultPropertiesProps) {
  const { control, id, projectId, workspaceSlug, handleFormChange, onAssetUpload, onAssetRemove, onLinksChange } =
    props;
  const { t } = useTranslation();
  const { isMobile } = usePlatformOS();
  const { allowPermissions } = useUserPermissions();
  const { getIndex } = getTabIndex(ETabIndices.ISSUE_FORM, isMobile);

  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [links, setLinks] = useState<LinkDraft[]>([]);
  const [linksOpen, setLinksOpen] = useState(true);
  const [attachmentsOpen, setAttachmentsOpen] = useState(true);

  const canCreateLabel =
    projectId && allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.PROJECT, workspaceSlug, projectId);

  const commitLinks = (next: LinkDraft[]) => {
    setLinks(next);
    onLinksChange?.(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* 附件：复用详情页组件（软依赖 issueId） */}
        <IssueAttachmentActionButton
          workspaceSlug={workspaceSlug}
          projectId={projectId ?? ""}
          issueId={id}
          issueServiceType={EIssueServiceType.ISSUES}
          disabled={!projectId}
          onDeferredAsset={({ id: assetId, name, size }) => {
            setAttachments((prev) => [...prev, { id: assetId, name, size }]);
            onAssetUpload?.(assetId);
          }}
          customButton={
            <IssueDetailWidgetButton
              title={t("common.attach")}
              icon={<Paperclip className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} />}
              disabled={!projectId}
            />
          }
        />

        {/* 链接：复用详情页组件（软依赖 issueId） */}
        <IssueLinksActionButton
          issueServiceType={EIssueServiceType.ISSUES}
          disabled={!projectId}
          onDeferredLink={(data: Partial<TIssueLink>) => {
            const url = (data.url ?? "").trim();
            if (!url) return;
            commitLinks([...links, { title: (data.title ?? "").trim() || url, url }]);
          }}
          customButton={
            <IssueDetailWidgetButton
              title={t("issue.add.link")}
              icon={<LinkIcon className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} />}
              disabled={!projectId}
            />
          }
        />

        {/* 负责人 */}
        <Controller
          control={control}
          name="assignee_ids"
          render={({ field: { value, onChange } }) => (
            <MemberSelect
              value={value ?? []}
              projectId={projectId ?? undefined}
              onChange={(assigneeIds: string[]) => {
                onChange(assigneeIds);
                handleFormChange();
              }}
              placeholder={t("assignees")}
              multiple
              variant={value?.length ? "avatar-group-sm" : "pill-sm"}
              tabIndex={getIndex("assignee_ids")}
            />
          )}
        />

        {/* 标签 */}
        <Controller
          control={control}
          name="label_ids"
          render={({ field: { value, onChange } }) => (
            <div className="h-7">
              <LabelSelect
                value={value ?? []}
                onChange={(labelIds: string[]) => {
                  onChange(labelIds);
                  handleFormChange();
                }}
                projectId={projectId}
                variant="pill-sm"
                tabIndex={getIndex("label_ids")}
                data-testid="issue-form-label-select"
              />
            </div>
          )}
        />
      </div>

      {/* 分组回显：编辑态原样复用详情页折叠区；新建态用同款视觉渲染草稿 */}
      {id ? (
        <>
          <LinksCollapsible
            workspaceSlug={workspaceSlug}
            projectId={projectId ?? ""}
            issueId={id}
            issueServiceType={EIssueServiceType.ISSUES}
          />
          <AttachmentsCollapsible
            workspaceSlug={workspaceSlug}
            projectId={projectId ?? ""}
            issueId={id}
            issueServiceType={EIssueServiceType.ISSUES}
          />
        </>
      ) : (
        <>
          {links.length > 0 && (
            <Collapsible
              isOpen={linksOpen}
              onToggle={() => setLinksOpen((v) => !v)}
              buttonClassName="w-full"
              title={
                <CollapsibleButton
                  isOpen={linksOpen}
                  title={t("common.links")}
                  indicatorElement={<span className="text-14 !leading-3 text-tertiary">{links.length}</span>}
                  actionItemElement={<IssueLinksActionButton issueServiceType={EIssueServiceType.ISSUES} disabled={!projectId} onDeferredLink={(data: Partial<TIssueLink>) => { const url = (data.url ?? "").trim(); if (!url) return; commitLinks([...links, { title: (data.title ?? "").trim() || url, url }]); }} />}
                />
              }
            >
              <div className="flex flex-col gap-2 pt-4">
                {links.map((link) => (
                  <IssueLinkItem
                    key={link.url}
                    link={{ id: link.url, url: link.url, title: link.title }}
                    onRemove={(id) => commitLinks(links.filter((l) => l.url !== id))}
                    linkOperations={{ create: async () => {}, update: async () => {}, remove: async () => {} }}
                    isNotAllowed={false}
                    issueServiceType={EIssueServiceType.ISSUES}
                  />
                ))}
              </div>
            </Collapsible>
          )}

          {attachments.length > 0 && (
            <Collapsible
              isOpen={attachmentsOpen}
              onToggle={() => setAttachmentsOpen((v) => !v)}
              buttonClassName="w-full"
              title={
                <CollapsibleButton
                  isOpen={attachmentsOpen}
                  title={t("common.attachments")}
                  indicatorElement={<span className="text-14 !leading-3 text-tertiary">{attachments.length}</span>}
                  actionItemElement={<IssueAttachmentActionButton workspaceSlug={workspaceSlug} projectId={projectId ?? ""} issueServiceType={EIssueServiceType.ISSUES} disabled={!projectId} onDeferredAsset={({ id: assetId, name, size }) => { setAttachments((prev) => [...prev, { id: assetId, name, size }]); onAssetUpload?.(assetId); }} />}
                />
              }
            >
              <div className="flex flex-col">
                {attachments.map((a) => (
                  <div key={a.id} className="flex h-9 items-center justify-between gap-3 border-b border-subtle pl-9 pr-2 last:border-b-0 hover:bg-surface-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <Paperclip className="h-3.5 w-3.5 flex-shrink-0 text-placeholder" strokeWidth={2} />
                      <span className="truncate text-13 font-medium text-secondary">{a.name}</span>
                      {a.size != null && <span className="flex-shrink-0 text-11 text-placeholder">{(a.size / 1024).toFixed(1)} KB</span>}
                    </span>
                    <button
                      type="button"
                      className="text-placeholder hover:text-danger-primary"
                      aria-label={t("common.actions.delete")}
                      onClick={() => {
                        setAttachments((prev) => prev.filter((x) => x.id !== a.id));
                        onAssetRemove?.(a.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </Collapsible>
          )}
        </>
      )}
    </div>
  );
});
