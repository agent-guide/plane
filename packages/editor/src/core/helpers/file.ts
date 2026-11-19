/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { validateFileUpload, type FileUploadErrorCode } from "@plane/utils";

export type { FileUploadErrorCode };

type TArgs = {
  acceptedMimeTypes: string[];
  file: File;
  maxFileSize: number;
  onError: (error: FileUploadErrorCode) => void;
};

/**
 * @description 统一委托到 @plane/utils 的 validateFileUpload（单一事实来源），
 * 仅返回布尔 + 结果码，不再拼硬编码英文文案——提示由 app 层 onUploadError 统一 toast。
 */
export const isFileValid = (args: TArgs): boolean => {
  const { acceptedMimeTypes, file, maxFileSize, onError } = args;
  const result = validateFileUpload(file, { acceptedMimeTypes, maxFileSize });
  if (result.ok) return true;
  onError(result.error);
  return false;
};
