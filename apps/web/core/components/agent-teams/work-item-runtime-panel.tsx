/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — 工作卡「团队执行」叙事流面板（2026-11-04 #3 终版）。
 * 形态：单列时间流（团队归属一行做标题，当前步骤即状态，无独立状态条）——
 * 事件按节点归并成步骤：名称 · 执行者 · 状态（复用工作卡状态渲染/状态枚举
 * 文案）· 耗时；每步结论一句内联（超两行截断就地展开）；产出挂对应步骤；
 * 审批操作内嵌等待步骤；未来步骤「排队中」；当前步呼吸灯 + 秒级跳动；
 * 面板自动滚动到当前步；执行中轮询 2s。取消/重试/手动启动沿既有端点。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { observer } from "mobx-react";
import useSWR, { useSWRConfig } from "swr";
// i18n
import { useTranslation } from "@plane/i18n";
// plane imports
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EModalWidth, ModalCore } from "@plane/ui";
// icons
import { Check, ChevronDown, Clock, Minus, X } from "lucide-react";

// components
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
import { ApprovalAnswerArea } from "@/components/agent-teams/approval-answer";
import { ApprovalAttachmentUpload, type AnswerAttachment } from "@/components/agent-teams/approval-attachments";
import { MarkdownPreview } from "@/components/agent-teams/markdown-preview";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import Link from "next/link";
// services
import {
  orchestrationService,
  type AgentErrorCode,
  type OrchestrationRuntimeArtifact,
  type OrchestrationTimelineEvent,
  type OrchestrationWorkItemRuntime,
} from "@/services/agent-teams/orchestration.service";

type WorkItemRuntimePanelProps = {
  issueId: string;
  workspaceSlug: string;
  projectId: string;
  /** 保留入参兼容调用方；新域无投影延迟窗口，不再使用。 */
  issueCreatedAt?: string | null;
};

const TERMINAL = new Set(["completed", "cancelled", "failed"]);
const STEP_ACTIVE = new Set(["running", "pending", "queued"]);
const AGENT_ERROR_MESSAGE_KEYS: Record<AgentErrorCode, string> = {
  rate_limit: "agent_teams_error_rate_limit",
  timeout: "agent_teams_error_timeout",
  empty_reply: "agent_teams_error_empty_reply",
  not_deployed: "agent_teams_error_not_deployed",
  configuration_error: "agent_teams_error_configuration_error",
  agent_error: "agent_teams_error_agent_error",
};
const AGENT_TEAM_ERROR_CODES = new Set<AgentErrorCode>(["not_deployed", "configuration_error"]);

/** 步骤（叙事流的行单位）：同一节点的事件归并成一步。 */
interface StreamStep {
  key: string;
  name: string;
  memberName: string | null;
  status: string;
  firstAt: string;
  lastAt: string;
  /** 节点输出正文（结论行：内联截断 + 就地展开，统一不走弹层）。 */
  output: string | null;
  /** 失败节点的稳定错误码（前端产品文案使用）。 */
  errorCode: AgentErrorCode | null;
  /** 受控的排障详情，不作为主错误文案直接展示。 */
  errorDetail: string | null;
  /** 审批/求助的答复文本（选项文案或人工补充资料）——状态位后缀呈现。 */
  answer: string | null;
  artifact: OrchestrationRuntimeArtifact | null;
}

