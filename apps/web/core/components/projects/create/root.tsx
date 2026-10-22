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
  const { addProjectToFavorites, createProject, updateProject, deleteProject } = useProject();
  // states
  const [shouldAutoSyncIdentifier, setShouldAutoSyncIdentifier] = useState(true);
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
  //
  // 投影等待：后端把 Plane 项目登记为内部项目+external 映射要靠 Plane 的
  // project.created webhook 异步投影完成（实测 2–4s）。刚创建就绑定会拿到
  // 404 PROJECT_NOT_FOUND，于是"创建成功"后立刻报失败、回滚把项目删掉。
  // 这里按最终一致性退避重试（与 AWS SDK 的资源传播等待同款），只对
  // PROJECT_NOT_FOUND 重试；版本未发布/引擎未钉等 fail-closed 错误立即失败。
  const PROJECTION_RETRY_DELAYS_MS = [500, 1000, 1500, 2000, 2500, 3000];

  const bindOrThrow = async (projectId: string, exec: NonNullable<ExecutionSelection>) => {
    for (let attempt = 0; ; attempt++) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        await workflowService.createBindingForExternalProject(projectId, {
          teamId: exec.teamId,
          defaultWorkflowVersionId: exec.workflowVersionId,
        });
        return;
      } catch (error) {
        const response = (error as { response?: { status?: number; data?: { code?: string } } })?.response;
        if (response?.status === 409 && response?.data?.code === "PROJECT_TEAM_BINDING_CONFLICT") {
          return; // 幂等重放：项目已绑定为成功终态
        }
        const notProjectedYet = response?.status === 404 && response?.data?.code === "PROJECT_NOT_FOUND";
        if (notProjectedYet && attempt < PROJECTION_RETRY_DELAYS_MS.length) {
          // oxlint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, PROJECTION_RETRY_DELAYS_MS[attempt]));
          continue;
        }
        throw error;
      }
    }
  };

  const rollbackProject = async (slug: string, projectId: string): Promise<boolean> => {
    // 退避重试是刻意的串行循环（1s/2s），非可并行集合。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // 走 store 的删除：createProject 已把项目写进 projectMap，直连
        // service 删除会让侧栏/项目列表残留一条已回滚的"幽灵项目"。
        // oxlint-disable-next-line no-await-in-loop
        await deleteProject(slug, projectId);
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
        // 建项目 + 绑定是一个整体，"创建成功"只在两步都完成后提示一次
        // （此前建完项目就先弹成功，绑定失败时用户会看到成功紧跟着失败）。
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("success"),
          message: t("project_created_successfully"),
        });
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
