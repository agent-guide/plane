/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { FileText, Loader2, X } from "lucide-react";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
// plane imports
import { cn } from "@plane/utils";
// constants
import { ACCEPTED_ATTACHMENT_MIME_TYPES } from "@/constants/config";
// helpers
import type { FileUploadErrorCode } from "@/helpers/file";
// hooks
import { useUploader, useDropZone, uploadFirstFileAndInsertRemaining } from "@/hooks/use-file-upload";
// local imports
import type { UploadEntity } from "../types";
import { ECustomAttachmentAttributeNames, ECustomAttachmentStatus } from "../types";

export type CustomAttachmentNodeViewProps = {
  node: {
    attrs: Record<string, unknown>;
  };
};

type Props = {
  editor: any;
  extension: any;
  getPos: NodeViewProps["getPos"];
  node: any;
  selected: boolean;
  updateAttributes: (attrs: Record<string, unknown>) => void;
};

function getAttachmentFileMap(editor: any) {
  return editor.storage.attachment?.fileMap as Map<string, UploadEntity> | undefined;
}

export function CustomAttachmentNodeView(props: Props) {
  const { editor, extension, getPos, node, selected, updateAttributes } = props;
  // refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasTriggeredFilePickerRef = useRef(false);
  const hasTriedUploadingOnMountRef = useRef(false);
  // state for download url
  const [downloadUrl, setDownloadUrl] = useState<string>("");

  const attachmentId = node.attrs[ECustomAttachmentAttributeNames.ID] as string | null;
  const fileName = node.attrs[ECustomAttachmentAttributeNames.NAME] as string | null;
  const assetUrl = node.attrs[ECustomAttachmentAttributeNames.URL] as string | null;
  const status = node.attrs[ECustomAttachmentAttributeNames.STATUS] as ECustomAttachmentStatus;

  const fileMap = useMemo(() => getAttachmentFileMap(editor), [editor]);

  const onUpload = useCallback(
    (url: string, file: File) => {
      updateAttributes({
        [ECustomAttachmentAttributeNames.URL]: url,
        [ECustomAttachmentAttributeNames.NAME]: file.name,
        [ECustomAttachmentAttributeNames.STATUS]: ECustomAttachmentStatus.UPLOADED,
      });
      fileMap?.delete(attachmentId ?? "");
    },
    [attachmentId, fileMap, updateAttributes]
  );

  const uploadAttachmentEditorCommand = useCallback(
    async (file: File) => {
      updateAttributes({ [ECustomAttachmentAttributeNames.STATUS]: ECustomAttachmentStatus.UPLOADING });
      return await extension.options.uploadAttachment?.(attachmentId ?? "", file);
    },
    [extension.options, attachmentId, updateAttributes]
  );

  const handleInvalidFile = useCallback(
    (error: FileUploadErrorCode) => {
      extension.options.onUploadError?.(error);
    },
    [extension.options.onUploadError]
  );

  const handleProgressStatus = useCallback(
    (isUploading: boolean) => {
      editor.storage.utility.uploadInProgress = isUploading;
    },
    [editor]
  );

  const maxFileSize = (editor.storage.attachment as { maxFileSize?: number } | undefined)?.maxFileSize ?? 0;

  // 上传失败时自删占位节点（否则失败后残留一个"选择文件"的空白附件块）
  const removeNode = useCallback(() => {
    const pos = getPos();
    if (pos === undefined) return;
    editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
  }, [editor, getPos, node.nodeSize]);

  const { isUploading, uploadFile } = useUploader({
    acceptedMimeTypes: ACCEPTED_ATTACHMENT_MIME_TYPES,
    editorCommand: uploadAttachmentEditorCommand,
    handleProgressStatus,
    maxFileSize,
    onInvalidFile: handleInvalidFile,
    onUpload,
    onError: removeNode,
  });

  const { draggedInside, onDrop, onDragEnter, onDragLeave } = useDropZone({
    editor,
    getPos,
    type: "attachment",
    uploader: uploadFile,
  });

  // open file picker on insert, or upload on drop
  useEffect(() => {
    if (hasTriedUploadingOnMountRef.current) return;
    const meta = fileMap?.get(attachmentId ?? "");
    if (meta) {
      if (meta.event === "drop" && "file" in meta) {
        hasTriedUploadingOnMountRef.current = true;
        uploadFile(meta.file);
      } else if (meta.event === "insert" && fileInputRef.current && !hasTriggeredFilePickerRef.current) {
        if (meta.hasOpenedFileInputOnce) return;
        fileInputRef.current.click();
        hasTriggeredFilePickerRef.current = true;
        fileMap?.set(attachmentId ?? "", { ...meta, hasOpenedFileInputOnce: true });
      }
    } else {
      hasTriedUploadingOnMountRef.current = true;
    }
  }, [attachmentId, fileMap, uploadFile]);

  // resolve download url once uploaded
  useEffect(() => {
    if (status === ECustomAttachmentStatus.UPLOADED && assetUrl) {
      extension.options
        .getAttachmentDownloadSource(assetUrl)
        .then(setDownloadUrl)
        .catch(() => setDownloadUrl(""));
    }
  }, [status, assetUrl, extension.options]);

  const onFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      e.preventDefault();
      const filesList = e.target.files;
      const pos = getPos();
      if (!filesList || pos === undefined) return;
      await uploadFirstFileAndInsertRemaining({
        editor,
        filesList,
        pos,
        type: "attachment",
        uploader: uploadFile,
      });
    },
    [uploadFile, editor, getPos]
  );

  const isUploaded = status === ECustomAttachmentStatus.UPLOADED;

  const chip = (
    <div className="flex items-center gap-1.5">
      <FileText className="size-3.5 shrink-0 text-tertiary" />
      {isUploading ? (
        <span className="text-xs truncate text-tertiary">Uploading…</span>
      ) : (
        <span className="text-xs truncate text-secondary">{fileName ?? "Select a file"}</span>
      )}
    </div>
  );

  return (
    <NodeViewWrapper key={node.attrs[ECustomAttachmentAttributeNames.ID]}>
    {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 编辑器节点外壳须为 contentEditable=false 的 div 块容器，语义 button 会引入嵌套交互问题 */}
    <div
      role="button"
      /* 编辑器节点外壳需 contentEditable=false 的块容器，语义 button 标签
         在 ProseMirror 节点视图内会引入嵌套交互问题——按规则建议保留 div +
         role，键盘可达性由 tabIndex/onKeyDown 补齐。 */
      tabIndex={editor.isEditable && !isUploaded ? 0 : -1}
      aria-label={fileName ? `Attachment ${fileName}` : "Select an attachment"}
      className={cn(
        "attachment-upload-component my-1 flex cursor-default items-center justify-start gap-1.5 rounded-md border border-subtle bg-layer-2 px-2.5 py-1.5 text-tertiary transition-all duration-200 ease-in-out",
        {
          "border-subtle hover:bg-layer-3-hover": editor.isEditable && !isUploaded,
          "cursor-pointer hover:bg-layer-3-hover hover:text-secondary": editor.isEditable && !isUploaded,
          "bg-layer-3-hover text-secondary": draggedInside && editor.isEditable,
          "bg-accent-primary/10 text-accent-secondary": selected && editor.isEditable,
          "border-subtle bg-transparent text-primary": isUploaded,
        }
      )}
      onDrop={onDrop}
      onDragOver={onDragEnter}
      onDragLeave={onDragLeave}
      contentEditable={false}
      onClick={() => {
        if (!isUploaded && editor.isEditable) fileInputRef.current?.click();
      }}
      onKeyDown={(e) => {
        if (!isUploaded && editor.isEditable && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          fileInputRef.current?.click();
        }
      }}
    >
      {isUploading ? <Loader2 className="size-4 shrink-0 animate-spin" /> : chip}
      {isUploaded && downloadUrl && (
        <a
          href={downloadUrl}
          download={fileName ?? undefined}
          className="text-xs ml-auto shrink-0 text-accent-secondary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          Download
        </a>
      )}
      {editor.isEditable && !isUploading && (
        <button
          type="button"
          aria-label="Remove attachment"
          title="Remove attachment"
          className="ml-auto shrink-0 rounded p-0.5 text-tertiary hover:bg-layer-3-hover hover:text-danger-primary"
          onClick={(e) => {
            e.stopPropagation();
            removeNode();
          }}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
      <input
        className="size-0 overflow-hidden"
        ref={fileInputRef}
        hidden
        type="file"
        accept={ACCEPTED_ATTACHMENT_MIME_TYPES.join(",")}
        onChange={onFileChange}
        multiple
      />
    </div>
    </NodeViewWrapper>
  );
}
