/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * GPT 形态一体化输入区：容器内 上附件chips/中文本/下工具栏（附件+联网在左、
 * 发送/停止在右）。输入态（草稿/待发附件/联网开关）组件自持；发送与上传
 * 通过回调上抛。上传失败显式 toast（不静默）。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { Button } from "@plane/propel/button";
import { Paperclip, Send, X } from "lucide-react";
import { ATTACHMENT_MIME_TYPES } from "@plane/constants";
import { validateFileUpload } from "@plane/utils";

import { showUploadErrorToast } from "@/helpers/upload-feedback";
import { useFileSize } from "@/hooks/use-file-size";
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
  const { maxFileSize } = useFileSize();
  const [draft, setDraft] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [webSearch] = useState(false); // 联网开关入口已下线，值恒 false（链路保留）
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 预填（nonce 触发，避免重复 effect）
  useEffect(() => {
    if (prefill?.text) setDraft((prev) => (prev ? prev : prefill.text));
  }, [prefill?.nonce, prefill?.text]);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading((n) => n + files.length);
    /* eslint-disable no-await-in-loop -- 串行上传有意（进度可控、防占满带宽） */
    for (const file of Array.from(files)) {
      const validation = validateFileUpload(file, { acceptedMimeTypes: ATTACHMENT_MIME_TYPES, maxFileSize });
      if (!validation.ok) {
        showUploadErrorToast(t, validation.error, maxFileSize);
        setUploading((n) => Math.max(0, n - 1));
        continue;
      }
      try {
        // 串行有意：进度可控、避免并发占满带宽
        const res: TFileSignedURLResponse = await chatFileService.uploadWorkspaceAsset(
          workspaceSlug,
          { entity_identifier: "", entity_type: EFileAssetType.COMMENT_DESCRIPTION },
          file
        );
        setPendingFiles((prev) => [...prev, { id: res.asset_id, name: file.name }]);
      } catch {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: t("common.error.label"),
          message: t("agent_teams_chat_upload_failed", { name: file.name }),
        });
      } finally {
        setUploading((n) => Math.max(0, n - 1));
      }
    }
    /* eslint-enable no-await-in-loop */
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const submit = () => {
    const text = draft.trim();
    if (!text && pendingFiles.length === 0) return;
    onSend(text, pendingFiles, webSearch);
    setDraft("");
    setPendingFiles([]);
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-subtle p-3">
      {showSummaryHint && (
        <div className="text-caption-sm-regular text-tertiary">{t("agent_teams_chat_summary_hint")}</div>
      )}
      <div className="focus-within:border-custom-border-200 rounded-xl border border-subtle bg-layer-1 px-3 pt-2 pb-1.5">
        {(pendingFiles.length > 0 || uploading > 0) && (
          <div className="flex flex-wrap gap-1.5 pb-1.5">
            {pendingFiles.map((f) => (
              <span
                key={f.id}
                className="flex items-center gap-1 rounded bg-layer-3 px-1.5 py-0.5 text-caption-sm-regular text-secondary"
              >
                {f.name}
                <button
                  type="button"
                  onClick={() => setPendingFiles((prev) => prev.filter((x) => x.id !== f.id))}
                  className="text-tertiary hover:text-secondary"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))}
            {uploading > 0 && (
              <span className="text-caption-sm-regular text-tertiary">{t("agent_teams_chat_uploading")}</span>
            )}
          </div>
        )}
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
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_MIME_TYPES.join(",")}
              className="hidden"
              onChange={(e) => void handleFiles(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending || disabled}
              title={t("agent_teams_chat_attach")}
              className="rounded p-1.5 text-tertiary hover:bg-layer-2-hover hover:text-secondary disabled:opacity-50"
            >
              <Paperclip className="size-4" aria-hidden />
            </button>
            {/* 联网搜索开关：搜索工具源未部署，入口先下线（链路保留，恢复时解开本注释） */}
            {/* <button
              type="button"
              onClick={() => setWebSearch((prev) => !prev)}
              className={`flex items-center gap-1 rounded px-1.5 py-1 text-caption-sm-medium ${
                webSearch ? "bg-accent-subtle text-accent-primary" : "text-tertiary hover:text-secondary"
              }`}
            >
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
              disabled={disabled || (!draft.trim() && pendingFiles.length === 0)}
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
