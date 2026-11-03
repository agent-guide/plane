/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
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
// Agent Teams extension：建项目即绑定（2026-11-03 复活，两步绑定形态——只绑团队，
// 流程进项目后再配置；绑定权限沿 v1 定案放宽为工作区成员可选任意 active 团队）。
import { getProjectFormValues } from "./utils";
import { FormSelect } from "@/components/agent-teams/form-select";
import { orchestrationService, type OrchestrationTeam } from "@/services/agent-teams/orchestration.service";

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
  // 执行团队（必选）：active 团队目录；加载失败按空目录处理（表单报错不放行）
  const [teams, setTeams] = useState<OrchestrationTeam[]>([]);
  const [teamId, setTeamId] = useState("");
  const [teamError, setTeamError] = useState("");
  const [submittingBind, setSubmittingBind] = useState(false);
  useEffect(() => {
    let ignore = false;
    orchestrationService
      .listTeams(workspaceSlug.toString())
      .then((items: OrchestrationTeam[]) => {
        if (!ignore) setTeams(items.filter((tm) => tm.status === "active"));
        return null;
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, [workspaceSlug]);
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

  const onSubmit = async (formData: Partial<TProject>) => {
    // 建项目即绑定（2026-11-03 复活，两步绑定第一步）：团队必选——项目是交给
    // 团队执行的容器（未绑定不能建卡），出生即绑定；流程进项目后再配置。
    // 绑定失败回滚删除项目（绑定是快速本地调用，简单 fail-closed 即可，
    // 不需要 v1 时代的 Saga 重试机）。
    if (!teamId) {
      setTeamError(t("agent_teams_create_project_team_required"));
      return;
    }
    setTeamError("");
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
        // 绑定执行团队（失败回滚删项目，不放行残缺项目）
        setSubmittingBind(true);
        try {
          await orchestrationService.bindProject(workspaceSlug.toString(), res.id, { teamId });
        } catch {
          await deleteProject(workspaceSlug.toString(), res.id).catch(() => undefined);
          setSubmittingBind(false);
          setToast({
            type: TOAST_TYPE.ERROR,
            title: t("toast.error"),
            message: t("agent_teams_create_project_bind_failed"),
          });
          return;
        }
        setSubmittingBind(false);
        if (setToFavorite) {
          handleAddToFavorites(res.id);
        }
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
          <ProjectAttributes isMobile={isMobile} />
          {/* 执行团队（必选，建项目即绑定 §两步绑定第一步） */}
          <div className="space-y-1.5">
            <span className="text-sm text-default font-medium">
              {t("agent_teams_create_project_team_label")}
              <span className="text-red-500">*</span>
            </span>
            {teams.length > 0 ? (
              <FormSelect
                value={teamId}
                placeholder={t("agent_teams_bind_team_pick")}
                options={teams.map((tm) => ({ id: tm.id, name: tm.name }))}
                onChange={(v) => {
                  setTeamId(v);
                  if (v) setTeamError("");
                }}
              />
            ) : (
              <p className="text-sm text-red-500">{t("agent_teams_create_project_no_teams")}</p>
            )}
            {teamError ? <p className="text-xs text-red-500">{teamError}</p> : null}
          </div>
        </div>
        <ProjectCreateButtons handleClose={handleClose} disabled={submittingBind} />
      </form>
    </FormProvider>
  );
});
