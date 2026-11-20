/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * Agent Teams extension — 审批作答附件上传（自由文本补录形态配套）。
 * agent 问「要文档/原始沟通记录」而面板只有文本框，应答能力与提问不匹配
 * （2026-11-14 定案补齐）。复用统一 AttachmentInput（类型图标+文件名+大小
 * +进度+删除）；上传即挂载到审批（刷新/换人不丢）。
 */
import { useTranslation } from "@plane/i18n";

import { AttachmentInput, type AttachmentFile } from "@/components/attachments/attachment-input";
import { showUploadFailedToast } from "@/helpers/upload-feedback";
import { FileService } from "@/services/file.service";
import { registerApprovalAttachment, unregisterApprovalAttachment } from "@/services/agent-teams/orchestration.service";
import { EFileAssetType, type TFileSignedURLResponse } from "@plane/types";

export type AnswerAttachment = AttachmentFile;

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

  return (
    <AttachmentInput
      value={attachments}
      onChange={onAttachmentsChange}
      onUpload={async (file, onProgress) => {
        try {
          const res: TFileSignedURLResponse = await fileService.uploadWorkspaceAsset(
            workspaceSlug,
            { entity_identifier: "", entity_type: EFileAssetType.COMMENT_DESCRIPTION },
            file,
            (progressEvent) => onProgress?.(Math.round((progressEvent.progress ?? 0) * 100))
          );
          // C7：上传即挂载到审批——刷新/换人不丢（失败静默，见 service 注释）
          if (approvalId) void registerApprovalAttachment(workspaceSlug, approvalId, res.asset_id);
          return { id: res.asset_id, size: file.size };
        } catch (error) {
          showUploadFailedToast(t);
          throw error;
        }
      }}
      onRemove={({ id }) => {
        if (approvalId) void unregisterApprovalAttachment(workspaceSlug, approvalId, id);
        // 与评论/会话一致：删除即回收底层资产（仅发生在作答提交前，未消费，安全）
        void fileService.deleteWorkspaceAsset(workspaceSlug, id).catch(() => {});
      }}
      attachLabel={t("agent_teams_inbox_answer_attach")}
      uploadingLabel={t("agent_teams_inbox_uploading")}
      removeLabel={t("agent_teams_inbox_attachment_remove")}
      disabled={disabled}
    />
  );
}
