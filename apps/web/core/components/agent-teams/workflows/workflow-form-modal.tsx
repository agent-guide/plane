/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 流程建/改弹层（从 team-workflows-section 拆出）。
 * 逐字对齐 Plane 周期创建表单（cycles/form.tsx）：p-5/space-y-5 外层、
 * text-18 标题、竖排 space-y-3 字段、Input md + text-14、错误 text-11 红字、
 * border-t-[0.5px] 页脚 + propel Button secondary/primary size lg。
 */
import { useTranslation } from "@plane/i18n";
import { Button as PropelButton } from "@plane/propel/button";
import { EModalPosition, EModalWidth, Input, ModalCore, TextArea } from "@plane/ui";
import { FormSelect } from "@/components/agent-teams/form-select";
import type { EngineConnectionOption, PublishedExpert, TeamWorkflow } from "@/services/agent-teams/workflow.service";

export type WorkflowForm = {
  name: string;
  description: string;
  ownerExpertId: string;
  engineConnectionId: string;
  singleAgentPrompt: string;
};

export const EMPTY_WORKFLOW_FORM: WorkflowForm = {
  name: "",
  description: "",
  ownerExpertId: "",
  engineConnectionId: "",
  singleAgentPrompt: "",
};

type Props = {
  isOpen: boolean;
  editing: TeamWorkflow | null;
  form: WorkflowForm;
  formError: string;
  submitting: boolean;
  experts: PublishedExpert[];
  engines: EngineConnectionOption[];
  onClose: () => void;
  onChange: (patch: Partial<WorkflowForm>) => void;
  onSubmit: () => void;
};

export function WorkflowFormModal({
  isOpen,
  editing,
  form,
  formError,
  submitting,
  experts,
  engines,
  onClose,
  onChange,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  return (
    <ModalCore isOpen={isOpen} handleClose={onClose} position={EModalPosition.TOP} width={EModalWidth.XXL}>
      <div className="space-y-5 p-5">
        <h3 className="text-18 font-medium text-secondary">
          {editing ? t("agent_teams_wf_modal_edit_title") : t("agent_teams_wf_modal_create_title")}
        </h3>
        <div className="space-y-3">
          <div className="space-y-1">
            <Input
              name="name"
              type="text"
              inputSize="sm"
              className="w-full"
              placeholder={`${t("agent_teams_wf_field_name")} *`}
              value={form.name}
              onChange={(e) => onChange({ name: e.target.value })}
              hasError={Boolean(formError)}
            />
            {formError ? <span className="text-11 text-danger-primary">{formError}</span> : null}
          </div>
          <div className="space-y-1">
            <FormSelect
              value={form.ownerExpertId}
              placeholder={`${t("agent_teams_wf_field_owner")} *`}
              options={experts.map((e) => ({ id: e.id, name: e.name }))}
              onChange={(v) => onChange({ ownerExpertId: v })}
            />
          </div>
          <div className="space-y-1">
            <TextArea
              name="description"
              mode="primary"
              textAreaSize="sm"
              className="font-normal min-h-16 w-full resize-none text-13"
              placeholder={t("agent_teams_wf_field_desc")}
              value={form.description}
              onChange={(e) => onChange({ description: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <FormSelect
              value={form.engineConnectionId}
              placeholder={t("agent_teams_wf_engine_auto")}
              options={engines.map((e) => ({ id: e.id, name: e.name }))}
              onChange={(v) => onChange({ engineConnectionId: v })}
            />
            <span className="text-11 text-tertiary">{t("agent_teams_wf_engine_auto")}</span>
          </div>
          {!editing ? (
            <div className="space-y-1">
              <TextArea
                name="singleAgentPrompt"
                mode="primary"
                textAreaSize="sm"
                className="font-normal min-h-24 w-full resize-none text-13"
                placeholder={t("agent_teams_wf_field_prompt")}
                value={form.singleAgentPrompt}
                onChange={(e) => onChange({ singleAgentPrompt: e.target.value })}
              />
              <span className="text-11 text-tertiary">{t("agent_teams_wf_prompt_hint")}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-subtle px-5 py-4">
        <PropelButton variant="secondary" size="lg" onClick={onClose}>
          {t("cancel")}
        </PropelButton>
        <PropelButton variant="primary" size="lg" onClick={onSubmit} loading={submitting}>
          {submitting ? t("agent_teams_wf_saving") : t("save")}
        </PropelButton>
      </div>
    </ModalCore>
  );
}
