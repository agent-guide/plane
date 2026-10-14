/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { FormProvider, useForm } from "react-hook-form";
// plane imports
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EFileAssetType } from "@plane/types";
// components
import ProjectCommonAttributes from "@/components/project/create/common-attributes";
import ProjectCreateHeader from "@/components/project/create/header";
import ProjectCreateButtons from "@/components/project/create/project-create-buttons";
// hooks
import { getCoverImageType, uploadCoverImage } from "@/helpers/cover-image.helper";
import { ProjectService } from "@/services/project/project.service";
import { useProject } from "@/hooks/store/use-project";
import { usePlatformOS } from "@/hooks/use-platform-os";
// plane web types
import type { TProject } from "@plane/types";
import { ProjectAttributes } from "./attributes";
// Agent Teams extension：建项目即绑定（阶段 4）。
import type { ExecutionSelection } from "@/components/agent-teams/project-execution-fields";
import workflowService from "@/services/agent-teams/workflow.service";
import { getProjectFormValues } from "./utils";

export type TCreateProjectFormProps = {
  setToFavorite?: boolean;
  workspaceSlug: string;
  onClose: () => void;
  handleNextStep: (projectId: string) => void;
  data?: Partial<TProject>;
  templateId?: string;
  updateCoverImageStatus: (projectId: string, coverImage: string) => Promise<void>;
};

