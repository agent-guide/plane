/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { ReactNodeViewRenderer } from "@tiptap/react";
import { v4 as uuidv4 } from "uuid";
// constants
import { ACCEPTED_ATTACHMENT_MIME_TYPES } from "@/constants/config";
// helpers
import { isFileValid } from "@/helpers/file";
// types
import type { TFileHandler } from "@/types";
// local imports
import type { CustomAttachmentNodeViewProps } from "./components/node-view";
import { CustomAttachmentNodeView } from "./components/node-view";
import { CustomAttachmentExtensionConfig } from "./extension-config";
import type { CustomAttachmentExtensionOptions, CustomAttachmentExtensionStorage } from "./types";
import { ECustomAttachmentAttributeNames, ECustomAttachmentStatus } from "./types";

type Props = {
  fileHandler: TFileHandler;
  isEditable: boolean;
};

function getAttachmentFileMap(editor: { storage: { [key: string]: CustomAttachmentExtensionStorage } }) {
  return editor.storage.attachment?.fileMap;
}

export function CustomAttachmentExtension(extensionProps: Props) {
  const { fileHandler, isEditable } = extensionProps;
  const { getAssetDownloadSrc } = fileHandler;

  return CustomAttachmentExtensionConfig.extend<CustomAttachmentExtensionOptions, CustomAttachmentExtensionStorage>({
    selectable: isEditable,
    draggable: isEditable,

    addOptions() {
      const upload = "upload" in fileHandler ? fileHandler.upload : undefined;
      const onUploadError = "onUploadError" in fileHandler ? fileHandler.onUploadError : undefined;
      return {
        ...this.parent?.(),
        getAttachmentDownloadSource: getAssetDownloadSrc,
        uploadAttachment: upload,
        onUploadError,
      };
    },

    addStorage() {
      const maxFileSize = "validation" in fileHandler ? fileHandler.validation?.maxFileSize : 0;
      return {
        fileMap: new Map(),
        maxFileSize,
      };
    },

    addCommands() {
      return {
        insertAttachmentComponent:
          (props) =>
          ({ commands }) => {
            if (
              props?.file &&
              !isFileValid({
                acceptedMimeTypes: ACCEPTED_ATTACHMENT_MIME_TYPES,
                file: props.file,
                maxFileSize: this.storage.maxFileSize,
                onError: (error) => this.options.onUploadError?.(error),
              })
            ) {
              return false;
            }

            const fileId = uuidv4();
            const fileMap = getAttachmentFileMap(this.editor as unknown as { storage: { [key: string]: CustomAttachmentExtensionStorage } });

            if (fileMap) {
              if (props?.event === "drop" && props.file) {
                fileMap.set(fileId, { file: props.file, event: props.event });
              } else if (props.event === "insert") {
                fileMap.set(fileId, { event: props.event, hasOpenedFileInputOnce: false });
              }
            }

            const attributes = {
              [ECustomAttachmentAttributeNames.ID]: fileId,
              [ECustomAttachmentAttributeNames.STATUS]: ECustomAttachmentStatus.PENDING,
            };

            if (props.pos) {
              return commands.insertContentAt(props.pos, { type: this.name, attrs: attributes });
            }
            return commands.insertContent({ type: this.name, attrs: attributes });
          },
      };
    },

    addNodeView() {
      return ReactNodeViewRenderer((nodeViewProps) => (
        <CustomAttachmentNodeView
          {...nodeViewProps}
          node={nodeViewProps.node as CustomAttachmentNodeViewProps["node"]}
        />
      ));
    },
  });
}
