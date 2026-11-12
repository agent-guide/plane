/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — 工作卡「补料输入框」（P1 常驻补料，设计
 * docs/v2/card-comment-injection-design.md §4）。
 *
 * 用户随时发补充信息/附件 → 工作卡评论（复用既有评论体系，零新端点）；
 * 下一个未执行节点开工时由后端注入 prompt（步骤边界注入）。
 * 有等待审批时本组件不出现在面板底部——内嵌作答区是唯一的答复输入
 * （设计定案：任一时刻只有一个输入入口，不出现两处输入）。
 */
"use client";

import { useRef, useState } from "react";
// plane imports
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EFileAssetType, EIssueCommentAccessSpecifier } from "@plane/types";
// i18n
import { useTranslation } from "@plane/i18n";
// components
import { Button } from "@plane/propel/button";
// services
import { FileService } from "@/services/file.service";
import { IssueCommentService } from "@/services/issue/issue_comment.service";

type CardCommentInputProps = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  /** 执行已进入终态（补充将在「重新运行」时生效，而非下一节点）。 */
  terminal?: boolean;
  /** 发送成功后回调（面板刷新评论列表）。 */
  onPosted?: () => void;
};

const fileService = new FileService();
const issueCommentService = new IssueCommentService();

/** 补料附件行：文件名 + 移除。 */
function AttachmentChip({ name, onRemove, disabled }: { name: string; onRemove: () => void; disabled?: boolean }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded border border-subtle bg-layer-2 px-1.5 py-0.5 text-caption-sm-regular text-secondary">
      <span className="truncate">{name}</span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className="flex-shrink-0 text-tertiary hover:text-danger-primary"
        aria-label="remove attachment"
      >
        ×
      </button>
    </span>
  );
}

export function CardCommentInput({
  workspaceSlug,
  projectId,
  issueId,
  terminal = false,
  onPosted,
}: CardCommentInputProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<{ name: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const busy = uploading || sending;

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      // 上传链与评论附件同源（预签名 + S3 + 状态回写）；asset_url 即
      // 写入 IssueComment.attachments 的 URL，后端注入时原样带出
      const uploaded = await Promise.all(
        Array.from(files).map(async (file) => {
          const res = await fileService.uploadProjectAsset(
            workspaceSlug,
            projectId,
            {
              entity_identifier: issueId,
              entity_type: EFileAssetType.COMMENT_DESCRIPTION,
            },
            file
          );
          return { name: file.name, url: res.asset_url };
        })
      );
      setAttachments((prev) => [...prev, ...uploaded].slice(0, 10));
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("error"),
        message: String((error as Error)?.message ?? error),
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSend = async () => {
    const body = text.trim();
    if ((!body && attachments.length === 0) || busy) return;
    setSending(true);
    try {
      // 评论走既有评论 API：html 为源（后端 save 派生 stripped），附件为
      // URL 数组；access INTERNAL（团队内可见）。换行转 <br/> 保留多行
      //（补料常为多行单据数据，2026-11-12 G2）。
      const escaped = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>");
      await issueCommentService.createIssueComment(workspaceSlug, projectId, issueId, {
        comment_html: `<p>${escaped}</p>`,
        attachments: attachments.map((a) => a.url),
        access: EIssueCommentAccessSpecifier.INTERNAL,
      });
      setText("");
      setAttachments([]);
      onPosted?.();
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("error"),
        message: String((error as Error)?.message ?? error),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t border-subtle pt-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter 发送（Enter 保留换行——补充资料常多行）
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !busy) {
            e.preventDefault();
            void handleSend();
          }
        }}
        rows={2}
        disabled={busy}
        placeholder={t("agent_teams_comment_input_placeholder")}
        className="focus:border-accent-primary/50 w-full resize-none rounded-md border border-subtle bg-layer-1 px-2.5 py-1.5 text-body-sm-regular text-primary outline-none placeholder:text-placeholder"
      />
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((a, i) => (
            <AttachmentChip
              key={`${a.url}`}
              name={a.name}
              disabled={busy}
              onRemove={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
            />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => void handleFiles(e.target.files)} />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            className="text-caption-sm-regular text-tertiary hover:text-accent-primary disabled:opacity-60"
          >
            {uploading ? t("agent_teams_comment_uploading") : t("agent_teams_comment_attach")}
          </button>
          <span className="text-caption-sm-regular text-placeholder">
            {t(terminal ? "agent_teams_comment_hint_terminal" : "agent_teams_comment_hint")}
          </span>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleSend()}
          disabled={busy || (!text.trim() && attachments.length === 0)}
        >
          {sending ? t("agent_teams_comment_sending") : t("agent_teams_comment_send")}
        </Button>
      </div>
    </div>
  );
}