function durationText(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const WorkItemRuntimePanel = observer(function WorkItemRuntimePanel({
  issueId,
  workspaceSlug,
  projectId,
}: WorkItemRuntimePanelProps) {
  const { t } = useTranslation();
  const { mutate } = useSWRConfig();
  const { agentTeamDetailPath } = useAgentTeamsLinks();
  // 轮询间隔回调必须 useCallback 稳定引用：SWR 的轮询 effect 以
  // [refreshInterval, ...] 为依赖，内联箭头函数每次渲染都是新引用——
  // 面板每秒秒跳重渲染会把 2s 的 setTimeout 反复清掉，轮询静默失效
  // （2026-11-05 服务端日志实证：请求间隔 20-60s）
  const pollInterval = useCallback(
    (latest: OrchestrationWorkItemRuntime | null | undefined) =>
      latest && !TERMINAL.has(latest.businessStatus) ? 2000 : 0,
    []
  );
  // 执行中 2s 轮询（准直播），终态/未绑定停（#3）。dedupingInterval 降到
  // 1s：轮询 revalidate 带 WITH_DEDUPE，默认 2s 去重窗与 2s 轮询同窗会吞拍
  const {
    data: summary,
    mutate: mutateSummary,
    isLoading,
  } = useSWR(
    workspaceSlug && projectId && issueId
      ? (["orchestration", "work-item-runtime", projectId, issueId] as const)
      : null,
    () => orchestrationService.getWorkItemRuntime(workspaceSlug, projectId, issueId),
    {
      refreshInterval: pollInterval,
      dedupingInterval: 1000,
      shouldRetryOnError: false,
    }
  );
  const pendingStart = !!summary && (summary as { pendingStart?: boolean }).pendingStart;
  const timeline: OrchestrationTimelineEvent[] = summary?.timeline ?? [];
  const loading = isLoading && !summary;
  const [answering, setAnswering] = useState("");
  const [textAnswer, setTextAnswer] = useState("");
  const [answerAttachments, setAnswerAttachments] = useState<AnswerAttachment[]>([]);
  // C7：待答审批变化时从服务端挂载恢复附件列表（刷新不丢）；
  // 同时清空上一轮作答残留的文字（新一轮问题不该带出旧输入）
  // 仅按审批 id 变化重置；依赖 attachments 会让本地增删被轮询刷新覆盖
  useEffect(() => {
    setAnswerAttachments((summary?.pendingApproval?.attachments ?? []).map((a) => ({ id: a.id, name: a.name })));
    setTextAnswer("");
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 报告锚点在依赖数组行
  }, [summary?.pendingApproval?.id]);
  const [cancelling, setCancelling] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const isActive = !!summary && !TERMINAL.has(summary.businessStatus);
  // 秒级跳动：执行中每秒刷新一次（呼吸灯耗时的「活」感，#3 准直播）
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isActive]);

  // 叙事流步骤：事件按 nodeKey 归并（approval 事件并入同节点）
  const steps: StreamStep[] = useMemo(() => {
    const byNode = new Map<string, StreamStep>();
    for (const event of summary?.timeline ?? []) {
      if (event.kind === "execution" || !event.nodeKey) continue;
      const name = event.nodeName || event.nodeKey;
      const existing = byNode.get(event.nodeKey);
      if (!existing) {
        byNode.set(event.nodeKey, {
          key: event.nodeKey,
          name,
          memberName: event.memberName ?? null,
          status: event.kind === "node" ? event.status : "pending",
          firstAt: event.createdAt,
          lastAt: event.createdAt,
          output: event.output ?? null,
          errorCode: event.errorCode ?? null,
          errorDetail: event.errorDetail ?? null,
          answer: null,
          artifact: null,
        });
      } else {
        existing.lastAt = event.createdAt;
        // 状态只由节点事件驱动：求助答复后同节点重跑（running）不得被
        // 审批事件（approved）盖掉——曾致当前步识别丢失（无呼吸灯）
        if (event.kind === "node") existing.status = event.status;
        if (event.memberName) existing.memberName = event.memberName;
        if (event.kind === "node" && event.errorCode) {
          existing.errorCode = event.errorCode;
          existing.errorDetail = event.errorDetail ?? null;
        }
        if (event.kind === "approval" && event.output) existing.answer = event.output;
        else if (event.output) existing.output = event.output;
      }
    }
    const result = Array.from(byNode.values());
    // 产出挂到对应步骤（最新版本优先）
    for (const artifact of summary?.artifacts ?? []) {
      if (!artifact.nodeKey) continue;
      const step = byNode.get(artifact.nodeKey);
      if (step) step.artifact = artifact;
    }
    return result;
  }, [summary]); // timeline/artifacts 均为 summary 派生，锚定整体引用

  const currentStepKey = useMemo(() => {
    if (summary?.pendingApproval) return summary.pendingApproval.nodeRef;
    const active = steps.find((step) => STEP_ACTIVE.has(step.status));
    return active?.key ?? null;
  }, [steps, summary?.pendingApproval]);

  // 自动滚动到当前步（面板在 peek 内滚动，nearest 不惊动页面）
  const currentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentStepKey]);

  const refresh = useCallback(async () => {
    await mutateSummary();
  }, [mutateSummary]);

  // Runtime progress also lands in NATIVE Plane state and the activity feed —
  // neither refreshes on its own. When the runtime view advances, pull both.
  const { fetchIssue, fetchActivities } = useIssueDetail();
  const runtimeSignature = [summary?.businessStatus ?? "", summary?.currentMemberName ?? "", timeline.length].join("|");
  useEffect(() => {
    if (!summary) return;
    void fetchIssue(workspaceSlug, projectId, issueId);
    void fetchActivities(workspaceSlug, projectId, issueId);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 报告锚点在依赖数组行
  }, [runtimeSignature]);

  const handleAnswer = useCallback(
    async (decision: "approved" | "rejected", reason: string, attachmentIds: string[] = []) => {
      const approval = summary?.pendingApproval;
      if (!approval) return;
      setAnswering(decision);
      try {
        const resp = await orchestrationService.answerApproval(
          workspaceSlug,
          approval.id,
          decision,
          reason || undefined,
          attachmentIds.length ? attachmentIds : undefined
        );
        // C4：附件解析结果汇总回告（提交了附件才提示，避免无附件时噪音）
        const results = resp?.attachmentResults;
        if (results?.length) {
          const lines: string[] = [];
          const okCount = results.filter((r) => r.status === "ok").length;
          if (okCount > 0) lines.push(t("agent_teams_inbox_answer_result_ok", { count: okCount }));
          for (const r of results.filter((x) => x.status !== "ok")) {
            if (r.status === "scan_or_empty") lines.push(t("agent_teams_inbox_answer_result_scan", { name: r.name }));
            else if (r.status === "not_uploaded")
              lines.push(t("agent_teams_inbox_answer_result_not_uploaded", { name: r.name }));
            else lines.push(t("agent_teams_inbox_answer_result_unreadable", { name: r.name }));
          }
          const allOk = okCount === results.length;
          setToast({
            type: allOk ? TOAST_TYPE.SUCCESS : TOAST_TYPE.ALERT,
            title: allOk ? t("agent_teams_inbox_answer_result_done") : t("agent_teams_inbox_answer_result_partial"),
            message: lines.join("\n"),
          });
        }
        await refresh();
        // C9：作答后失效收件箱缓存（两入口作答态互通——徽标/列表即时收敛）
        mutate((key) => Array.isArray(key) && key[0] === "agent-teams");
      } catch {
        // Errors surface via the notifications inbox; the panel keeps its state.
      } finally {
        setAnswering("");
      }
    },
    [summary, refresh, workspaceSlug, t, mutate]
  );

  // 手动启动兜底（pendingStart 态）：同受控启动链
  const [starting, setStarting] = useState(false);
  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      await orchestrationService.startExecution(workspaceSlug, projectId, issueId);
      await refresh();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("error"), message: String((error as Error)?.message ?? error) });
    } finally {
      setStarting(false);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- t 每渲染新引用，既往教训
  }, [refresh, workspaceSlug, projectId, issueId]);

  const handleCancel = useCallback(async () => {
    setCancelling(true);
    try {
      await orchestrationService.cancelWorkItemExecution(workspaceSlug, projectId, issueId);
      await refresh();
    } catch {
      // Cancel failures keep the panel state; status re-poll reconciles.
    } finally {
      setCancelling(false);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- t 每渲染新引用，既往教训
  }, [refresh, workspaceSlug, projectId, issueId]);

  // 重试=终态后重新受控启动（同工作项新执行，绑定校验链照走）
  const [retryConfirmOpen, setRetryConfirmOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const handleRetry = useCallback(async () => {
    setRetryError(null);
    setRetrying(true);
    try {
      await orchestrationService.startExecution(workspaceSlug, projectId, issueId);
      setRetryConfirmOpen(false);
      // 串行有界重拉：终态无轮询可恢复，必须逐次确认（并行无意义）
      for (let attempt = 0; attempt < 10; attempt += 1) {
        // oxlint-disable-next-line eslint(no-await-in-loop)
        await refresh();
        // oxlint-disable-next-line eslint(no-await-in-loop)
        const status = (await mutateSummary())?.businessStatus ?? "";
        if (status && !TERMINAL.has(status)) break;
        // oxlint-disable-next-line eslint(no-await-in-loop)
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      setRetryError((error as Error).message ?? String(error));
    } finally {
      setRetrying(false);
    }
  }, [refresh, mutateSummary, workspaceSlug, projectId, issueId]);

  const isTerminal = summary ? TERMINAL.has(summary.businessStatus) : false;

  const toggleStepExpanded = (key: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 步骤状态图标：细线轻量款——✓/✗/− 裸图标（无圆盘底色，不抢步骤名），
      当前步呼吸点，未来步空心圈。颜色只用平台语义 token。 */
  const renderStepIcon = (step: StreamStep) => {
    const isCurrent = step.key === currentStepKey;
    if (step.status === "success") {
      return <Check className="size-4 flex-shrink-0 text-success-primary" strokeWidth={2.5} aria-hidden />;
    }
    if (step.status === "failed") {
      return <X className="size-4 flex-shrink-0 text-danger-primary" strokeWidth={2.5} aria-hidden />;
    }
    if (step.status === "skipped") {
      return <Minus className="size-4 flex-shrink-0 text-placeholder" strokeWidth={2.5} aria-hidden />;
    }
    if (step.status === "cancelled") {
      // 语义区分：失败执行中的未完成步骤=中止（−）；取消执行=已取消（✗）
      return summary?.businessStatus === "failed" ? (
        <Minus className="size-4 flex-shrink-0 text-placeholder" strokeWidth={2.5} aria-hidden />
      ) : (
        <X className="size-4 flex-shrink-0 text-placeholder" strokeWidth={2.5} aria-hidden />
      );
    }
    if (isCurrent) {
      return (
        <span className="relative grid size-4 flex-shrink-0 place-items-center" aria-hidden>
          <span className="absolute inline-flex size-4 animate-ping rounded-full bg-accent-primary opacity-30" />
          <span className="relative inline-flex size-2 rounded-full bg-accent-primary" />
        </span>
      );
    }
    return (
      <span className="grid size-4 flex-shrink-0 place-items-center" aria-hidden>
        <span className="border-placeholder size-2 rounded-full border-[1.5px]" />
      </span>
    );
  };

  const stepDuration = (step: StreamStep): string | null => {
    const start = new Date(step.firstAt).getTime();
    if (Number.isNaN(start)) return null;
    const end = step.key === currentStepKey && isActive ? nowTick : new Date(step.lastAt).getTime();
    if (Number.isNaN(end) || end <= start) return null;
    return durationText((end - start) / 1000);
  };

  const stepStatusText = (step: StreamStep): string => {
    if (step.key === currentStepKey && summary?.pendingApproval) {
      const waited = Math.round((nowTick - new Date(step.firstAt).getTime() || 0) / 60000);
      return t("agent_teams_panel_waiting_for", { count: Math.max(waited, 1) });
    }
    if (step.status === "cancelled" && summary?.businessStatus === "failed") {
      return t("agent_teams_status_aborted");
    }
    const statusKey = `agent_teams_status_${step.status}`;
    const statusText = t(statusKey);
    const base =
      statusText !== statusKey ? statusText : step.status === "pending" ? t("agent_teams_status_queued") : step.status;
    // 已答复的审批/求助：答复作后缀（选项文案或人工补充），不顶掉节点状态
    return step.answer ? `${base} · ${step.answer}` : base;
  };

  /** 结论行：所有产出统一内联折叠——超两行截断，就地展开看全文
      （展开态限高滚动；工件正文优先取 artifact.content 全文）。 */
  const renderConclusion = (step: StreamStep) => {
    const rawContent = (step.artifact?.content ?? step.output)?.trim();
    const hasAgentError = step.status === "failed" && step.errorCode;
    const errorMessage = hasAgentError ? t(AGENT_ERROR_MESSAGE_KEYS[step.errorCode as AgentErrorCode]) : "";
    const content = hasAgentError ? (errorMessage || step.errorCode) : rawContent;
    if (!content) return null;
    // 原始报错只留 worker 日志与节点记录（DB），不进 UI（D1 口径 11-16 定：
    // 用户只见人话 + 引导动作；errorDetail 字段后端照带，前端不渲染，
    // 将来若做管理员诊断视图再恢复）
    const expanded = expandedSteps.has(step.key);
    const isLong = content.length > 80 || content.split("\n").length > 2;
    return (
      <div className="mt-1 min-w-0">
        {/* 展开收起均渲染 markdown：收起态高度截断（两行 40px）+ 底部
            渐隐（line-clamp 对块级内容无效，高度截断是块级内容的标准收敛） */}
        <div className={`relative ${!expanded && isLong ? "max-h-10 overflow-hidden" : ""}`}>
          <MarkdownPreview content={content} className="prose-p:my-1 prose-pre:my-1.5 text-body-xs-regular leading-5" />
          {!expanded && isLong && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-[var(--background-color-layer-1)] to-transparent"
              aria-hidden
            />
          )}
        </div>
        {hasAgentError && AGENT_TEAM_ERROR_CODES.has(step.errorCode as AgentErrorCode) ? (
          <Link
            href={agentTeamDetailPath(summary?.teamId ?? "")}
            className="hover:text-accent-hover mt-1 inline-flex text-body-xs-medium text-accent-primary"
          >
            {t("agent_teams_error_view_team")}
          </Link>
        ) : null}
        {isLong && (
          <button
            type="button"
            onClick={() => toggleStepExpanded(step.key)}
            className="hover:text-accent-hover mt-0.5 inline-flex items-center gap-0.5 text-body-xs-medium text-accent-primary"
          >
            <ChevronDown className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
            {expanded ? t("agent_teams_stream_collapse") : t("agent_teams_stream_expand")}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="w-full" data-issue-id={issueId}>
      {/* 区块标题：团队归属一行（链接直达团队页）——当前步骤即状态，
          不再有独立状态条（#3 终版） */}
      <h5 className="mt-5 flex items-center gap-1.5 text-body-xs-medium text-secondary">
        {summary ? (
          <>
            {t("agent_teams_panel_executed_by_prefix")}
            <Link href={agentTeamDetailPath(summary.teamId)} className="hover:text-accent-hover text-accent-primary">
              {summary.teamName}
            </Link>
            {t("agent_teams_panel_executed_by_suffix")}
          </>
        ) : (
          t("agent_teams_panel_title")
        )}
        {summary?.durationSeconds != null && (
          <span className="font-normal ml-auto flex items-center gap-1 text-body-xs-regular text-tertiary">
            <Clock className="size-3" aria-hidden />
            {durationText(summary.durationSeconds)}
          </span>
        )}
      </h5>

      <div className="mt-3 mb-2">
        {loading ? (
          <div className="px-0.5 py-1.5 text-body-xs-regular text-placeholder">{t("agent_teams_inbox_loading")}</div>
        ) : pendingStart ? (
          // 已绑定但尚未启动（历史卡/自动启动失败）：给手动启动兜底
          <div className="flex items-center justify-between px-0.5 py-1.5">
            <span className="text-body-xs-regular text-placeholder">{t("agent_teams_status_queued")}</span>
            <button
              type="button"
              disabled={starting}
              onClick={() => void handleStart()}
              className="hover:text-accent-hover text-body-xs-medium text-accent-primary disabled:opacity-60"
            >
              {starting ? t("agent_teams_panel_retrying") : t("agent_teams_panel_retry")}
            </button>
          </div>
        ) : !summary ? (
          <div className="px-0.5 py-1.5 text-body-xs-regular text-placeholder">{t("agent_teams_panel_not_bound")}</div>
        ) : (
          <>
            {/* 单列叙事流：固定图标列（16px）与标题行（20px）等高对齐，
                连接线从徽章中心垂直贯穿；字号两级（13 标题 / 12 辅助），
                行距节奏统一（步内 2/4px、步间 16px） */}
            <div className="flex flex-col">
              {steps.map((step, index) => {
                const isCurrent = step.key === currentStepKey;
                const isLast = index === steps.length - 1 && (summary.upcomingSteps ?? []).length === 0;
                const approval = isCurrent ? summary.pendingApproval : null;
                const duration = stepDuration(step);
                return (
                  <div
                    key={step.key}
                    ref={isCurrent ? currentRef : undefined}
                    className={`relative ${isLast ? "" : "border-l pb-4"} ${
                      isCurrent ? "border-accent-primary" : "border-subtle"
                    } pl-4`}
                  >
                    {/* 图标压线：实心徽章本身不透（hollow 圈穿线为常规时间轴形态） */}
                    <span className="absolute top-[4px] -left-[10px] rounded-full bg-[var(--background-color-layer-1)] p-0.5">
                      {renderStepIcon(step)}
                    </span>
                    {/* hover 色块为内层包裹条（hug 内容、垂直居中），不承载连线 */}
                    <div className="-mx-1.5 flex gap-2.5 rounded-md px-2 py-1 transition-colors hover:bg-layer-transparent-hover">
                      {/* 内容列 */}
                      <div className="min-w-0 flex-1">
                        {/* 标题行 = 一句话：成员（谁）· 步骤名（做什么）· 状态（怎么样）；
                          右侧：查看产出（有工件时内联，不单独占行）+ 耗时 */}
                        <div className="flex h-5 items-center justify-between gap-2">
                          <span className="truncate text-body-xs-regular">
                            {step.memberName && (
                              <span className="text-body-xs-medium text-primary">{step.memberName}</span>
                            )}
                            {step.memberName && <span className="text-placeholder"> · </span>}
                            <span className={isCurrent ? "text-primary" : "text-secondary"}>{step.name}</span>
                            <span className="text-placeholder"> · </span>
                            <span
                              className={
                                isCurrent
                                  ? "text-accent-primary"
                                  : step.status === "failed"
                                    ? "text-danger-primary"
                                    : "text-tertiary"
                              }
                            >
                              {stepStatusText(step)}
                            </span>
                          </span>
                          <span className="flex flex-shrink-0 items-center gap-2">
                            {duration && (
                              <span className="text-body-xs-regular text-placeholder" title={step.firstAt}>
                                {duration}
                              </span>
                            )}
                          </span>
                        </div>
                        {/* 每步产出统一内联折叠（超两行截断就地展开，展开限高滚动） */}
                        {renderConclusion(step)}
                        {/* 审批操作内嵌等待步骤：待确认内容（agent 归纳的
                          markdown，规范渲染）+ 操作区。前几步已在流里逐步
                          呈现，审批卡不重复罗列，只带需要拍板的内容 */}
                        {approval && (
                          <div className="mt-2 flex flex-col gap-2 rounded-lg border border-subtle bg-layer-2 px-3 py-2.5">
                            <MarkdownPreview content={approval.question || approval.taskTitle} />
                            <ApprovalAnswerArea
                              approval={{
                                freeText: approval.freeText,
                                options: approval.options ?? [],
                                humanNode: approval.humanNode,
                                customOptions: approval.customOptions,
                              }}
                              answering={answering}
                              textAnswer={textAnswer}
                              onTextChange={setTextAnswer}
                              attachmentIds={answerAttachments.map((a) => a.id)}
                              attachmentSlot={
                                <ApprovalAttachmentUpload
                                  workspaceSlug={workspaceSlug}
                                  approvalId={summary?.pendingApproval?.id}
                                  attachments={answerAttachments}
                                  onAttachmentsChange={setAnswerAttachments}
                                  disabled={answering !== ""}
                                />
                              }
                              onAnswer={(decision, reason, _key, attachmentIds) =>
                                void handleAnswer(decision, reason, attachmentIds ?? [])
                              }
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {/* 未来步骤「排队中」（剪枝感知） */}
              {(summary.upcomingSteps ?? []).map((name, index, list) => (
                <div
                  key={`upcoming-${name}`}
                  className={`relative pl-4 ${index === list.length - 1 ? "" : "border-l border-dashed border-subtle pb-4"}`}
                >
                  <span
                    className="absolute top-[7px] -left-[7px] rounded-full bg-[var(--background-color-layer-1)] p-0.5"
                    aria-hidden
                  >
                    <span className="border-placeholder block size-2.5 rounded-full border-[1.5px]" />
                  </span>
                  <div className="-mx-1.5 flex gap-2.5 rounded-md px-2 py-1 transition-colors hover:bg-layer-transparent-hover">
                    <div className="flex h-5 min-w-0 flex-1 items-center">
                      <span className="text-body-xs-regular text-placeholder">
                        {name} · {t("agent_teams_stream_queued")}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* 次要操作行：取消（进行中）/ 重试（终态可重试） */}
            {(!isTerminal || summary.retryable) && (
              <div className="mt-2 flex items-center justify-end border-t border-subtle pt-2">
                {!isTerminal ? (
                  <button
                    type="button"
                    disabled={cancelling}
                    onClick={() => void handleCancel()}
                    className="text-body-xs-regular text-tertiary hover:text-danger-primary disabled:opacity-60"
                  >
                    {t("agent_teams_panel_cancel")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setRetryConfirmOpen(true)}
                    className="hover:text-accent-hover text-body-xs-medium text-accent-primary"
                  >
                    {t("agent_teams_panel_retry")}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Retry confirmation — platform modal (ModalCore), portaled with
          outside-click guards (the panel lives inside the work-item peek). */}
      {createPortal(
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events jsx-a11y/no-static-element-interactions
        <div data-prevent-outside-click onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <ModalCore isOpen={retryConfirmOpen} handleClose={() => setRetryConfirmOpen(false)} width={EModalWidth.SM}>
            <div className="flex flex-col gap-4 p-6">
              <h3 className="text-base-medium text-primary">{t("agent_teams_panel_retry")}</h3>
              <p className="text-body-sm-regular text-secondary">{t("agent_teams_panel_retry_confirm")}</p>
              {retryError && (
                <p className="rounded bg-danger-subtle px-2.5 py-1.5 text-body-xs-medium text-danger-primary">
                  {retryError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setRetryConfirmOpen(false)} disabled={retrying}>
                  {t("agent_teams_panel_cancel")}
                </Button>
                <Button variant="primary" size="sm" onClick={() => void handleRetry()} disabled={retrying}>
                  {retrying ? t("agent_teams_panel_retrying") : t("agent_teams_panel_retry")}
                </Button>
              </div>
            </div>
          </ModalCore>
        </div>,
        document.body
      )}
    </div>
  );
});
