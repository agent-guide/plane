/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";

import { useTranslation } from "@plane/i18n";
import { TrashIcon } from "@plane/propel/icons";
import { Tooltip } from "@plane/propel/tooltip";
import type { TIssueServiceType } from "@plane/types";
import { EIssueServiceType } from "@plane/types";
// ui
import { CustomMenu } from "@plane/ui";
import { convertBytesToSize, getFileExtension, getFileName, getFileURL, renderFormattedDate } from "@plane/utils";
// components
import { ButtonAvatars } from "@/components/dropdowns/member/avatar";
import { getFileIcon } from "@/components/icons";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useMember } from "@/hooks/store/use-member";
import { usePlatformOS } from "@/hooks/use-platform-os";

type TIssueAttachmentsListItem = {
  /** store 模式：按 id 读已保存附件 */
  attachmentId?: string;
  /** 外部数据模式（如新建态草稿）：直接给附件元数据，配合 onRemove */
  attachment?: { id: string; name: string; size?: number };
  onRemove?: (id: string) => void;
  disabled?: boolean;
  issueServiceType?: TIssueServiceType;
};

export const IssueAttachmentsListItem = observer(function IssueAttachmentsListItem(props: TIssueAttachmentsListItem) {
  const { t } = useTranslation();
  const { attachmentId, attachment: externalAttachment, onRemove, disabled, issueServiceType = EIssueServiceType.ISSUES } = props;
  // store hooks
  const { getUserDetails } = useMember();
  const {
    attachment: { getAttachmentById },
    toggleDeleteAttachmentModal,
  } = useIssueDetail(issueServiceType);
  // derived values
  const storeAttachment = attachmentId ? getAttachmentById(attachmentId) : undefined;

  // 外部数据模式：拼一个最小 attachment 形状供渲染（无下载、无创建人、删除走 onRemove）
  const attachment = storeAttachment ?? (externalAttachment ? {
    attributes: { name: externalAttachment.name, size: externalAttachment.size ?? 0 },
    asset_url: "",
    created_by: null,
    updated_at: null,
  } : undefined);

  const fileName = getFileName(attachment?.attributes.name ?? "");
  const fileExtension = getFileExtension(attachment?.attributes.name ?? "");
  const fileIcon = getFileIcon(fileExtension, 18);
  const fileURL = getFileURL(attachment?.asset_url ?? "");

  const { isMobile } = usePlatformOS();

  if (!attachment) return <></>;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (fileURL) window.open(fileURL, "_blank");
      }}
    >
      <div className="group flex h-11 items-center justify-between gap-3 pr-2 pl-9 hover:bg-surface-2">
        <div className="flex items-center gap-3 truncate text-13">
          <div className="flex items-center gap-3">{fileIcon}</div>
          <Tooltip tooltipContent={`${fileName}.${fileExtension}`} isMobile={isMobile}>
            <p className="truncate font-medium text-secondary">{`${fileName}.${fileExtension}`}</p>
          </Tooltip>
          <span className="flex size-1.5 rounded-full bg-layer-1" />
          <span className="flex-shrink-0 text-placeholder">{convertBytesToSize(attachment.attributes.size)}</span>
        </div>

        <div className="flex items-center gap-3">
          {attachment?.created_by && (
            <Tooltip
              isMobile={isMobile}
              tooltipContent={`${
                getUserDetails(attachment?.created_by)?.display_name ?? ""
              } uploaded on ${renderFormattedDate(attachment.updated_at)}`}
            >
              <div className="flex items-center justify-center">
                <ButtonAvatars showTooltip userIds={attachment?.created_by} />
              </div>
            </Tooltip>
          )}

          <CustomMenu ellipsis closeOnSelect placement="bottom-end" disabled={disabled}>
            <CustomMenu.MenuItem
              onClick={() => {
                if (externalAttachment && onRemove) onRemove(externalAttachment.id);
                else if (attachmentId) toggleDeleteAttachmentModal(attachmentId);
              }}
            >
              <div className="flex items-center gap-2">
                <TrashIcon className="h-3.5 w-3.5" strokeWidth={2} />
                <span>{t("common.actions.delete")}</span>
              </div>
            </CustomMenu.MenuItem>
          </CustomMenu>
        </div>
      </div>
    </button>
  );
});
