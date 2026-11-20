# 本地全栈（scripts/local/）

> 纪律与 `deploy-v2.sh` 同源：fail-closed（探活校验**响应体**，不认裸 200）、
> 幂等可重放、版本钉死禁 latest、口令可读令牌随机落 `.env`（gitignored）。

## 快速开始（新机从零）

```bash
bash scripts/local/bootstrap.sh    # ① 依赖引导（brew/go/pnpm/bun/uv + 双 venv + 构建 + 网关二进制）
bash scripts/local/gen-env.sh      # ② 生成全部环境文件与凭据（先补 env.example 里 LLM_API_KEY）
bash scripts/local/up.sh           # ③ 按依赖序拉起全栈并逐步探活
bash scripts/local/provision.sh    # ④ 平台链开通（网关/租户/模型/员工/部署，幂等）
bash scripts/local/smoke.sh        # ⑤ e2e 冒烟：建卡→执行→人工确认→completed
```

日常：`up.sh` / `down.sh [--keep-infra]` / `check.sh`（巡检，可挂 CI）。

## 端口口径（与 runbook 一致，勿另起炉灶）

| 服务            | 端口                                 | 说明                                                           |
| --------------- | ------------------------------------ | -------------------------------------------------------------- |
| Plane web / api | :3000 / **:8001**                    | api 端口口径来自 bootstrap-supplements.sh 的 PLANE_BASE 默认   |
| agwmngr         | **:3300**                            | `next dev -p 3300`（避开 web 3000）                            |
| gateway         | 数据 :8080 / 管理 **localhost**:8019 | Caddyfile.local 双绑 localhost+127.0.0.1（防 Host 失配空 200） |
| Airflow         | :8090                                | 须 `AIRFLOW__API__BASE_URL` 指回自身（默认 8080 撞 gateway）   |

## 内置防护（每条都是 2026-11-16 实证坑）

- 探活一律校验响应体——gateway Caddy 站点按 Host 匹配，错 Host 返回**空 200 假活**
- Airflow `AIRFLOW__API__BASE_URL` 强制指向 :8090
- Airflow 三件套须**非沙箱**启动（沙箱内 LocalExecutor 任务子进程被 SIGKILL）
- dag-processor 每次启动带 `AIRFLOW__CORE__DAGS_FOLDER=/tmp/agent-team-dags`
- worker 单实例断言（check.sh；双 worker 互抢 outbox）
- worker 入口为 `procrastinate_worker.py`（2026-11-16 起 Procrastinate PG 队列替代自研轮询）
- up.sh 依赖序：Airflow 先签 `ORCHESTRATION_AIRFLOW_TOKEN` 回 `.env` 再起 api/worker（顺序反了会静默走无引擎过渡、DAG 不落地）
- dag-processor 刷新间隔 15s（默认 300s 会让发布收口超 90s 窗口）
- 改 gateway LLM 路由 target 后须**重启 agw** 才对 builtin agent 生效（provision 输出提示）
- 建卡 API 用 `description_html`（传 description doc JSON 会被静默忽略）

## 契约守护

`apps/api/plane/orchestration/tests/test_agwmngr_contract.py` 冻结了 worker 依赖的
agwmngr 字段子集；真机对拍模式：

```bash
AGWMNGR_CONTRACT_BASE_URL=http://127.0.0.1:3300 \
AGWMNGR_CONTRACT_TOKEN=$TENANT_TOKEN \
.venv/bin/python -m pytest plane/orchestration/tests/test_agwmngr_contract.py -v
```

## 文件

| 文件                | 职责                                                           |
| ------------------- | -------------------------------------------------------------- |
| `env.example`       | 环境唯一权威模板（端口/口令/上游模型）                         |
| `.env`              | gen-env 生成（gitignored）——凭据唯一落点                       |
| `lib/common.sh`     | 探活/输出/进程管理公共库                                       |
| `bootstrap.sh`      | 一次性依赖引导                                                 |
| `gen-env.sh`        | 生成三处 env 文件（plane api / agwmngr / gateway Caddyfile）   |
| `up.sh` / `down.sh` | 拉起/停止（支持 `--skip-airflow` `--skip-web` `--keep-infra`） |
| `check.sh`          | 巡检（含跨服务契约抽检），非 0 退出                            |
| `provision.sh`      | 平台链一键开通（幂等），末尾回填 plane env                     |
| `smoke.sh`          | e2e 冒烟（轮询终态，失败打印各环节实际响应）                   |
