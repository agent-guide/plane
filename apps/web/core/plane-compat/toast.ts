/** 旧 @plane/propel/toast 的兼容出口：TOAST_TYPE 枚举映射到 blocks 的字符串联合。 */
export { setToast, setPromiseToast, dismissToast, updateToast } from "@plane/blocks/toast";

export const TOAST_TYPE = {
  ALERT: "warning",
  WARNING: "warning",
  ERROR: "error",
  SUCCESS: "success",
  INFO: "info",
} as const;
