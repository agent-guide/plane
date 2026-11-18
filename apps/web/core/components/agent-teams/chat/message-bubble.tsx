/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * 单条会话消息气泡：user（右侧）/ agent（左侧 text·确认卡·流程卡·异常态）。
 * hover 操作（复制/分享到卡片）只对有正文的 agent 消息出现。
 */
import { useCallback, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { MessageSquarePlus } from "lucide-react";

import { MarkdownPreview } from "@/components/agent-teams/markdown-preview";
import type { ChatMessage, StreamError } from "./types";

export function MessageBubble({
  message,
  busy,
  attachmentNames,
  onConfirmCard,
  onCheckpoint,
  onShare,
  onOpenCard,
}: {
  message: ChatMessage;
  /** 确认卡处理中（禁用按钮） */
  busy: boolean;
  /** 附件 id → 显示名（乐观消息与历史消息统一渲染） */
  attachmentNames: Record<string, string>;
  onConfirmCard: (messageId: string, action: "confirm" | "cancel") => void;
  onCheckpoint: (option: "continue" | "convert" | "stop") => void;
  onShare: (message: ChatMessage) => void;
  onOpenCard: (projectId: string, issueId: string) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(message.content?.text ?? "")
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        return null;
      })
      .catch(() => undefined);
  }, [message.content?.text]);

  if (message.role === "user") {
    return (
      <div className="max-w-[80%] min-w-0 self-end break-words rounded-2xl rounded-br-md bg-accent-subtle px-4 py-2.5 text-body-sm-regular text-primary">
        {message.content?.text}
        {message.attachments?.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.attachments.map((aid) => (
              <span key={aid} className="rounded bg-layer-3/60 px-1.5 py-0.5 text-caption-sm-regular">
                📎 {attachmentNames[aid] ?? aid.slice(0, 6)}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  const confirm = message.content?.confirm;
  const card = message.content?.card;
  const error = message.content?.error;

  return (
    <div className="group flex max-w-[85%] min-w-0 flex-col items-start self-start">
    <div className="min-w-0 w-full break-words self-start rounded-2xl rounded-bl-md border border-subtle bg-layer-2 px-4 py-3">
      {message.kind === "confirm_card" && confirm ? (
        <ConfirmCardBody confirm={confirm} busy={busy} onConfirm={onConfirmCard} messageId={message.id} />
      ) : message.kind === "flow_card" && card ? (
        <div className="flex flex-col gap-1">
          <span className="text-caption-sm-regular text-tertiary">{t("agent_teams_chat_flow_created")}</span>
          <button
            type="button"
            onClick={() => onOpenCard(card.projectId ?? "", card.issueId)}
            className="text-left text-body-sm-medium text-accent-primary hover:underline"
          >
            {card.title}
          </button>
          <span className="text-caption-sm-regular text-tertiary">{card.status}</span>
        </div>
      ) : (
        <>
          {message.content?.text ? (
            <MarkdownBody text={message.content.text} />
          ) : !error && !message.content?.interrupted ? (
            <div className="text-caption-sm-regular text-tertiary">{t("agent_teams_chat_empty_reply")}</div>
          ) : null}
          {message.content?.interrupted && (
            <div className="text-caption-sm-regular text-tertiary">{t("agent_teams_chat_interrupted")}</div>
          )}
          {error && <ErrorBody error={error} onCheckpoint={onCheckpoint} />}
          {message.content?.sharedTo && message.content.sharedTo.length > 0 && (
            <div className="mt-3 flex max-w-full flex-col gap-1.5 border-t border-subtle pt-2.5">
              {message.content.sharedTo.map((sh) => (
                <button
                  key={sh.issueId}
                  type="button"
                  onClick={() => onOpenCard(sh.projectId, sh.issueId)}
                  title={sh.title}
                  className="flex max-w-full items-center gap-1.5 self-start rounded-full bg-layer-3/60 px-2.5 py-1 text-caption-sm-regular text-tertiary transition-colors hover:bg-layer-3 hover:text-accent-primary"
                >
                  <span aria-hidden className="shrink-0">↗</span>
                  <span className="truncate">{t("agent_teams_chat_shared_to", { name: sh.title })}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
    {/* 操作行：气泡外部下方（ChatGPT/Claude 同款）——不占气泡空间、
        不扰动 markdown 底部间距；hover 整行浮现 */}
    {message.content?.text && (
      <div className="flex items-center gap-3 pt-2 pl-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={handleCopy}
          className="text-caption-sm-regular text-tertiary hover:text-secondary"
        >
          {copied ? t("agent_teams_chat_copied") : t("agent_teams_chat_copy")}
        </button>
        <button
          type="button"
          onClick={() => onShare(message)}
          className="flex items-center gap-0.5 text-caption-sm-regular text-tertiary hover:text-secondary"
        >
          <MessageSquarePlus className="size-3" aria-hidden />
          {t("agent_teams_chat_share")}
        </button>
      </div>
    )}
    </div>
  );
}

/** 流式中的员工气泡（等待三点 / 增量 / 错误）。 */
export function StreamingBubble({
  streaming,
  onCheckpoint,
}: {
  streaming: { text: string; error?: StreamError };
  onCheckpoint: (option: "continue" | "convert" | "stop") => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="max-w-[85%] min-w-0 self-start break-words rounded-2xl rounded-bl-md border border-subtle bg-layer-2 px-4 py-3">
      {streaming.text ? (
        <MarkdownBody text={streaming.text} />
      ) : streaming.error ? (
        <ErrorBody error={streaming.error} onCheckpoint={onCheckpoint} />
      ) : (
        // GPT 同款三点跳动（等待首字）
        <div className="flex items-center gap-1 py-1" aria-label={t("agent_teams_chat_typing")}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 animate-bounce rounded-full"
              style={{ background: "var(--text-color-tertiary)", animationDelay: `${i * 150}ms`, animationDuration: "0.9s" }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MarkdownBody({ text }: { text: string }) {
  // 复用项目标准 Markdown 渲染（remark-gfm 表格/删除线 + prose 文档节奏）——
  // 曾用裸 ReactMarkdown 无 gfm 插件，表格语法不渲染（11-18 实证）
  return <MarkdownPreview content={text} className="text-body-sm-regular" />;
}

/** 确认卡（L1 建卡预览）：确认创建走闸门链；取消作废；已决态只读。 */
function ConfirmCardBody({
  confirm,
  busy,
  messageId,
  onConfirm,
}: {
  confirm: NonNullable<ChatMessage["content"]["confirm"]>;
  busy: boolean;
  messageId: string;
  onConfirm: (messageId: string, action: "confirm" | "cancel") => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <div className="text-body-sm-medium">{confirm.title}</div>
      {confirm.description && (
        <div className="whitespace-pre-wrap text-caption-sm-regular text-secondary">{confirm.description}</div>
      )}
      {confirm.state ? (
        <div className="text-caption-sm-regular text-tertiary">{t("agent_teams_chat_confirm_settled")}</div>
      ) : (
        <div className="flex gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onConfirm(messageId, "confirm")}>
            {t("agent_teams_chat_confirm_title")}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => onConfirm(messageId, "cancel")}>
            {t("agent_teams_chat_confirm_cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** 错误/预算检查点：D1 人话 + 三选（继续/转流程卡/停止）。 */
function ErrorBody({
  error,
  onCheckpoint,
}: {
  error: StreamError;
  onCheckpoint: (option: "continue" | "convert" | "stop") => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="text-caption-sm-regular text-secondary">{error.detail || t("agent_teams_chat_error")}</div>
      {error.checkpoint && (
        <div className="flex flex-col gap-1 rounded bg-layer-3 p-2">
          <div className="text-caption-sm-regular text-tertiary">{t("agent_teams_chat_checkpoint_title")}</div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={() => onCheckpoint("continue")}>
              {t("agent_teams_chat_continue")}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onCheckpoint("convert")}>
              {t("agent_teams_chat_convert")}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onCheckpoint("stop")}>
              {t("agent_teams_chat_stop_option")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
