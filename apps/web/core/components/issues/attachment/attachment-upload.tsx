/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useState } from "react";
import { observer } from "mobx-react";
import type { FileRejection } from "react-dropzone";
import { useDropzone } from "react-dropzone";
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
// helpers
import { showUploadErrorToast } from "@/helpers/upload-feedback";
// plane web hooks
import { useFileSize } from "@/hooks/use-file-size";
// types
import type { TAttachmentOperations } from "../issue-detail-widgets/attachments/helper";

type TAttachmentOperationsModal = Pick<TAttachmentOperations, "create">;

type Props = {
  workspaceSlug: string;
  disabled?: boolean;
  attachmentOperations: TAttachmentOperationsModal;
};

export const IssueAttachmentUpload = observer(function IssueAttachmentUpload(props: Props) {
  const { workspaceSlug, disabled = false, attachmentOperations } = props;
  // states
  const [isLoading, setIsLoading] = useState(false);
  // i18n
  const { t } = useTranslation();
  // file size
  const { maxFileSize } = useFileSize();

  const onDrop = useCallback(
    (acceptedFiles: File[], rejectedFiles: FileRejection[]) => {
      if (rejectedFiles.length > 0) {
        if (acceptedFiles.length + rejectedFiles.length > 1) {
          setToast({
            type: TOAST_TYPE.ERROR,
            title: t("common.error.label"),
            message: t("attachment.only_one_file_allowed"),
          });
        } else {
          showUploadErrorToast(t, "too-large", maxFileSize);
        }
        return;
      }

      const currentFile: File = acceptedFiles[0];
      if (!currentFile || !workspaceSlug) return;

      setIsLoading(true);
      attachmentOperations
        .create(currentFile)
        .catch(() => {})
        .finally(() => setIsLoading(false));
    },
    [attachmentOperations, workspaceSlug, maxFileSize, t]
  );

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    maxSize: maxFileSize,
    multiple: false,
    disabled: isLoading || disabled,
  });

  return (
    <div
      {...getRootProps()}
      className={`flex h-[60px] items-center justify-center rounded-md border-2 border-dashed bg-accent-primary/5 px-4 text-11 text-accent-primary ${
        isDragActive ? "border-accent-strong bg-accent-primary/10" : "border-subtle"
      } ${isDragReject ? "bg-danger-subtle" : ""} ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
    >
      <input {...getInputProps()} />
      <span className="flex items-center gap-2">
        {isDragActive ? (
          <p>Drop here...</p>
        ) : isLoading ? (
          <p className="text-center">Uploading...</p>
        ) : (
          <p className="text-center">Click or drag a file here</p>
        )}
      </span>
    </div>
  );
});
