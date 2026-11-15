/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — 审批作答附件上传（自由文本补录形态配套）。
 * agent 问「要文档/原始沟通记录」而面板只有文本框，应答能力与提问不匹配
 * （2026-11-14 定案补齐）。复用 v2 资产上传通道（与评论附件同源），文件条
 * 展示 + 可移除；上传中禁用提交由调用方经 uploading 控制。
 */
import { useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
// types
import { EFileAssetType, type TFileSignedURLResponse } from "@plane/types";
// services
import { FileService } from "@/services/file.service";
import { registerApprovalAttachment, unregisterApprovalAttachment } from "@/services/agent-teams/orchestration.service";

export interface AnswerAttachment {
  id: string;
  name: string;
}

const fileService = new FileService();

export function ApprovalAttachmentUpload({
  workspaceSlug,
  approvalId,
  attachments,
  onAttachmentsChange,
  disabled,
}: {
  workspaceSlug: string;
  approvalId?: string;
  attachments: AnswerAttachment[];
  onAttachmentsChange: (next: AnswerAttachment[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [uploadError, setUploadError] = useState(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploadError(false);
    setUploadingCount((n) => n + files.length);
    const uploaded: AnswerAttachment[] = [];
    // 逐个串行上传有意为之（进度可控、避免并发占满带宽）
    for (const file of Array.from(files)) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        const res: TFileSignedURLResponse = await fileService.uploadWorkspaceAsset(
          workspaceSlug,
          {
            entity_identifier: "",
            entity_type: EFileAssetType.COMMENT_DESCRIPTION,
          },
          file
        );
        uploaded.push({ id: res.asset_id, name: file.name });
        // C7：上传即挂载到审批——刷新/换人不丢（失败静默，见 service 注释）
        if (approvalId) void registerApprovalAttachment(workspaceSlug, approvalId, res.asset_id);
      } catch {
        setUploadError(true);
      } finally {
        setUploadingCount((n) => Math.max(0, n - 1));
      }
    }
    if (uploaded.length) onAttachmentsChange([...attachments, ...uploaded]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleRemove = (attachment: AnswerAttachment) => {
    if (approvalId) void unregisterApprovalAttachment(workspaceSlug, approvalId, attachment.id);
    onAttachmentsChange(attachments.filter((a) => a.id !== attachment.id));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-subtle px-2 py-1 text-caption-sm-medium text-secondary transition-colors hover:bg-layer-transparent-hover disabled:opacity-60"
          disabled={disabled || uploadingCount > 0}
          onClick={() => inputRef.current?.click()}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3.5" aria-hidden>
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          {uploadingCount > 0 ? t("agent_teams_inbox_uploading") : t("agent_teams_inbox_answer_attach")}
        </button>
        {attachments.map((attachment) => (
          <span
            key={attachment.id}
            className="inline-flex max-w-[220px] items-center gap-1 rounded bg-layer-2 px-2 py-1 text-caption-sm-regular text-secondary"
          >
            <span className="truncate" title={attachment.name}>
              {attachment.name}
            </span>
            <button
              type="button"
              aria-label={t("agent_teams_inbox_attachment_remove")}
              className="text-placeholder hover:text-danger-primary"
              disabled={disabled}
              onClick={() => handleRemove(attachment)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {uploadError && (
        <span className="text-caption-sm-regular text-danger-primary">{t("agent_teams_inbox_upload_failed")}</span>
      )}
      <input ref={inputRef} type="file" multiple hidden onChange={(e) => void handleFiles(e.target.files)} />
    </div>
  );
}
