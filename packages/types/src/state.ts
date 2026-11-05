/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export type TStateGroups = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

export interface IState {
  readonly id: string;
  /** Agent Teams extension：执行状态落点标签（waiting_human 等）——编排域
   * 按此寻址打标；带标签态禁删（UI 提示与后端 409 守卫）。 */
  external_id?: string | null;
  color: string;
  default: boolean;
  description: string;
  group: TStateGroups;
  name: string;
  project_id: string;
  sequence: number;
  workspace_id: string;
  order: number;
}

export interface IStateLite {
  color: string;
  group: TStateGroups;
  id: string;
  name: string;
}

export interface IStateResponse {
  [key: string]: IState[];
}

export type TStateOperationsCallbacks = {
  createState: (data: Partial<IState>) => Promise<IState>;
  updateState: (stateId: string, data: Partial<IState>) => Promise<IState | undefined>;
  deleteState: (stateId: string) => Promise<void>;
  moveStatePosition: (stateId: string, data: Partial<IState>) => Promise<void>;
  markStateAsDefault: (stateId: string) => Promise<void>;
};
