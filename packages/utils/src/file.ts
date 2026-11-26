/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { API_BASE_URL } from "@plane/constants";

/**
 * @description combine the file path with the base URL
 * @param {string} path
 * @returns {string} final URL with the base URL
 */
export const getFileURL = (path: string): string | undefined => {
  if (!path) return undefined;
  const isValidURL = path.startsWith("http");
  if (isValidURL) return path;
  return `${API_BASE_URL}${path}`;
};

/**
 * @description this function returns the assetId from the asset source
 * @param {string} src
 * @returns {string} assetId
 */
export const getAssetIdFromUrl = (src: string): string => {
  let url: URL;
  try {
    // read the key from a path normalised the way the browser normalises a request URL: query string
    // and hash dropped, dot segments and backslashes resolved (the base lets a relative source parse)
    url = new URL(src, "http://localhost");
  } catch {
    return "";
  }
  // paths of other schemes are not normalised that way
  if (!/^https?:$/.test(url.protocol)) return "";
  // drop a trailing slash (legacy URLs end in /<key>/) and keep the last path segment
  const assetUrl = url.pathname.replace(/\/$/, "").split("/").pop() ?? "";
  // the key is placed in an API path, so it must not carry an encoded path separator
  if (/%2f|%5c/i.test(assetUrl)) return "";
  return assetUrl;
};

export type FileUploadErrorCode = "no-file" | "invalid-type" | "too-large";

export type FileUploadValidationResult = { ok: true } | { ok: false; error: FileUploadErrorCode };

/**
 * @description 附件上传的统一前端校验（类型 + 大小），返回机器可读的结果码，
 * 由各入口自行映射到统一的 i18n 提示。单一事实来源，编辑器与 app 层共用。
 * 注意：file.type 为空时不拦类型（交给后端签名检测 + 扩展名回退），
 * 避免误杀浏览器拿不到 MIME 的纯文本/Office 文档。
 */
export const validateFileUpload = (
  file: File | null | undefined,
  { acceptedMimeTypes, maxFileSize }: { acceptedMimeTypes: string[]; maxFileSize: number }
): FileUploadValidationResult => {
  if (!file) return { ok: false, error: "no-file" };
  const typeMatches = !file.type || acceptedMimeTypes.length === 0 || acceptedMimeTypes.includes(file.type);
  if (!typeMatches) return { ok: false, error: "invalid-type" };
  if (maxFileSize > 0 && file.size > maxFileSize) return { ok: false, error: "too-large" };
  return { ok: true };
};

/**
 * @description encode image via URL to base64
 * @param {string} url
 * @returns
 */
export const getBase64Image = async (url: string): Promise<string> => {
  if (!url || typeof url !== "string") {
    throw new Error("Invalid URL provided");
  }

  // Try to create a URL object to validate the URL
  try {
    new URL(url);
  } catch {
    throw new Error("Invalid URL format");
  }

  const response = await fetch(url);
  // check if the response is OK
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.statusText}`);
  }

  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onloadend = () => {
      if (reader.result) {
        resolve(reader.result as string);
      } else {
        reject(new Error("Failed to convert image to base64."));
      }
    };

    reader.onerror = () => {
      reject(new Error("Failed to read the image file."));
    };

    reader.readAsDataURL(blob);
  });
};

/**
 * @description downloads a CSV file
 * @param {Array<Array<string>> | { [key: string]: string }} data - The data to be exported to CSV
 * @param {string} name - The name of the file to be downloaded
 */
export const csvDownload = (data: Array<Array<string>> | { [key: string]: string }, name: string) => {
  const rows = Array.isArray(data) ? [...data] : [Object.keys(data), Object.values(data)];

  const csvContent = "data:text/csv;charset=utf-8," + rows.map((e) => e.join(",")).join("\n");
  const encodedUri = encodeURI(csvContent);

  const link = document.createElement("a");
  link.href = encodedUri;
  link.download = `${name}.csv`;

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
