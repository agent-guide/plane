/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * Agent Teams extension — 审批作答区（收件箱详情/工作卡执行面板共用）。
 * 三形态：自由文本补录 / 自定义选项 / 批准-驳回。
 *
 * 交互对标 HITL 确认区成熟实践（GitHub Actions 审批 / n8n 手动审批）：
 * - 通过=主按钮、驳回/终止=危险描边按钮（权重分层）
 * - 驳回/终止必填理由（防误触、可审计）；通过可不填
 * - 作答进行中走按钮 spinner（非「…」占位）
 * - 文本域最小高度 3 行、Enter 提交（仅无选项的自由文本形态）/ Shift+Enter 换行
 */
import type { ReactNode } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@/core/ui-compat/button";
import { TextArea } from "@/core/ui-compat";

export interface ApprovalAnswerPayload {
  freeText: boolean;
  options: { label: string; value: string; terminal?: boolean }[];
  /** 人工审批节点（通过/驳回）：纯按钮，文字/附件无下游消费不加输入区 */
  humanNode?: boolean;
  /** 画布自定义选项（按画布渲染，驳回=终止） */
  customOptions?: boolean;
}

export function ApprovalAnswerArea({
  approval,
  answering,
  textAnswer,
  attachmentSlot,
  attachmentIds,
  onTextChange,
  onAnswer,
}: {
  approval: ApprovalAnswerPayload;
  /** 进行中的作答键（防重复点击 + 按钮内 loading 态） */
  answering: string;
  textAnswer: string;
  /** 自由文本形态的附件上传区（agent 问「要文档」→ 面板只有文本框的能力补齐） */
  attachmentSlot?: ReactNode;
  /** 已上传附件 id（作答随行提交；>0 时空文本也可提交——纯附件作答是合法场景） */
  attachmentIds?: string[];
  onTextChange: (value: string) => void;
  onAnswer: (decision: "approved" | "rejected", reason: string, key: string, attachmentIds?: string[]) => void;
}) {
  const { t } = useTranslation();
  const options = approval.options ?? [];
  const attachmentCount = attachmentIds?.length ?? 0;

  const hasReason = textAnswer.trim().length > 0;

  // 驳回/终止必填理由；通过（非 terminal）不强制。
  const optionDisabled = (value: string, terminal?: boolean) => answering !== "" || (!!terminal && !hasReason);

  const textArea = (submitOnEnter?: () => void) => (
    <TextArea
      value={textAnswer}
      onChange={(e) => onTextChange(e.target.value)}
      onKeyDown={
        submitOnEnter
          ? (e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitOnEnter();
              }
            }
          : undefined
      }
      placeholder={t("agent_teams_inbox_answer_placeholder")}
      rows={3}
      className="min-h-[72px] w-full text-[13px]"
    />
  );

  const attachHint = approval.freeText ? (
    <p className="text-[13px] text-tertiary">{t("agent_teams_inbox_answer_attach_hint")}</p>
  ) : null;

  // 形态一：自由文本 + 选项（confirm：补录 + 通过/驳回选择并存）
  if (approval.freeText && options.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        {textArea()}
        {attachmentSlot}
        {attachHint}
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option.value}
              variant={option.terminal ? "error-outline" : "primary"}
              size="sm"
              loading={answering === option.value}
              disabled={optionDisabled(option.value, option.terminal)}
              onClick={() =>
                onAnswer(
                  option.terminal ? "rejected" : "approved",
                  textAnswer.trim(),
                  option.value,
                  attachmentIds ?? []
                )
              }
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  // 形态二：纯自由文本（补录任意内容，无选项）
  if (approval.freeText) {
    return (
      <div className="flex flex-col gap-2">
        {textArea(() => onAnswer("approved", textAnswer.trim(), "text", attachmentIds ?? []))}
        {attachmentSlot}
        {attachHint}
        <div className="flex items-center justify-end">
          <Button
            variant="primary"
            size="sm"
            loading={answering === "text"}
            disabled={answering !== "" || (!hasReason && !attachmentCount)}
            onClick={() => onAnswer("approved", textAnswer.trim(), "text", attachmentIds ?? [])}
          >
            {t("agent_teams_inbox_submit")}
          </Button>
        </div>
      </div>
    );
  }

  // 形态三：仅选项（选项式问询 / 人工审批通过-驳回），可补备注与附件
  if (options.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        <TextArea
          value={textAnswer}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={t(
            approval.humanNode ? "agent_teams_inbox_confirm_note_placeholder" : "agent_teams_inbox_answer_placeholder"
          )}
          rows={3}
      className="min-h-[72px] w-full text-[13px]"
        />
        {attachmentSlot}
        <div className="flex flex-wrap gap-2">
          {options.map((option) => {
            const isDefaultHumanAction =
              approval.humanNode &&
              !approval.customOptions &&
              (option.value === "approve" || option.value === "reject");
            const label = isDefaultHumanAction
              ? option.value === "approve"
                ? t("agent_teams_panel_approve")
                : t("agent_teams_inbox_confirm_reject")
              : option.label;
            return (
              <Button
                key={option.value}
                variant={option.terminal ? "error-outline" : "primary"}
                size="sm"
                loading={answering === option.value}
                disabled={optionDisabled(option.value, option.terminal)}
                title={
                  approval.humanNode && option.terminal && !approval.customOptions
                    ? t("agent_teams_inbox_confirm_reject_hint")
                    : undefined
                }
                onClick={() =>
                  onAnswer(
                    option.terminal ? "rejected" : "approved",
                    textAnswer.trim(),
                    option.value,
                    attachmentIds ?? []
                  )
                }
              >
                {label}
              </Button>
            );
          })}
        </div>
      </div>
    );
  }

  // 兜底：纯通过/驳回（无文案、无选项）
  return (
    <div className="flex gap-2">
      <Button
        variant="primary"
        size="sm"
        loading={answering === "approve"}
        disabled={answering !== ""}
        onClick={() => onAnswer("approved", "", "approve")}
      >
        {t("agent_teams_panel_approve")}
      </Button>
      <Button
        variant="error-outline"
        size="sm"
        loading={answering === "reject"}
        disabled={answering !== ""}
        onClick={() => onAnswer("rejected", "", "reject")}
      >
        {t("agent_teams_panel_reject")}
      </Button>
    </div>
  );
}
