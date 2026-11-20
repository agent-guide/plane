/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * 可上传类型的唯一事实来源（与后端 asset/v2.py 的 ACCEPTED_ATTACHMENT_MIME_TYPES
 * 对齐：图片 + Office 文档 + PDF + 纯文本）。前端各处 picker/校验一律引用这里，
 * 不再各自维护白名单。
 */
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];

export const ATTACHMENT_MIME_TYPES = [
  ...IMAGE_MIME_TYPES,
  // PDF
  "application/pdf",
  // Word
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  // Excel
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  // PPT
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // RTF（浏览器可能报 text/rtf 或 application/rtf，两者都收）
  "application/rtf",
  "text/rtf",
  // OpenDocument
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  // 纯文本
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
  "text/html",
  "text/yaml",
];

/** react-dropzone 的 accept 对象形态（avatar/cover 等图片选择器使用）。 */
export const ACCEPTED_IMAGE_MIME_TYPES_FOR_REACT_DROPZONE = Object.fromEntries(
  IMAGE_MIME_TYPES.map((mime) => [mime, []])
);

export const ACCEPTED_AVATAR_IMAGE_MIME_TYPES_FOR_REACT_DROPZONE = ACCEPTED_IMAGE_MIME_TYPES_FOR_REACT_DROPZONE;
export const ACCEPTED_COVER_IMAGE_MIME_TYPES_FOR_REACT_DROPZONE = ACCEPTED_IMAGE_MIME_TYPES_FOR_REACT_DROPZONE;

/**
 * Dangerous file extensions that should be blocked
 */
export const DANGEROUS_EXTENSIONS = [
  "exe",
  "bat",
  "cmd",
  "sh",
  "php",
  "asp",
  "aspx",
  "jsp",
  "cgi",
  "dll",
  "vbs",
  "jar",
  "ps1",
];
