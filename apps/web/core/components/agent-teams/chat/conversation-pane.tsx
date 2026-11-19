/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * 会话面板（单会话实例）：消息流 + 流式气泡 + 输入区 + 贴回卡片弹层。
 * 所有会话内状态（messages/streaming/sending/确认卡/预填/分享）内聚于本组件，
 * 页面以 key={会话id} 挂载——切换会话即销毁重建实例，状态隔离是结构保证
 * （不靠手动清理；曾因页面级单例 streaming state 泄漏到其他会话，2026-11-19 重构）。
 * 在途流随实例卸载 abort；partial 由后端 GeneratorExit 落库，重新进入拉历史可见。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";

import { ChatComposer, type PendingAttachment } from "./chat-composer";
import { MessageBubble, StreamingBubble } from "./message-bubble";
import { ShareModal } from "./modals";
import type { ChatMessage, ChatSession, StreamingAssistant } from "./types";
import chatService from "@/services/agent-teams/chat.service";
import { shareMessageToCard } from "@/services/agent-teams/agent-chat.service";

export function ConversationPane({
  workspaceSlug,
  session,
  onSessionsRefresh,
  onOpenCard,
}: {
  workspaceSlug: string;
  session: ChatSession;
  /** 会话侧变化（未读清除/预览刷新）通知页面层重拉列表 */
  onSessionsRefresh: () => void;
  onOpenCard: (projectId: string, issueId: string) => void;
}) {
  const { t } = useTranslation();
  const conversationId = session.id;

  // ── 实例内会话状态 ───────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingAssistant | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState("");
  const [summaryHintGone, setSummaryHintGone] = useState(false);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>();
  const [shareMessage, setShareMessage] = useState<ChatMessage | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  // 渲染节流（协议 v2 §六）：delta 高频，按动画帧合并后一次 setState，
  // 避免每 token 全文 markdown 重渲染
  const tokenBufRef = useRef("");
  const rafRef = useRef<number | null>(null);

  // 挂载：拉历史 + 在场即读（列表未读由回调清除）；摘要提示 8 秒后淡出
  useEffect(() => {
    let cancelled = false;
    void chatService.listMessages(workspaceSlug, conversationId).then((list) => {
      if (!cancelled) setMessages(list);
      return null;
    });
    void chatService.markRead(workspaceSlug, conversationId).then(() => {
      onSessionsRefresh();
      return null;
    });
    const timer = setTimeout(() => setSummaryHintGone(true), 8000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      abortRef.current?.abort(); // 卸载即中止在途流（实例销毁，状态随之清空）
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, conversationId]);

  // 流式输出时钉在最新内容
  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [messages, streaming]);

  // ── 发送（乐观插入 + 流式 + done 快照定稿，零回拉——协议 v2） ──
  const handleSend = useCallback(
    async (text: string, attachments: PendingAttachment[], webSearch: boolean) => {
      if (sending) return;
      const attachmentIds = attachments.map((f) => f.id);
      const userLocalId = `local_${Date.now()}_u`;
      const assistantLocalId = `local_${Date.now()}_a`;
      const now = new Date().toISOString();
      setSending(true);
      setMessages((prev) => [
        ...prev,
        {
          id: userLocalId, role: "user", kind: "text",
          content: { text },
          attachments: attachments.map((f) => ({ id: f.id, name: f.name })),
          streamingOffset: 0, createdAt: now,
        },
      ]);
      setStreaming({ id: assistantLocalId, text: "", sourceCount: 0 });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await chatService.streamTurn(
          workspaceSlug,
          conversationId,
          text,
          {
            signal: controller.signal,
            webSearchEnabled: webSearch,
            onToken: (token) => {
              // 动画帧批处理：帧内多个 delta 合并成一次 setState（协议 v2 §六）
              tokenBufRef.current += token;
              if (rafRef.current == null) {
                rafRef.current = requestAnimationFrame(() => {
                  const batch = tokenBufRef.current;
                  tokenBufRef.current = "";
                  rafRef.current = null;
                  setStreaming((prev) => (prev ? { ...prev, text: prev.text + batch } : prev));
                });
              }
            },
            onStage: (stage) => setStreaming((prev) => (prev ? { ...prev, stage } : prev)),
            onDone: (done) => {
              // 清残留节流（未 flush 的 delta 丢弃，定稿以 done.content 为准）
              if (rafRef.current != null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
                tokenBufRef.current = "";
              }
              // 协议 v2：done 快照定稿——替换乐观占位（user/assistant 的 local id
              // 换成真实 id），kind/content 用快照；不再回拉 listMessages
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id === userLocalId) return { ...m, id: done.userMessageId ?? m.id };
                  if (m.id === assistantLocalId)
                    return { ...m, id: done.messageId, kind: done.kind, content: { text: done.content.text ?? "" } };
                  return m;
                })
              );
              setStreaming(null);
            },
            onError: (normalized) => setStreaming((prev) => (prev ? { ...prev, error: normalized } : prev)),
          },
          attachmentIds
        );
        // done 已定稿；此处仅在场即读 + 列表预览刷新（活跃会话未读恒清）
        void chatService
          .markRead(workspaceSlug, conversationId)
          .then(() => onSessionsRefresh());
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // 停止：本地用 partial 定稿「已中断」，不回拉（后端 GeneratorExit 落库
          // 供下次进入恢复；本次显示以前端本地 partial 为准）
          let partial = "";
          setStreaming((current) => {
            partial = current?.text ?? "";
            return null;
          });
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantLocalId ? { ...m, content: { text: partial, interrupted: true } } : m
            )
          );
        } else {
          // 失败收敛：partial + 错误折成一条历史消息（不留悬挂空气泡）
          setStreaming((current) => {
            if (current) {
              setMessages((prev) => [
                ...prev,
                {
                  id: current.id, role: "agent", kind: "text",
                  content: {
                    text: current.text,
                    error: { code: "network", detail: t("agent_teams_chat_send_failed") },
                  },
                  attachments: [], streamingOffset: 0, createdAt: new Date().toISOString(),
                },
              ]);
            }
            return null;
          });
        }
      } finally {
        setSending(false);
        abortRef.current = null;
      }
    },
    [conversationId, sending, workspaceSlug, t, onSessionsRefresh]
  );

  const handleStop = useCallback(() => abortRef.current?.abort(), []);

  // ── 确认卡（L1：确认创建走闸门链 / 取消） ────────────────────
  const handleConfirmCard = useCallback(
    async (messageId: string, action: "confirm" | "cancel") => {
      setConfirmBusy(messageId);
      try {
        const res = await chatService.confirmCard(workspaceSlug, conversationId, messageId, action);
        // 协议 v2 §五：操作响应定点更新——确认卡就地改 state，确认时追加新流程卡
        setMessages((prev) => {
          let next = res.confirmedCard
            ? prev.map((m) => (m.id === messageId ? { ...m, content: res.confirmedCard!.content, kind: res.confirmedCard!.kind } : m))
            : prev;
          if (res.flowCard) next = [...next, res.flowCard];
          return next;
        });
      } catch (err) {
        const msg = (err as Error).message || "";
        const detail = msg.includes("PROJECT_NOT_BOUND")
          ? t("agent_teams_chat_confirm_not_bound")
          : msg.includes("PROJECT_AMBIGUOUS")
            ? t("agent_teams_chat_confirm_ambiguous")
            : msg.includes("CONFIRM_SETTLED")
              ? t("agent_teams_chat_confirm_settled")
              : t("agent_teams_chat_error");
        setToast({ type: TOAST_TYPE.ERROR, title: t("common.error"), message: detail });
      } finally {
        setConfirmBusy("");
      }
    },
    [workspaceSlug, conversationId, t]
  );

  // ── 预算检查点三选（继续/转流程卡 → 预填输入；停止 → 保留 partial） ──
  const handleCheckpoint = useCallback(
    (option: "continue" | "convert" | "stop") => {
      if (option === "stop") return;
      setPrefill({
        text: option === "continue"
          ? `${t("agent_teams_chat_continue")}——`
          : t("agent_teams_chat_convert_prompt"),
        nonce: Date.now(),
      });
    },
    [t]
  );

  // ── 贴回卡片（弹层自持卡列表加载与后端检索；此处仅记录待分享消息） ──
  const handleShare = useCallback(
    async (issueId: string, issueName: string) => {
      if (!shareMessage) return;
      setShareBusy(true);
      try {
        const res = await shareMessageToCard(workspaceSlug, conversationId, shareMessage.id, issueId);
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("common.success"),
          message: t("agent_teams_chat_shared", { name: issueName }),
        });
        setShareMessage(null);
        // 协议 v2 §五：操作响应定点更新——原消息 content 已带 sharedTo 回执
        if (res.sharedMessage) {
          setMessages((prev) =>
            prev.map((m) => (m.id === shareMessage.id ? { ...m, content: res.sharedMessage!.content } : m))
          );
        }
      } catch {
        setToast({ type: TOAST_TYPE.ERROR, title: t("common.error"), message: t("agent_teams_chat_error") });
      } finally {
        setShareBusy(false);
      }
    },
    [workspaceSlug, conversationId, shareMessage, t]
  );

  return (
    <>
      <div className="flex h-full min-w-0 flex-grow flex-col">
        <div ref={streamRef} className="flex min-h-0 flex-grow flex-col gap-5 overflow-y-auto p-5">
          {messages.length === 0 && !streaming && (
            <div className="m-auto text-body-sm-regular text-tertiary">{t("agent_teams_chat_empty")}</div>
          )}
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              busy={confirmBusy === message.id}
              onConfirmCard={handleConfirmCard}
              onCheckpoint={handleCheckpoint}
              onShare={setShareMessage}
              onOpenCard={onOpenCard}
            />
          ))}
          {streaming && <StreamingBubble streaming={streaming} onCheckpoint={handleCheckpoint} />}
        </div>
        <ChatComposer
          workspaceSlug={workspaceSlug}
          disabled={false}
          sending={sending}
          showSummaryHint={Boolean(session.summaryCompacted) && !summaryHintGone}
          onStop={handleStop}
          onSend={handleSend}
          prefill={prefill}
        />
      </div>

      <ShareModal
        open={Boolean(shareMessage)}
        workspaceSlug={workspaceSlug}
        teamId={session.teamId}
        busy={shareBusy}
        onClose={() => setShareMessage(null)}
        onShare={(issueId, name) => void handleShare(issueId, name)}
      />
    </>
  );
}
