/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Controller, useFormContext } from "react-hook-form";
// plane imports
import { NETWORK_CHOICES, ETabIndices } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { IProject } from "@plane/types";
import { CustomSelect } from "@plane/ui";
import type { ExecutionSelection } from "@/components/agent-teams/project-execution-fields";
import { getTabIndex } from "@plane/utils";
import { ProjectNetworkIcon } from "@/components/project/project-network-icon";
import { ProjectExecutionFields } from "@/components/agent-teams/project-execution-fields";

type Props = {
  isMobile?: boolean;
  execution?: ExecutionSelection;
  onExecutionChange?: (value: ExecutionSelection) => void;
};

function ProjectAttributes(props: Props) {
  const { isMobile = false, execution, onExecutionChange } = props;
  const { t } = useTranslation();
  const { control } = useFormContext<IProject>();
  const { getIndex } = getTabIndex(ETabIndices.PROJECT_CREATE, isMobile);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Controller
        name="network"
        control={control}
        render={({ field: { onChange, value } }) => {
          const currentNetwork = NETWORK_CHOICES.find((n) => n.key === value);

          return (
            <div className="h-7 flex-shrink-0" tabIndex={getIndex("network")}>
              <CustomSelect
                value={value}
                onChange={onChange}
                label={
                  <div className="flex h-full items-center gap-1">
                    {currentNetwork ? (
                      <>
                        <ProjectNetworkIcon iconKey={currentNetwork.iconKey} />
                        {t(currentNetwork.i18n_label)}
                      </>
                    ) : (
                      <span className="text-placeholder">{t("select_network")}</span>
                    )}
                  </div>
                }
                placement="bottom-start"
                className="h-full"
                buttonClassName="h-full"
                noChevron
                tabIndex={getIndex("network")}
              >
                {NETWORK_CHOICES.map((network) => (
                  <CustomSelect.Option key={network.key} value={network.key}>
                    <div className="flex items-start gap-2">
                      <ProjectNetworkIcon iconKey={network.iconKey} className="h-3.5 w-3.5" />
                      <div className="-mt-1">
                        <p>{t(network.i18n_label)}</p>
                        <p className="text-11 text-placeholder">{t(network.description)}</p>
                      </div>
                    </div>
                  </CustomSelect.Option>
                ))}
              </CustomSelect>
            </div>
          );
        }}
      />
      {/* Agent Teams extension（2026-10-12 定案）：隐藏 Plane 原生负责人字段——
          执行语义下卡片负责人由流程环节自动流转，项目级负责人无消费方。 */}
      {execution !== undefined && onExecutionChange ? (
        <ProjectExecutionFields value={execution} onChange={onExecutionChange} />
      ) : null}
    </div>
  );
}

export default ProjectAttributes;

export { ProjectAttributes };
