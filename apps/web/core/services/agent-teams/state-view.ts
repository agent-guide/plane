// 控制态状态视图的唯一取值实现（全平台一致）：优先显示后端按项目打标状态
// 解析出的 {stateName, stateColor}（显示跟着数据走——用户在工作台改名/换色
// 后各处自动同步）；无视图（纯本地项目/状态被删）回退内置翻译词表。
export type StateViewHost = {
  controlStatus: string;
  stateName?: string | null;
  stateColor?: string | null;
};

export function controlStateLabel(host: StateViewHost, t: (key: string) => string): string {
  return host.stateName ?? t(`agent_teams_status_${host.controlStatus}`);
}

// 返回带透明度的底色样式；无视图时 undefined（调用方保留原配色）。
export function controlStateStyle(host: StateViewHost): { backgroundColor: string; color: string } | undefined {
  const color = host.stateColor;
  return color ? { backgroundColor: `${color}1f`, color } : undefined;
}
