/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { cloneElement, useCallback, useState } from "react";
import { observer } from "mobx-react";
import type { FileRejection } from "react-dropzone";
import { useDropzone } from "react-dropzone";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { AddOutline } from "@makeplane/propel/icons";
// plane imports
import { useTranslation } from "@plane/i18n";
import { setToast } from "@plane/blocks/toast";
import { EFileAssetType, type TFileSignedURLResponse, type TIssueServiceType } from "@plane/types";
// helpers
import { showUploadErrorToast, showUploadFailedToast } from "@/helpers/upload-feedback";// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// plane web hooks
import { useFileSize } from "@/hooks/use-file-size";
// services
import { FileService } from "@/services/file.service";
// local imports
import { useAttachmentOperations } from "./helper";

const fileService = new FileService();

type Props = {
  workspaceSlug: string;
  projectId: string;
  /** 软依赖：新建态无 issueId，走「先上传 → 建卡 → bulk 关联」（延迟绑定） */
  issueId?: string;
  /** Rendered as the button itself; clicking it opens the file picker. */
  customButton?: React.ReactNode;
  /** Hover label for `customButton`. */
  tooltip?: string;
  /** 延迟绑定资产回调（新建态先上传后建卡时上抛） */
  onDeferredAsset?: (asset: TFileSignedURLResponse) => void;  disabled?: boolean;
  issueServiceType: TIssueServiceType;
  /** 新建态：上传成功后回报资产元数据（由调用方建卡后 bulk 关联 + 回显） */
  onDeferredAsset?: (asset: { id: string; name: string; size?: number }) => void;
};

export const IssueAttachmentActionButton = observer(function IssueAttachmentActionButton(props: Props) {
  const {
    workspaceSlug,
    projectId,
    issueId,
    customButton,
    tooltip,
    disabled = false,
    issueServiceType,
    onDeferredAsset,
  } = props;  // state
  const [isLoading, setIsLoading] = useState(false);
  // i18n
  const { t } = useTranslation();
  // store hooks
  const { setLastWidgetAction, fetchActivities } = useIssueDetail(issueServiceType);
  // file size
  const { maxFileSize } = useFileSize();
  // operations
  const { operations: attachmentOperations } = useAttachmentOperations(
    workspaceSlug,
    projectId,
    issueId ?? "",
    issueServiceType
  );
  // handlers
  const handleFetchPropertyActivities = useCallback(() => {
    fetchActivities(workspaceSlug, projectId, issueId ?? "");
  }, [fetchActivities, workspaceSlug, projectId, issueId]);

  const onDrop = useCallback(
    (acceptedFiles: File[], rejectedFiles: FileRejection[]) => {
      const totalAttachedFiles = acceptedFiles.length + rejectedFiles.length;

      if (rejectedFiles.length === 0) {
        const currentFile: File = acceptedFiles[0];
        if (!currentFile || !workspaceSlug) return;

        setIsLoading(true);

        // 新建态（无 issueId）：延迟上传，回报 asset_id，建卡后由 base bulk 关联
        if (!issueId) {
          fileService
            .uploadProjectAsset(
              workspaceSlug,
              projectId,
              { entity_identifier: "", entity_type: EFileAssetType.ISSUE_ATTACHMENT },
              currentFile
            )
            .then((res: TFileSignedURLResponse) => onDeferredAsset?.({ id: res.asset_id, name: currentFile.name, size: currentFile.size }))
            .catch(() => showUploadFailedToast(t))
            .finally(() => setIsLoading(false));
          return;
        }

        attachmentOperations
          .create(currentFile)
          .catch(() => {
            setToast({
              type: "error",
              title: "Error!",
              message: "File could not be attached. Try uploading again.",
            });
          })          .finally(() => {
            handleFetchPropertyActivities();
            setLastWidgetAction("attachments");
            setIsLoading(false);
          });
        return;
      }

      if (totalAttachedFiles > 1) {
        setToast({
          type: "error",
          title: t("common.error.label"),
          message: t("attachment.only_one_file_allowed"),
        });
      } else {
        showUploadErrorToast(t, "too-large", maxFileSize);
      }      return;
    },
    [attachmentOperations, maxFileSize, workspaceSlug, issueId, projectId, onDeferredAsset, handleFetchPropertyActivities, setLastWidgetAction, t]
  );

  const { getRootProps, getInputProps, open } = useDropzone({
    onDrop,
    maxSize: maxFileSize,
    multiple: false,
    disabled: isLoading || disabled,
    // A custom button opens the picker itself, so the drop zone around it stays out of the tab order.
    noClick: !!customButton,
    noKeyboard: !!customButton,
  });

  if (customButton) {
    const button = cloneElement(customButton, { onClick: open, disabled: isLoading || disabled });
    return (
      // the wrapper keeps files dropped on the button working
      <span {...getRootProps({ className: "inline-flex", onClick: (e) => e.stopPropagation() })}>
        <input {...getInputProps()} />
        {tooltip ? <Tooltip label={tooltip}>{button}</Tooltip> : button}
      </span>
    );
  }

  return (
    <div
      onClick={(e) => {
        // TODO: Remove extra div and move event propagation to button
        e.stopPropagation();
      }}
    >
      <button {...getRootProps()} type="button" disabled={disabled}>
        <input {...getInputProps()} />
        <AddOutline className="size-3.5" />
      </button>
    </div>
  );
});
