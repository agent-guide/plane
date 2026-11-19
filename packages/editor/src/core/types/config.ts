/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import type { FileUploadErrorCode } from "@plane/utils";
import type { TExtendedFileHandler } from "@/plane-editor/types/config";

export type TFileHandler = {
  assetsUploadStatus: Record<string, number>; // blockId => progress percentage
  cancel: () => void;
  checkIfAssetExists: (assetId: string) => Promise<boolean>;
  delete: (assetSrc: string) => Promise<void>;
  getAssetDownloadSrc: (path: string) => Promise<string>;
  getAssetSrc: (path: string) => Promise<string>;
  restore: (assetSrc: string) => Promise<void>;
  upload: (blockId: string, file: File) => Promise<string>;
  duplicate: (assetId: string) => Promise<string>;
  validation: {
    /**
     * @description max file size in bytes
     * @example enter 5242880(5 * 1024 * 1024) for 5MB
     */
    maxFileSize: number;
  };
  /**
   * @description 校验失败（no-file / invalid-type / too-large）时由 app 层统一提示，
   * 编辑器内部不再弹 alert。
   */
  onUploadError?: (error: FileUploadErrorCode) => void;
  /**
   * @description 资产引用被移除（节点删除并完成 delete 之后）回调 app 层，
   * 用于同步清理其上传登记（如评论的 uploadedAssetIds，防"隐形附件"）。
   */
  onAssetRemoved?: (assetId: string) => void;
} & TExtendedFileHandler;

export type TEditorFontStyle = "sans-serif" | "serif" | "monospace";

export type TEditorFontSize = "small-font" | "large-font" | "mobile-font";

export type TEditorLineSpacing = "regular" | "small" | "mobile-regular";

export type TDisplayConfig = {
  fontStyle?: TEditorFontStyle;
  fontSize?: TEditorFontSize;
  lineSpacing?: TEditorLineSpacing;
  wideLayout?: boolean;
};

export type TUserDetails = {
  color: string;
  id: string;
  name: string;
  cookie?: string;
};

export type TRealtimeConfig = {
  url: string;
};

export type IMarking = {
  type: "heading";
  level: number;
  text: string;
  sequence: number;
};
