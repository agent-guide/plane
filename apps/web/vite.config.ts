import path from "node:path";
import * as dotenv from "dotenv";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

dotenv.config({ path: path.resolve(__dirname, ".env") });

// Expose only vars starting with VITE_
const viteEnv = Object.keys(process.env)
  .filter((k) => k.startsWith("VITE_"))
  .reduce<Record<string, string>>((a, k) => {
    a[k] = process.env[k] ?? "";
    return a;
  }, {});

export default defineConfig(() => ({
  define: {
    "process.env": JSON.stringify(viteEnv),
  },
  build: {
    assetsInlineLimit: 0,
  },
  plugins: [reactRouter(), tsconfigPaths({ projects: [path.resolve(__dirname, "tsconfig.json")] })],
  resolve: {
    alias: {
      // Next.js compatibility shims used within web
      "next/link": path.resolve(__dirname, "app/compat/next/link.tsx"),
      "next/navigation": path.resolve(__dirname, "app/compat/next/navigation.ts"),
      "next/script": path.resolve(__dirname, "app/compat/next/script.tsx"),
    },
    dedupe: ["react", "react-dom", "@headlessui/react"],
  },
  server: {
    host: "127.0.0.1",
    // 本地 dev：web(3000) 与 api(8001) 分离端口——同源相对路径请求（编排域
    // 服务、表单登录）代理到 API；生产同域部署不受影响
    proxy: {
      "/api": { target: process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8001", changeOrigin: true },
      "/auth": { target: process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8001", changeOrigin: true },
      "/spaces": { target: process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8001", changeOrigin: true },
    },
    // Vite 8 turns on browser-console forwarding automatically when it detects
    // an AI agent driving the dev server (see resolveForwardConsoleOptions in
    // vite). The client serializes each forwarded argument with a plain
    // JSON.stringify walk, so a warning that passes a DOM element or React
    // fiber expands to megabytes — a single @atlaskit auto-scroll `console.warn`
    // (dev-only, benign, it passes { element }) wrote ~9 MB. A handful of them
    // grows web.log into the gigabytes and takes the dev server with it.
    // Keep error-level (React's own dumps are bounded) and drop warn-level,
    // which is where the unbounded payloads live.
    forwardConsole: {
      logLevels: ["error"],
    },
  },
  // No SSR-specific overrides needed; alias resolves to ESM build
}));
