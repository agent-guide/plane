/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * 附件输入区（轻量输入框族统一组件）：入口按钮 + 附件 chips 行。
 * 会话输入框 / 审批作答 / 答复面板三处共用，对齐 GitHub/Slack/ChatGPT
 * 的「类型图标 + 文件名 + 大小 + 上传进度 + 删除」成熟 chip 模式。
 *
 * - 组件自持：文件选择、串行上传、逐文件进度、错误态、删除
 * - 上传能力由调用方注入（onUpload：真正走 FileService），组件只编排 UI 与状态
 * - 校验复用统一 validateFileUpload + showUploadErrorToast
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import {
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  Loader2,
  Paperclip,
  X,
} from "lucide-react";
import { ATTACHMENT_MIME_TYPES } from "@plane/constants";
import { convertBytesToSize, validateFileUpload } from "@plane/utils";

import { showUploadErrorToast } from "@/helpers/upload-feedback";
import { useFileSize } from "@/hooks/use-file-size";

export type AttachmentFile = {
  /** 稳定 id：上传完成后为 asset_id；上传中为本地临时 id */
  id: string;
  name: string;
  size?: number;
  status: "uploading" | "done" | "error";
  /** 0-100，仅上传中有意义 */
  progress?: number;
};

type AttachmentInputProps = {
  value: AttachmentFile[];
  onChange: (files: AttachmentFile[]) => void;
  /** 上传一个文件并返回稳定 id（+可选大小）；onProgress 透传逐文件进度 */
  onUpload: (file: File, onProgress?: (percent: number) => void) => Promise<{ id: string; size?: number }>;
  /** 移除已上传文件（用于调用方同步外部登记，如审批挂载） */
  onRemove?: (file: AttachmentFile) => void;
  accept?: string[];
  disabled?: boolean;
  attachLabel?: string;
  uploadingLabel?: string;
  removeLabel?: string;
  /** 隐藏内置回形针按钮（调用方自己放按钮，配合 pickerRef 触发） */
  hideButton?: boolean;
  /** 暴露「打开文件选择器」句柄，供外部按钮调用 */
  pickerRef?: React.MutableRefObject<(() => void) | undefined>;
};

function iconForFile(name: string) {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) return FileImage;
  if (ext === "pdf") return FileText;
  if (["xls", "xlsx", "csv"].includes(ext)) return FileSpreadsheet;
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return FileArchive;
  if (["md", "txt", "json", "js", "ts", "tsx", "html", "css", "log", "yaml", "yml", "xml"].includes(ext))
    return FileCode2;
  if (["doc", "docx", "ppt", "pptx"].includes(ext)) return FileText;
  return File;
}

export function AttachmentInput({
  value,
  onChange,
  onUpload,
  onRemove,
  accept = ATTACHMENT_MIME_TYPES,
  disabled = false,
  attachLabel,
  uploadingLabel,
  removeLabel,
  hideButton = false,
  pickerRef,
}: AttachmentInputProps) {
  const { t } = useTranslation();
  const { maxFileSize } = useFileSize();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  // 同步镜像当前列表，避免异步上传里的闭包陈旧 value（曾导致「上传完成 chip 被清掉」）
  const valueRef = useRef(value);
  valueRef.current = value;

  const attachText = attachLabel ?? t("agent_teams_chat_attach");
  const uploadingText = uploadingLabel ?? t("agent_teams_chat_uploading");
  const removeText = removeLabel ?? t("agent_teams_inbox_attachment_remove");

  const uploading = uploadingCount > 0;

  // 提交列表：先同步 ref，再通知外部（后续 update 读 ref 即为最新，不会回退）
  const commit = (next: AttachmentFile[]) => {
    valueRef.current = next;
    onChange(next);
  };
  const update = (id: string, patch: Partial<AttachmentFile>) =>
    commit(valueRef.current.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploadingCount((n) => n + files.length);
    for (const file of Array.from(files)) {
      const validation = validateFileUpload(file, { acceptedMimeTypes: accept, maxFileSize });
      if (!validation.ok) {
        showUploadErrorToast(t, validation.error, maxFileSize);
        setUploadingCount((n) => Math.max(0, n - 1));
        continue;
      }
      const localId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const entry: AttachmentFile = { id: localId, name: file.name, size: file.size, status: "uploading", progress: 0 };
      commit([...valueRef.current, entry]);
      try {
        // 串行上传有意（进度可控、避免并发占满带宽）
        // eslint-disable-next-line no-await-in-loop
        const res = await onUpload(file, (percent) => update(localId, { progress: percent }));
        update(localId, { id: res.id, size: res.size ?? file.size, status: "done", progress: 100 });
      } catch {
        update(localId, { status: "error" });
      } finally {
        setUploadingCount((n) => Math.max(0, n - 1));
      }
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  const remove = (file: AttachmentFile) => {
    commit(valueRef.current.filter((f) => f.id !== file.id));
    if (file.status === "done") onRemove?.(file);
  };

  const chips = useMemo(
    () =>
      value.map((file) => {
        const Icon = iconForFile(file.name);
        const isError = file.status === "error";
        const isUploading = file.status === "uploading";
        return (
          <span
            key={file.id}
            className={`inline-flex max-w-[300px] items-center gap-2 rounded-lg border px-2.5 py-1 ${
              isError ? "border-danger-primary/40 bg-danger-subtle" : "border-subtle bg-layer-2"
            }`}
          >
            <Icon className="size-4 shrink-0 text-tertiary" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[13px] text-secondary" title={file.name}>
              {file.name}
            </span>
            {isUploading ? (
              <span className="flex shrink-0 items-center gap-1 text-caption-sm-regular text-tertiary">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {file.progress !== undefined ? `${Math.round(file.progress)}%` : uploadingText}
              </span>
            ) : (
              file.size !== undefined && (
                <span className="shrink-0 text-caption-sm-regular text-tertiary">{convertBytesToSize(file.size)}</span>
              )
            )}
            <button
              type="button"
              aria-label={removeText}
              title={removeText}
              disabled={disabled}
              onClick={() => remove(file)}
              className="shrink-0 rounded p-0.5 text-tertiary transition-colors hover:bg-layer-3-hover hover:text-danger-primary disabled:opacity-50"
            >
              <X className="size-4" aria-hidden />
            </button>
          </span>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, disabled, uploadingText, removeText]
  );

  useEffect(() => {
    if (pickerRef) pickerRef.current = () => inputRef.current?.click();
    return () => {
      if (pickerRef) pickerRef.current = undefined;
    };
  }, [pickerRef]);

  return (
    <div className="flex flex-col gap-1.5">
      {(value.length > 0 || uploading) && <div className="flex flex-wrap items-center gap-1.5">{chips}</div>}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={accept.join(",")}
        onChange={(e) => void handleFiles(e.target.files)}
      />
      {!hideButton && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          title={attachText}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded text-tertiary transition-colors hover:bg-layer-2-hover hover:text-secondary disabled:opacity-50"
        >
          <Paperclip className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
