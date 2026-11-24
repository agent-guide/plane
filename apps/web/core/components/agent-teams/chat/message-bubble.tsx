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
import { FormSelect } from "@/components/agent-teams/form-select";
import {
  AGENT_ERROR_MESSAGE_KEYS,
  displayErrorDetail,
  type AgentErrorCode,
} from "@/services/agent-teams/orchestration.service";
import type { ChatMessage, StreamError } from "./types";

export function MessageBubble({
  message,
  busy,
  onConfirmCard,
  onCheckpoint,
  onShare,
  onOpenCard,
}: {
  message: ChatMessage;
  /** 确认卡处理中（禁用按钮） */
  busy: boolean;
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
      <div className="max-w-[80%] min-w-0 self-end rounded-2xl rounded-br-md bg-accent-subtle px-4 py-2.5 text-body-sm-regular break-words text-primary">
        {message.content?.text}
        {message.attachments?.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.attachments.map((a) => (
              <a
                key={a.id}
                href={a.downloadUrl}
                className="rounded bg-layer-3/60 px-1.5 py-0.5 text-body-sm-regular text-secondary transition-colors hover:bg-layer-3 hover:text-accent-primary"
                title={a.name}
              >
                📎 {a.name}
              </a>
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
      <div className="w-full min-w-0 self-start rounded-2xl rounded-bl-md border border-subtle bg-layer-2 px-4 py-3 break-words">
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
                    <span aria-hidden className="shrink-0">
                      ↗
                    </span>
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
  streaming: {
    text: string;
    stage?: { phase: "tool" | "plan"; label: string; out?: string } | null;
    error?: StreamError;
  };
  onCheckpoint: (option: "continue" | "convert" | "stop") => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="max-w-[85%] min-w-0 self-start rounded-2xl rounded-bl-md border border-subtle bg-layer-2 px-4 py-3 break-words">
      {/* 协议 v2 进度：单行当前步骤态（「正在…」），正文流式其下。
          呼吸感：环状 spinner（持续活动感，弱于跳动点）+ 更宽的间距/留白，
          与正文的视觉重心拉开层级（11-20 UI 反馈） */}
      {streaming.stage?.label && (
        <div className="mb-3 flex items-start gap-2 pb-1 text-caption-sm-regular text-tertiary">
          <svg aria-hidden className="size-3 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              d="M22 12a10 10 0 0 1-10 10"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
            />
          </svg>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {/* 完整显示不截断（对齐 Claude Code），长命令容器内换行 */}
            <span className="min-w-0 break-all">{streaming.stage.label}</span>
            {streaming.stage.out && (
              <pre className="font-mono max-h-8 min-w-0 overflow-hidden text-caption-sm-regular break-all whitespace-pre-wrap text-placeholder">
                {streaming.stage.out}
              </pre>
            )}
          </div>
        </div>
      )}
      {streaming.text ? (
        // 流式期：尾部闪烁光标（globals.css .agent-streaming-text）标识
        // 「仍在输出」——间隙长时用户不会误判已结束，定稿后随气泡换轨消失
        <div className="agent-streaming-text">
          <MarkdownBody text={streaming.text} />
        </div>
      ) : streaming.error ? (
        <ErrorBody error={streaming.error} onCheckpoint={onCheckpoint} />
      ) : (
        // GPT 同款三点跳动（等待首字）
        <div className="flex items-center gap-1 py-1" aria-label={t("agent_teams_chat_typing")}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 animate-bounce rounded-full"
              style={{
                background: "var(--text-color-tertiary)",
                animationDelay: `${i * 150}ms`,
                animationDuration: "0.9s",
              }}
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

/** 确认卡（L1 建卡预览）：确认创建走闸门链；取消作废；已决态只读。
 *  排版对标审批卡惯例（钉钉审批/Linear）：状态徽标 → 标题 → 与正文同
 *  字号、次级色的说明区 → 分隔线上的操作区（11-20 UI 反馈）。 */
function ConfirmCardBody({
  confirm,
  busy,
  messageId,
  onConfirm,
}: {
  confirm: NonNullable<ChatMessage["content"]["confirm"]>;
  busy: boolean;
  messageId: string;
  onConfirm: (
    messageId: string,
    action: "confirm" | "cancel",
    overrides?: { projectId?: string; workflowVersionId?: string }
  ) => void;
}) {
  const { t } = useTranslation();
  const settled = Boolean(confirm.state);
  const opts = confirm.options;
  const projects = opts?.projects ?? [];

  // 预填：agent hint 匹配 > 单项目自动
  const [projectId, setProjectId] = useState(() => {
    if (projects.length === 1) return projects[0].id;
    const hint = confirm.projectHint ?? "";
    const m = projects.find((p) => hint && (hint.includes(p.name) || p.name.includes(hint)));
    return m?.id ?? "";
  });
  const workflowsFor = projectId ? (opts?.workflows?.[projectId] ?? []) : [];
  const [wfVersionId, setWfVersionId] = useState(() => {
    const hint = confirm.workflowHint ?? "";
    const m = workflowsFor.find((w) => hint && (hint.includes(w.name) || w.name.includes(hint)));
    if (m) return m.id;
    const bound = projects.find((p) => p.id === projectId);
    return bound?.boundWorkflowVersionId ?? "";
  });
  const selectedWf = workflowsFor.find((w) => w.id === wfVersionId);
  const boundProject = projects.find((p) => p.id === projectId);
  const isOverride = selectedWf && boundProject && selectedWf.id !== boundProject.boundWorkflowVersionId;

  return (
    <div className="flex w-full flex-col gap-3">
      {/* 眉头：状态徽标（待确认=主题色 / 已决=中性灰） */}
      <div className="flex flex-col gap-2">
        <span
          className={`inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-caption-sm-medium ${
            settled ? "bg-layer-3 text-tertiary" : "bg-accent-primary/10 text-accent-primary"
          }`}
        >
          {settled ? t("agent_teams_chat_confirm_settled") : t("agent_teams_chat_confirm_pending")}
        </span>
        <div className="text-body-sm-medium">{confirm.title}</div>
      </div>
      {/* 项目与流程选择（11-23 确认卡升级：预设+用户可改+单卡覆盖） */}
      {!settled && projects.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className="w-10 shrink-0 text-caption-sm-medium text-tertiary">
              {t("agent_teams_chat_confirm_project")}
            </span>
            <div className="flex-1">
              <FormSelect
                value={projectId}
                placeholder={t("agent_teams_chat_confirm_project_select")}
                options={projects.map((p) => ({ id: p.id, name: p.name }))}
                onChange={(v) => {
                  setProjectId(v);
                  const p = projects.find((x) => x.id === v);
                  setWfVersionId(p?.boundWorkflowVersionId ?? "");
                }}
              />
            </div>
          </div>
          {projectId && workflowsFor.length > 0 && (
            <div className="flex items-center gap-3">
              <span className="w-10 shrink-0 text-caption-sm-medium text-tertiary">
                {t("agent_teams_chat_confirm_workflow")}
              </span>
              <div className="flex-1">
                <FormSelect
                  value={wfVersionId}
                  placeholder={t("agent_teams_chat_confirm_project_select")}
                  options={workflowsFor.map((w) => ({
                    id: w.id,
                    name: `${w.name}（v${w.version}）`,
                  }))}
                  onChange={setWfVersionId}
                />
              </div>
            </div>
          )}
          {isOverride && (
            <p className="text-caption-sm-regular text-accent-primary">{t("agent_teams_chat_confirm_override_hint")}</p>
          )}
        </div>
      )}
      {/* 说明区：与正文字号一致（text-body-sm），用次级色和标题拉开层级——
          无底色块（11-20 反馈：弱底色圆角块显笨重） */}
      {confirm.description && (
        <div className="text-body-sm-regular leading-relaxed whitespace-pre-wrap text-secondary">
          {confirm.description}
        </div>
      )}
      {/* 操作区：分隔线上方留白；已决态不渲染按钮 */}
      {!settled && (
        <div className="flex items-center gap-2 border-t border-subtle pt-3">
          <Button
            variant="primary"
            size="sm"
            disabled={busy || (projects.length > 1 && !projectId)}
            onClick={() =>
              onConfirm(messageId, "confirm", {
                projectId: projectId || undefined,
                workflowVersionId: wfVersionId || undefined,
              })
            }
          >
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
  // 稳定错误码 → 文案；rate_limit 的 detail 已被后端提取成具体人话（如「限额…
  // 重置」），优先展示——其余 code 的 detail 是排障文本，不渲染（D1 口径，与
  // work-item-runtime-panel 同源）。
  const messageKey = (AGENT_ERROR_MESSAGE_KEYS as Record<string, string>)[error.code] ?? "agent_teams_chat_error";
  const message = displayErrorDetail(error.code as AgentErrorCode, error.detail) || t(messageKey);
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="text-body-sm-regular text-secondary">{message}</div>
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
