/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — 审批作答区（收件箱详情/工作卡执行面板共用）。
 * 三形态：自由文本补录 / 自定义选项 / 批准-驳回。按钮排布对齐平台弹层
 * 惯例（横排、auto 宽、右对齐提交），杜绝纵向容器把按钮拉成整行细条。
 */
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
  onTextChange,
  onAnswer,
}: {
  approval: ApprovalAnswerPayload;
  /** 进行中的作答键（防重复点击 + 按钮内 loading 态） */
  answering: string;
  textAnswer: string;
  onTextChange: (value: string) => void;
  onAnswer: (decision: "approved" | "rejected", reason: string, key: string) => void;
}) {
  const { t } = useTranslation();
  const options = approval.options ?? [];

  if (approval.freeText) {
    return (
      <div className="flex flex-col gap-2">
        <TextArea
          value={textAnswer}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={t("agent_teams_inbox_answer_placeholder")}
          className="w-full"
        />
        <div className="flex items-center justify-end">
          <Button
            variant="primary"
            size="sm"
            disabled={answering !== "" || !textAnswer.trim()}
            onClick={() => onAnswer("approved", textAnswer.trim(), "text")}
          >
            {answering === "text" ? "…" : t("agent_teams_inbox_submit")}
          </Button>
        </div>
      </div>
    );
  }

  if (options.length > 0) {
    return (
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option.value}
            variant={option.terminal ? "secondary" : "primary"}
            size="sm"
            disabled={answering !== ""}
            onClick={() => onAnswer(option.terminal ? "rejected" : "approved", option.label, option.value)}
          >
            {answering === option.value ? "…" : option.label}
          </Button>
        ))}
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
