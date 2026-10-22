/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — team list. 全员自建（设计 2026-10-19）：成员可在
 * 配额内创建团队（draft 起步，配成员后上架），管理与协作同处工作台。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
import { useRouter } from "next/navigation";
// plane imports
import { Button } from "@plane/propel/button";
import { EmptyStateDetailed, type ActionButton } from "@plane/propel/empty-state";
import { useTranslation } from "@plane/i18n";
import {
  Breadcrumbs,
  ContentWrapper,
  EModalPosition,
  EModalWidth,
  Header,
  Input,
  ModalCore,
  TextArea,
} from "@plane/ui";
// icons
import { Bot, ChevronRight, ListTodo, Search, User, Users } from "lucide-react";
// components
import { AppHeader } from "@/components/core/app-header";
import { PageHead } from "@/components/core/page-title";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
// services
import { TeamStatusIcon } from "@/components/agent-teams/team-status";
import runtimeService, { type AgentTeam } from "@/services/agent-teams/runtime.service";
import { classifyRuntimeFailure, type RuntimeFailureKind } from "@/services/agent-teams/runtime-errors";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";

/**
 * 整页空态：与项目列表（core/components/project/card-list.tsx）同参调用 Plane 详细空态——
 * 插图 size-40（160px）、标题/说明字号、按钮都由组件统一决定，页面不额外调样式。
 * 按钮走 actions 而不是塞自定义节点：自定义节点是 flex 列的直接子项会被拉满整行，
 * 而 actions 有 row 容器包裹、按内容宽度排。
 */
const fullPageEmpty = (
  assetKey: "teamspace" | "server-error" | "search" | "invalid-link",
  title: string,
  options: { description?: string; actions?: ActionButton[] } = {}
) => (
  <div className="flex min-h-0 w-full flex-1">
    <EmptyStateDetailed
      assetKey={assetKey}
      assetClassName="size-40"
      title={title}
      description={options.description}
      actions={options.actions}
    />
  </div>
);

function WorkspaceAgentTeamsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { currentWorkspace } = useWorkspace();
  const { agentTeamDetailPath } = useAgentTeamsLinks();
  // derived values
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - Agent Teams` : undefined;

  const [teams, setTeams] = useState<AgentTeam[]>([]);
  const [loading, setLoading] = useState(true);
  // 失败原因分类：工作区没接入时重试永远不会成功，不能再给「重试」按钮。
  const [failure, setFailure] = useState<RuntimeFailureKind | null>(null);
  // 全员自建（设计 2026-10-19 §4）：新建模态 + 搜索。
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", objective: "" });
  const [formErrorKey, setFormErrorKey] = useState("");
  const [formErrorDetail, setFormErrorDetail] = useState("");
  const [creating, setCreating] = useState(false);
  const [keyword, setKeyword] = useState("");
  // 配额提示（设计 §1.2 钩子②）：打开新建弹层即展示剩余名额，不等 409。
  const [quota, setQuota] = useState<{
    applies: boolean;
    quota: number;
    owned: number;
    remaining: number | null;
  } | null>(null);

  const loadTeams = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      setTeams(await runtimeService.listTeams());
    } catch (error) {
      setFailure(classifyRuntimeFailure(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return teams;
    return teams.filter(
      (team) => team.name.toLowerCase().includes(kw) || (team.objective ?? "").toLowerCase().includes(kw)
    );
  }, [teams, keyword]);

  // 骨架屏（设计 2026-10-20 整改）：与项目加载形态一致，替换纯文字加载中。
  /* 莫奈清晨·方向 4（2026-10-21 定稿）：跨色相渐变 + 终点雾化——
   * 起色为晨光色、止色为相邻色相混白 10%，渐变角 160°（横向流动）——
   * 色彩为主体、雾只收右端窄条，宽卡不发白（印象派色彩并置机理）。
   * 明度 75-80%，白字靠底部渐隐支撑。 */
  const TEAM_ACCENTS: Array<[string, string, string]> = [
    ["#a3c6de", "#b7d2e6", "#3a668c"], // 睡莲蓝→雾青；墨=深水蓝
    ["#aed8d8", "#bfe4dc", "#3a7a70"], // 晨雾青→雾绿；墨=深水绿
    ["#b7abe0", "#cac8ec", "#5a4a94"], // 睡莲紫→雾蓝；墨=深藤紫
    ["#eec3a4", "#f1d4c6", "#96603a"], // 日出橙→雾粉；墨=深橙褐
    ["#e6cf9c", "#ecdfc4", "#8a7333"], // 晨光金→雾杏；墨=深金褐
    ["#aebfd6", "#c4d0e8", "#47598a"], // 塞纳蓝→雾紫；墨=深塞纳
    ["#e2b1b6", "#ecd2d4", "#964a55"], // 晨玫瑰→雾粉；墨=深玫瑰
    ["#e4bcc9", "#ead8e6", "#8d5a78"], // 睡莲粉→雾紫；墨=深莲粉
    ["#b1cf9f", "#c6e0cf", "#4a7a3a"], // 草露绿→雾青；墨=深叶绿
    ["#a4d1c5", "#bcdeeb", "#3a6e82"], // 水光青→雾蓝；墨=深水青
    ["#e8c6a2", "#eeded0", "#8a6a42"], // 晨杏→雾金；墨=深杏褐
    ["#bcb6d2", "#ced2e8", "#5a5480"], // 晨雾紫→雾蓝；墨=深雾紫
  ];
  const teamHash = (name: string) => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return hash % TEAM_ACCENTS.length;
  };
  const teamAccent = (name: string) => TEAM_ACCENTS[teamHash(name)][0];
  const teamAccentDark = (name: string) => TEAM_ACCENTS[teamHash(name)][1];
  const teamInk = (name: string) => TEAM_ACCENTS[teamHash(name)][2];

  const skeletons = (
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-2" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3.5 rounded-lg border border-subtle bg-layer-1 px-4 py-3.5">
          <div className="size-8 animate-pulse rounded-full bg-layer-3" />
          <div className="flex flex-grow flex-col gap-1.5">
            <div className="h-3.5 w-1/3 animate-pulse rounded bg-layer-3" />
            <div className="h-2.5 w-2/3 animate-pulse rounded bg-layer-2" />
          </div>
        </div>
      ))}
    </div>
  );

  const submitCreate = async () => {
    const name = form.name.trim();
    if (!name) {
      setFormErrorKey("agent_teams_create_name_required");
      setFormErrorDetail("");
      return;
    }
    setCreating(true);
    setFormErrorKey("");
    setFormErrorDetail("");
    try {
      const created = await runtimeService.createTeam({
        name,
        objective: form.objective.trim() || undefined,
      });
      setCreateOpen(false);
      setForm({ name: "", objective: "" });
      // 成功动线：直进详情（先配成员再上架，§4 空态引导承接）。
      router.push(agentTeamDetailPath(created.id));
    } catch (error) {
      const status = (
        error as { response?: { status?: number; data?: { code?: string; details?: { quota?: number } } } }
      )?.response;
      if (status?.data?.code === "AGENT_TEAM_QUOTA_EXCEEDED") {
        setFormErrorKey("agent_teams_quota_exceeded");
        setFormErrorDetail(String(status.data.details?.quota ?? ""));
      } else if (status?.status === 409) {
        setFormErrorKey("agent_teams_create_name_conflict");
        setFormErrorDetail("");
      } else {
        setFormErrorKey("agent_teams_create_failed");
        setFormErrorDetail("");
      }
    } finally {
      setCreating(false);
    }
  };

  /**
   * 失败态：区分「重试有用」和「重试没用」。工作区没接入团队运行服务时，
   * 点多少次重试都不会成功——只给说明和指引；服务暂时不可用时才给重试。
   */
  const failureState = (kind: RuntimeFailureKind) => {
    if (kind === "not_connected") {
      return fullPageEmpty("invalid-link", t("agent_teams_runtime_not_connected_title"), {
        description: t("agent_teams_runtime_not_connected_hint"),
      });
    }
    const retry: ActionButton = {
      label: t("agent_teams_project_retry"),
      variant: "secondary",
      onClick: () => void loadTeams(),
    };
    return kind === "unavailable"
      ? fullPageEmpty("server-error", t("agent_teams_runtime_unavailable_title"), {
          description: t("agent_teams_runtime_unavailable_hint"),
          actions: [retry],
        })
      : fullPageEmpty("server-error", t("agent_teams_load_failed"), { actions: [retry] });
  };

  /** 新建入口（头部与空态共用）：打开即取配额提示，不等 409。 */
  const openCreate = () => {
    setFormErrorKey("");
    setFormErrorDetail("");
    runtimeService
      .getTeamQuota()
      .then((info) => setQuota(info))
      .catch(() => setQuota(null));
    setCreateOpen(true);
  };

  return (
    <>
      <PageHead title={pageTitle} />
      <div className="flex h-full w-full flex-col overflow-hidden">
        <AppHeader
          header={
            <Header>
              <Header.LeftItem>
                <Breadcrumbs>
                  <Breadcrumbs.Item
                    component={
                      <BreadcrumbLink
                        label={t("agent_teams_breadcrumb")}
                        disableTooltip
                        icon={<Users className="size-4 text-tertiary" />}
                      />
                    }
                  />
                </Breadcrumbs>
              </Header.LeftItem>
              <Header.RightItem>
                {/* 收件箱头部入口已移除（2026-10-22 精简）：主入口是顶栏通知
                    铃铛的「等待审批」标签（§12.6.4，带未决计数），此处为重复
                    入口且无徽标。 */}
                {/* 全员自建（设计 2026-10-19）：入口常驻列表页头部。 */}
                <Button variant="primary" size="lg" onClick={openCreate}>
                  {t("agent_teams_create_team")}
                </Button>
              </Header.RightItem>
            </Header>
          }
        />
        <ContentWrapper>
          {/* 自加 padding 移除（边距归 ContentWrapper）；标题删（与侧边栏重复），
              副说明保留 */}
          <div className="flex min-h-0 w-full flex-1 flex-col gap-5 pb-10">
            <p className="m-0 max-w-2xl text-body-xs-regular text-tertiary">{t("agent_teams_page_subtitle")}</p>

            {loading ? (
              skeletons
            ) : failure ? (
              failureState(failure)
            ) : teams.length === 0 ? (
              // 整页空态：详细空态 + 首建引导（此前自绘的图标卡片是三套里最不像 Plane 的一套）。
              fullPageEmpty("teamspace", t("agent_teams_empty_title"), {
                description: t("agent_teams_empty_hint"),
                actions: [{ label: t("agent_teams_create_team"), variant: "primary", onClick: openCreate }],
              })
            ) : (
              <>
                <div className="relative max-w-sm">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary"
                    aria-hidden
                  />
                  <input
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder={t("agent_teams_search_placeholder")}
                    className="focus:border-accent-primary/50 h-8 w-full rounded-md border border-subtle bg-layer-2 pr-3 pl-8 text-body-sm-regular text-primary outline-none placeholder:text-placeholder"
                  />
                </div>
                {filtered.length === 0 ? (
                  fullPageEmpty("search", t("agent_teams_search_empty"))
                ) : (
                  <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">
                    {filtered.map((team) => (
                      <button
                        key={team.id}
                        type="button"
                        onClick={() => router.push(agentTeamDetailPath(team.id))}
                        className="group flex w-full flex-col justify-between overflow-hidden rounded-lg border border-subtle bg-layer-2 text-left transition-all duration-300 hover:border-strong hover:shadow-raised-200"
                      >
                        {/* 头部区：与项目封面同构的视觉锚点。文字排版对齐
                            ProjectCard 的封面文字规格：底部深色渐隐保证可读性、
                            标题 15px semibold + 字距收紧、状态用半透明胶囊
                            （比裸白字更有"组件感"——参考 Figma/Linear 封面角标）。 */}
                        <div
                          className="relative flex h-[104px] w-full items-end px-4 pb-3.5"
                          style={{
                            /* 160° 横向流动：雾白止色只收在右端窄条，
                                主面积保持色彩浓度（宽卡不发白） */
                            background: `linear-gradient(160deg, ${teamAccent(team.name)}, ${teamAccentDark(team.name)})`,
                          }}
                        >
                          {/* 同色墨罩（莫奈适配）：黑罩压高明度色会发浊（黑+亮蓝=灰脏），
                              罩层改用本组"墨色"（起色加深 ~35%）——文字区是"更深的
                              水色"而非"蒙黑纱"，色系通透感保留，白字对比达标。 */}
                          <div
                            className="absolute inset-x-0 bottom-0 h-14"
                            style={{
                              background: `linear-gradient(to top, ${teamInk(team.name)}73, transparent)`,
                            }}
                            aria-hidden
                          />
                          <div className="relative flex w-full items-center gap-2.5">
                            {/* 标识块：底色与项目卡一字不差（bg-white/10），仅优化
                                文字呈现——大写字重 medium + 微字距 + 轻投影，靠
                                排版而非改底色做精致。 */}
                            {/* 标识块：加强磨玻璃（blur 提档 + 白底 12%），字母
                                降透明度到 85% 并去投影——字母退为"隐现于玻璃下"，
                                不再与右侧标题竞争第一视线。 */}
                            <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-sm bg-white/12 backdrop-blur-[6px]">
                              {/* 墨色高亮版：莫奈色底偏亮，白 65% 显细——改用本组墨色
                                  实色（与罩层同源），字重保持 800，白字描边般的
                                  清晰度且不漂浮。 */}
                              <span
                                className="font-extrabold text-[13px] leading-none tracking-[0.03em]"
                                style={{ color: teamInk(team.name) }}
                              >
                                {team.name.slice(0, 1).toUpperCase()}
                              </span>
                            </div>
                            {/* 标题+状态相对标识块两端对齐（justify-between）：
                                标题贴块顶、状态贴块底，与 36px 标识等高成组，
                                整体像一组对齐过的"铭牌"而非两行松散文字。 */}
                            <div className="flex w-full min-w-0 flex-col justify-between self-stretch py-px">
                              {/* 标题 16px（--text-16 token）：与项目卡标题字号统一 */}
                              <h3 className="w-full truncate text-[16px] leading-none font-semibold tracking-tight text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.2)]">
                                {team.name}
                              </h3>
                              {/* 状态：语义图标与详情页/侧栏共用 TeamStatusIcon
                                  （活跃=脉搏/草稿=拟稿/归档=归档盒），渐变卡上
                                  用白色系保持可读。 */}
                              <span className="flex items-center gap-1.5">
                                <TeamStatusIcon
                                  status={team.status}
                                  className="size-3"
                                  color={team.status === "active" ? "text-white" : "text-white/70"}
                                />
                                <span
                                  className={`text-[10px] leading-none font-medium tracking-[0.08em] uppercase ${
                                    team.status === "active" ? "text-white/90" : "text-white/55"
                                  }`}
                                >
                                  {t(`agent_teams_status_${team.status}`)}
                                </span>
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* 内容区：与项目卡同构（104px 高、p-4、两行描述、底部信号行） */}
                        <div className="flex h-[104px] w-full flex-col justify-between p-4">
                          <p className="line-clamp-2 text-13 break-words text-tertiary">
                            {team.objective && team.objective.trim() !== ""
                              ? team.objective
                              : t("agent_teams_card_no_objective")}
                          </p>
                          <div className="flex items-center justify-between">
                            {/* 信号行数字：tabular-nums 等宽数字（Inter 特性），
                                数字变化时宽度稳定不抖动 */}
                            {/* 数字真等宽（三稿改内联字体栈）：font-mono token 在
                                本项目无定义、tnum 子集缺失——直接内联系统等宽栈，
                                浏览器必有其一，等宽物理保证 */}
                            <div className="flex items-center gap-3 text-caption-sm-medium text-secondary">
                              {team.memberCount !== undefined && team.memberCount > 0 && (
                                <span className="inline-flex items-center gap-1">
                                  <User className="size-3 text-tertiary" aria-hidden />
                                  <span>{team.memberCount}</span>
                                </span>
                              )}
                              {team.activeTaskCount !== undefined && team.activeTaskCount > 0 && (
                                <span className="inline-flex items-center gap-1 text-accent-primary">
                                  <ListTodo className="size-3" aria-hidden />
                                  <span>{team.activeTaskCount}</span>
                                </span>
                              )}
                              {team.runningRunCount !== undefined && team.runningRunCount > 0 && (
                                <span className="inline-flex items-center gap-1">
                                  <Bot className="size-3 text-tertiary" aria-hidden />
                                  <span>{team.runningRunCount}</span>
                                </span>
                              )}
                            </div>
                            <ChevronRight
                              className="size-4 text-placeholder transition-colors group-hover:text-accent-primary"
                              aria-hidden
                            />
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </ContentWrapper>
      </div>

      {/* 新建团队模态（设计 §4：两字段 + 一句话说明 + 成功直进详情）。 */}
      <ModalCore
        isOpen={createOpen}
        handleClose={() => setCreateOpen(false)}
        position={EModalPosition.TOP}
        width={EModalWidth.SM}
      >
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-1">
            <h3 className="text-body-lg-medium m-0 text-primary">{t("agent_teams_create_team")}</h3>
            <p className="m-0 text-body-xs-regular text-tertiary">{t("agent_teams_create_team_hint")}</p>
          </div>
          {quota?.applies ? (
            <p className="m-0 text-caption-sm-regular text-tertiary">
              {t("agent_teams_quota_status", {
                remaining: quota.remaining ?? 0,
                quota: quota.quota,
              })}
            </p>
          ) : null}
          {formErrorKey ? (
            <p className="border-danger-primary/30 m-0 rounded-md border bg-danger-primary/5 px-3 py-2 text-body-xs-regular text-danger-primary">
              {formErrorDetail
                ? `${t(formErrorKey)}${formErrorDetail ? `（${formErrorDetail}）` : ""}`
                : t(formErrorKey)}
            </p>
          ) : null}
          <label className="flex flex-col gap-1.5">
            <span className="text-caption-sm-medium text-secondary">{t("agent_teams_create_name_label")}</span>
            <Input
              mode="primary"
              inputSize="sm"
              className="w-full"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder={t("agent_teams_create_name_label")}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption-sm-medium text-secondary">{t("agent_teams_create_objective_label")}</span>
            <TextArea
              mode="primary"
              textAreaSize="sm"
              className="min-h-20 w-full resize-y"
              value={form.objective}
              onChange={(event) => setForm((prev) => ({ ...prev, objective: event.target.value }))}
              placeholder={t("agent_teams_create_objective_label")}
            />
          </label>
          <div className="flex items-center justify-end gap-2 border-t border-subtle pt-4">
            <Button variant="secondary" size="lg" onClick={() => setCreateOpen(false)}>
              {t("cancel")}
            </Button>
            <Button variant="primary" size="lg" loading={creating} onClick={() => void submitCreate()}>
              {t("agent_teams_create_submit")}
            </Button>
          </div>
        </div>
      </ModalCore>
    </>
  );
}

export default observer(WorkspaceAgentTeamsPage);
