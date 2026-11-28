/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * GPT 形态一体化输入区：容器内 上附件chips/中文本/下工具栏（附件+联网在左、
 * 发送/停止在右）。输入态（草稿/待发附件）组件自持；发送与上传通过回调上抛。
 * 附件区复用统一 AttachmentInput（类型图标+文件名+大小+进度+删除，成熟 chip）。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@/plane-compat/toast";
import { Button } from "@/core/ui-compat/button";
import { Paperclip, Send } from "lucide-react";

import { AttachmentInput, type AttachmentFile } from "@/components/attachments/attachment-input";
import { FileService } from "@/services/file.service";
import { EFileAssetType, type TFileSignedURLResponse } from "@plane/types";

const chatFileService = new FileService();

export type PendingAttachment = { id: string; name: string };

export function ChatComposer({
  workspaceSlug,
  disabled,
  sending,
  showSummaryHint,
  onStop,
  onSend,
  prefill,
}: {
  workspaceSlug: string;
  disabled: boolean;
  sending: boolean;
  /** 滚动摘要提示（Claude 同款：短暂告知后由父级淡出） */
  showSummaryHint: boolean;
  onStop: () => void;
  /** 预填输入（检查点三选的"继续/转流程卡"话术）；nonce 变化触发追加 */
  prefill?: { text: string; nonce: number };
  /** 上抛发送：文本 + 已上传附件 + 联网开关（服务端注入检索纪律） */
  onSend: (text: string, attachments: PendingAttachment[], webSearch: boolean) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);
  const [webSearch] = useState(false); // 联网开关入口已下线，值恒 false（链路保留）
  const pickerRef = useRef<(() => void) | undefined>(undefined);

  // 预填（nonce 触发，避免重复 effect）
  useEffect(() => {
    if (prefill?.text) setDraft((prev) => (prev ? prev : prefill.text));
  }, [prefill?.nonce, prefill?.text]);

  const submit = () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    onSend(
      text,
      attachments.filter((a) => a.status === "done").map((a) => ({ id: a.id, name: a.name })),
      webSearch
    );
    setDraft("");
    setAttachments([]);
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-subtle p-3">
      {showSummaryHint && (
        <div className="text-caption-sm-regular text-tertiary">{t("agent_teams_chat_summary_hint")}</div>
      )}
      <div className="focus-within:border-custom-border-200 rounded-xl border border-subtle bg-layer-1 px-3 pt-2 pb-1.5">
        <AttachmentInput
          value={attachments}
          onChange={setAttachments}
          hideButton
          pickerRef={pickerRef}
          onUpload={async (file, onProgress) => {
            try {
              const res: TFileSignedURLResponse = await chatFileService.uploadWorkspaceAsset(
                workspaceSlug,
                { entity_identifier: "", entity_type: EFileAssetType.COMMENT_DESCRIPTION },
                file,
                (progressEvent) => onProgress?.(Math.round((progressEvent.progress ?? 0) * 100))
              );
              return { id: res.asset_id, size: file.size };
            } catch (error) {
              setToast({
                type: TOAST_TYPE.ERROR,
                title: t("common.error.label"),
                message: t("agent_teams_chat_upload_failed", { name: file.name }),
              });
              throw error;
            }
          }}
          onRemove={({ id }) => {
            void chatFileService.deleteWorkspaceAsset(workspaceSlug, id).catch(() => {});
          }}
          attachLabel={t("agent_teams_chat_attach")}
          uploadingLabel={t("agent_teams_chat_uploading")}
          disabled={sending || disabled}
        />
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t("agent_teams_chat_input_placeholder")}
          rows={2}
          disabled={disabled}
          className="min-h-10 w-full resize-none bg-transparent text-body-sm-regular outline-none disabled:opacity-50"
        />
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => pickerRef.current?.()}
              disabled={sending || disabled}
              title={t("agent_teams_chat_attach")}
              className="rounded p-1.5 text-tertiary transition-colors hover:bg-layer-2-hover hover:text-secondary disabled:opacity-50"
            >
              <Paperclip className="size-4" aria-hidden />
            </button>
            {/* 联网搜索开关：搜索工具源未部署，入口先下线（链路保留，恢复时解开本注释）
            <button type="button" className="...">
              <Globe className="size-3.5" aria-hidden />
              {t("agent_teams_chat_web_search")}
            </button> */}
          </div>
          {sending ? (
            <Button variant="secondary" size="sm" onClick={onStop}>
              {t("agent_teams_chat_stop")}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              appendIcon={<Send />}
              disabled={disabled || (!draft.trim() && attachments.filter((a) => a.status === "done").length === 0)}
              onClick={submit}
            >
              {t("agent_teams_chat_send")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
