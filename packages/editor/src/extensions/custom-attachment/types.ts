/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Node } from "@tiptap/core";
// types
import type { FileUploadErrorCode } from "@plane/utils";
import type { TFileHandler } from "@/types";

export enum ECustomAttachmentAttributeNames {
  ID = "id",
  NAME = "name",
  URL = "url",
  STATUS = "status",
}

export enum ECustomAttachmentStatus {
  PENDING = "pending",
  UPLOADING = "uploading",
  UPLOADED = "uploaded",
}

export type TCustomAttachmentAttributes = {
  [ECustomAttachmentAttributeNames.ID]: string | null;
  [ECustomAttachmentAttributeNames.NAME]: string | null;
  [ECustomAttachmentAttributeNames.URL]: string | null;
  [ECustomAttachmentAttributeNames.STATUS]: ECustomAttachmentStatus;
};

export type UploadEntity = ({ event: "insert" } | { event: "drop"; file: File }) & { hasOpenedFileInputOnce?: boolean };

export type InsertAttachmentComponentProps = {
  file?: File;
  pos?: number;
  event: "insert" | "drop";
};

export type CustomAttachmentExtensionOptions = {
  getAttachmentDownloadSource: TFileHandler["getAssetDownloadSrc"];
  uploadAttachment?: TFileHandler["upload"];
  onUploadError?: (error: FileUploadErrorCode) => void;
};

export type CustomAttachmentExtensionStorage = {
  fileMap: Map<string, UploadEntity>;
  maxFileSize: number;
};

export type CustomAttachmentExtensionType = Node<CustomAttachmentExtensionOptions, CustomAttachmentExtensionStorage>;
