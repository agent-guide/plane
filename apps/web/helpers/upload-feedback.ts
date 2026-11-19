/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { FileUploadErrorCode } from "@plane/utils";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * @description 附件上传校验失败的统一提示文案，单一来源。
 * 与 @plane/utils 的 validateFileUpload 配套使用，各入口共用，保证提示一致。
 */
export const getUploadErrorMessage = (t: TranslateFn, error: FileUploadErrorCode, maxFileSize: number): string => {
  if (error === "invalid-type") return t("attachment.invalid_type");
  if (error === "too-large") return t("attachment.file_size_limit", { size: maxFileSize / 1024 / 1024 });
  return t("attachment.error");
};

/**
 * @description 附件上传校验失败的统一 toast。
 */
export const showUploadErrorToast = (t: TranslateFn, error: FileUploadErrorCode, maxFileSize: number): void => {
  setToast({
    title: t("common.error.label"),
    type: TOAST_TYPE.ERROR,
    message: getUploadErrorMessage(t, error, maxFileSize),
  });
};

/**
 * @description 附件上传 HTTP 失败的统一 toast。
 */
export const showUploadFailedToast = (t: TranslateFn): void => {
  setToast({
    title: t("common.error.label"),
    type: TOAST_TYPE.ERROR,
    message: t("attachment.error"),
  });
};