export const CreateProjectForm = observer(function CreateProjectForm(props: TCreateProjectFormProps) {
  const { setToFavorite, workspaceSlug, data, onClose, handleNextStep, updateCoverImageStatus } = props;
  // store
  const { t } = useTranslation();
  const { addProjectToFavorites, createProject, updateProject } = useProject();
  // states
  const [shouldAutoSyncIdentifier, setShouldAutoSyncIdentifier] = useState(true);
  // 补偿删除走 service 直连：补偿场景无需 store 增量同步（失败路径表单不关）。
  const projectService = new ProjectService();
  const [execution, setExecution] = useState<ExecutionSelection>(null);
  // form info
  const methods = useForm<TProject>({
    defaultValues: { ...getProjectFormValues(), ...data },
    reValidateMode: "onChange",
  });
  const { handleSubmit, reset, setValue } = methods;
  const { isMobile } = usePlatformOS();
  const handleAddToFavorites = (projectId: string) => {
    if (!workspaceSlug) return;

    addProjectToFavorites(workspaceSlug.toString(), projectId).catch(() => {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("toast.error"),
        message: t("failed_to_remove_project_from_favorites"),
      });
    });
  };

  // Saga 补偿辅助（建项目即绑定）：仅 PROJECT_TEAM_BINDING_CONFLICT（项目已
  // 绑定）视为成功终态（幂等重放）；后端其余 409（版本未发布/引擎未钉/团队
  // 停用等 fail-closed 校验）必须走回滚报错，不能吞成"成功"。
  // 删除回滚幂等且带退避重试 x2（瞬时故障兜底，AWS/Stripe SDK 同款默认）。
  const bindOrThrow = async (projectId: string, exec: NonNullable<ExecutionSelection>) => {
    try {
      await workflowService.createBindingForExternalProject(projectId, {
        teamId: exec.teamId,
        defaultWorkflowVersionId: exec.workflowVersionId,
      });
    } catch (error) {
      const response = (error as { response?: { status?: number; data?: { code?: string } } })?.response;
      if (response?.status === 409 && response?.data?.code === "PROJECT_TEAM_BINDING_CONFLICT") {
        return; // 幂等重放：项目已绑定为成功终态
      }
      throw error;
    }
  };

  const rollbackProject = async (slug: string, projectId: string): Promise<boolean> => {
    // 退避重试是刻意的串行循环（1s/2s），非可并行集合。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        await projectService.deleteProject(slug, projectId);
        return true;
      } catch {
        if (attempt < 2) {
          // oxlint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    return false;
  };

  const onSubmit = async (formData: Partial<TProject>) => {
    // 执行团队与流程必选（设计定案：每个项目必有绑定）
    if (!execution?.teamId || !execution.workflowVersionId) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("toast.error"),
        message: t("agent_teams_exec_required"),
      });
      return;
    }
    // Upper case identifier
    formData.identifier = formData.identifier?.toUpperCase();
    const coverImage = formData.cover_image_url;
    let uploadedAssetUrl: string | null = null;

    if (coverImage) {
      const imageType = getCoverImageType(coverImage);

      if (imageType === "local_static") {
        try {
          uploadedAssetUrl = await uploadCoverImage(coverImage, {
            workspaceSlug: workspaceSlug.toString(),
            entityIdentifier: "",
            entityType: EFileAssetType.PROJECT_COVER,
            isUserAsset: false,
          });
        } catch (error) {
          console.error("Error uploading cover image:", error);
          setToast({
            type: TOAST_TYPE.ERROR,
            title: t("toast.error"),
            message: error instanceof Error ? error.message : "Failed to upload cover image",
          });
          return Promise.reject(error);
        }
      } else {
        formData.cover_image = coverImage;
        formData.cover_image_asset = null;
      }
    }

    return createProject(workspaceSlug.toString(), formData)
      .then(async (res) => {
        if (uploadedAssetUrl) {
          await updateCoverImageStatus(res.id, uploadedAssetUrl);
          await updateProject(workspaceSlug.toString(), res.id, { cover_image_url: uploadedAssetUrl });
        } else if (coverImage && coverImage.startsWith("http")) {
          await updateCoverImageStatus(res.id, coverImage);
          await updateProject(workspaceSlug.toString(), res.id, { cover_image_url: coverImage });
        }
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("success"),
          message: t("project_created_successfully"),
        });

        if (setToFavorite) {
          handleAddToFavorites(res.id);
        }
        // 建项目即绑定（阶段 4，Saga 补偿）：绑定成功才算创建成功——失败时
        // 删除刚建的项目回滚（幂等，退避重试 x2），表单停留并报错可重试；
        // 补偿彻底失败则保留项目并显式提示（绝不静默）。
        try {
          await bindOrThrow(res.id, execution);
        } catch (bindError) {
          const compensated = await rollbackProject(workspaceSlug.toString(), res.id);
          // 后端 fail-closed 详情（如"版本未钉引擎，请重新发布"）拼进提示，可定位。
          const detail = (bindError as { response?: { data?: { message?: string } } })?.response?.data?.message;
          setToast({
            type: TOAST_TYPE.ERROR,
            title: t("toast.error"),
            message:
              (compensated ? t("agent_teams_exec_bind_failed_rolled_back") : t("agent_teams_exec_bind_failed_kept")) +
              (detail ? `：${detail}` : ""),
          });
          if (!compensated) console.error("binding failed and rollback failed:", bindError);
          return;
        }
        return handleNextStep(res.id);
      })
      .catch((err) => {
        try {
          // Handle the new error format where codes are nested in arrays under field names
          const errorData = err?.data ?? {};

          const nameError = errorData.name?.includes("PROJECT_NAME_ALREADY_EXIST");
          const identifierError = errorData?.identifier?.includes("PROJECT_IDENTIFIER_ALREADY_EXIST");
          const nameSpecialCharError = errorData?.name?.includes("PROJECT_NAME_CANNOT_CONTAIN_SPECIAL_CHARACTERS");

          if (nameError || identifierError || nameSpecialCharError) {
            if (nameError) {
              setToast({
                type: TOAST_TYPE.ERROR,
                title: t("toast.error"),
                message: t("project_name_already_taken"),
              });
            }

            if (identifierError) {
              setToast({
                type: TOAST_TYPE.ERROR,
                title: t("toast.error"),
                message: t("project_identifier_already_taken"),
              });
            }

            if (nameSpecialCharError) {
              setToast({
                type: TOAST_TYPE.ERROR,
                title: t("toast.error"),
                message: t("project_name_cannot_contain_special_characters"),
              });
            }
          } else {
            setToast({
              type: TOAST_TYPE.ERROR,
              title: t("toast.error"),
              message: t("something_went_wrong"),
            });
          }
        } catch (error) {
          // Fallback error handling if the error processing fails
          console.error("Error processing API error:", error);
          setToast({
            type: TOAST_TYPE.ERROR,
            title: t("toast.error"),
            message: t("something_went_wrong"),
          });
        }
      });
  };

  const handleClose = () => {
    onClose();
    setShouldAutoSyncIdentifier(true);
    setTimeout(() => {
      reset();
    }, 300);
  };

  return (
    <FormProvider {...methods}>
      <ProjectCreateHeader handleClose={handleClose} isMobile={isMobile} />

      <form onSubmit={handleSubmit(onSubmit)} className="px-3">
        <div className="mt-9 space-y-6 pb-5">
          <ProjectCommonAttributes
            setValue={setValue}
            isMobile={isMobile}
            shouldAutoSyncIdentifier={shouldAutoSyncIdentifier}
            setShouldAutoSyncIdentifier={setShouldAutoSyncIdentifier}
          />
          <ProjectAttributes isMobile={isMobile} execution={execution} onExecutionChange={setExecution} />
        </div>
        <ProjectCreateButtons handleClose={handleClose} />
      </form>
    </FormProvider>
  );
});
