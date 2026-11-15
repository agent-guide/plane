/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — 审批作答区（收件箱详情/工作卡执行面板共用）。
 * 三形态：自由文本补录 / 自定义选项 / 批准-驳回。按钮排布对齐平台弹层
 * 惯例（横排、auto 宽、右对齐提交），杜绝纵向容器把按钮拉成整行细条。
 */
import type { ReactNode } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { TextArea } from "@plane/ui";
import { cn } from "@plane/utils";

export interface ApprovalAnswerPayload {
  freeText: boolean;
  options: { label: string; value: string; terminal?: boolean }[];
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

  // confirm：通过/驳回按钮 + 原因/修正值框（freeText 与 options 并存）
  if (approval.freeText && options.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        <TextArea
          value={textAnswer}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={t("agent_teams_inbox_answer_placeholder")}
          className="w-full"
        />
        {attachmentSlot}
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option.value}
              variant={option.terminal ? "secondary" : "primary"}
              size="sm"
              disabled={answering !== ""}
              onClick={() =>
                onAnswer(
                  option.terminal ? "rejected" : "approved",
                  textAnswer.trim(),
                  option.value,
                  attachmentIds ?? []
                )
              }
            >
              {answering === option.value ? "…" : option.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  if (approval.freeText) {
    return (
      <div className="flex flex-col gap-2">
        <TextArea
          value={textAnswer}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={t("agent_teams_inbox_answer_placeholder")}
          className="w-full"
        />
        {attachmentSlot}
        <div className="flex items-center justify-end">
          <Button
            variant="primary"
            size="sm"
            disabled={answering !== "" || (!textAnswer.trim() && !attachmentCount)}
            onClick={() => onAnswer("approved", textAnswer.trim(), "text", attachmentIds ?? [])}
          >
            {answering === "text" ? "…" : t("agent_teams_inbox_submit")}
          </Button>
        </div>
      </div>
    );
  }

  if (options.length > 0) {
    // C6：选项式提问同样可补文字/附件（组合自由——只点选项、只传附件、
    // 或选项+补充说明均可；提交把文字与附件随选项一并带上）
    return (
      <div className="flex flex-col gap-2">
        <TextArea
          value={textAnswer}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={t("agent_teams_inbox_answer_placeholder")}
          className="w-full"
        />
        {attachmentSlot}
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option.value}
              variant={option.terminal ? "secondary" : "primary"}
              size="sm"
              disabled={answering !== ""}
              onClick={() =>
                onAnswer(
                  option.terminal ? "rejected" : "approved",
                  textAnswer.trim(),
                  option.value,
                  attachmentIds ?? []
                )
              }
            >
              {answering === option.value ? "…" : option.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <Button
        variant="primary"
        size="sm"
        disabled={answering !== ""}
        onClick={() => onAnswer("approved", "", "approve")}
        className={cn(answering === "approve" && "opacity-60")}
      >
        {t("agent_teams_panel_approve")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={answering !== ""}
        onClick={() => onAnswer("rejected", "", "reject")}
      >
        {t("agent_teams_panel_reject")}
      </Button>
    </div>
  );
}
