// Workflow canvas editor (docs/workflow-graph-editor-plan.md §4-§5), extracted from
// the admin page so it stays route-agnostic: the upcoming execution-visualization
// view (P3) reuses the same canvas in read-only form. Nodes/edges are edited on
// XYFlow and handed back via onSave as ONE graph document (whole-document
// replace, never partial patches). Validation mirrors the backend: node name +
// per-type required fields, no dangling edges, no cycles. position is view-only.
//
// Node types (§5): agent (autonomous LLM work), tool (deterministic MCP call,
// connection-resolved credentials), human_confirm (pauses the run for a person).

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "@plane/i18n";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  useEdges,
  useEdgesState,
  useNodes,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
// 样式副作用导入（xyflow 画布基础样式）——lint 放行先例：CSS 副作用导入无需赋值。
// oxlint-disable-next-line import/no-unassigned-import
import "@xyflow/react/dist/style.css";
import type { WorkflowGraph, WorkflowGraphNode } from "@/services/agent-teams/workflow.service";
import { FormSelect } from "./form-select";
import { Button } from "@plane/propel/button";
import { Checkbox, CustomMenu, Input, TextArea } from "@plane/ui";
import { MousePointerClick, Plus } from "lucide-react";
// 面板小节标签/提示样式（其余控件均为 @plane/ui 组件）。
const FIELD_LABEL_CLASS = "block text-12 font-normal text-secondary";
const FIELD_HINT_CLASS = "block text-11 font-normal leading-relaxed text-tertiary";

export const NODE_TYPES = ["agent", "tool", "human_confirm", "condition"] as const;
export type GraphNodeType = (typeof NODE_TYPES)[number];

// Options are label-first (industry pattern): the user writes display text and at
// most toggles "terminates the flow" — the semantic value is derived (label by
// default), never hand-edited. terminate maps to the reject path on resume.
type NodeOption = { label: string; value?: string; terminate?: boolean };

type NodeData = {
  name: string;
  prompt?: string;
  expertId?: string; // 整改一: bound employee — the node executes as that expert
  tool_name?: string;
  connection?: string;
  params?: string; // edited as JSON text, serialized on save
  message?: string;
  approverUserId?: string; // human_confirm: the Tenant user who answers the confirmation
  freeText?: boolean; // human_confirm: free-text answer instead of approve/reject
  options?: NodeOption[]; // human_confirm: design-time choices (approve/reject default)
  branches?: { label: string; target: string }[]; // condition: derived from out-edges
  [key: string]: unknown;
};
export type FlowNode = Node<NodeData, GraphNodeType>;

const NODE_WIDTH = 220;
const NODE_NEW_OFFSET = 180;

const NODE_TYPE_LABEL_KEYS: Record<string, string> = {
  agent: "agent_teams_node_type_agent",
  tool: "agent_teams_node_type_tool",
  human_confirm: "agent_teams_node_type_human_confirm",
  condition: "agent_teams_node_type_condition",
};

const nodeTypeLabel = (t: ReturnType<typeof useTranslation>["t"], type: string) =>
  t(NODE_TYPE_LABEL_KEYS[type] ?? "agent_teams_node_type_unknown");

function nodeSummary(data: NodeData, boundMemberLabel: string): string {
  if (data.expertId) return data.prompt || boundMemberLabel;
  if (data.tool_name) return data.tool_name;
  if (Array.isArray(data.branches) && data.branches.length > 0) {
    return data.branches.map((b) => b.label || b.target).join(" / ");
  }
  if (data.message) return data.message;
  return data.prompt || "";
}

function normalizeOptions(raw: unknown): NodeOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
    .map((o) => ({
      label: String(o.label ?? o.value ?? ""),
      value: String(o.value ?? o.label ?? ""),
      terminate: o.value === "reject" || o.terminate === true || o.terminal === true,
    }))
    .filter((o) => o.label);
}

// Editing view of the options list: empty rows kept (a just-added option has an
// empty label — normalizing them away made the add button look dead).
function editableOptions(raw: unknown): NodeOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
    .map((o) => ({
      label: String(o.label ?? ""),
      value: o.value ? String(o.value) : undefined,
      terminate: o.value === "reject" || o.terminate === true || o.terminal === true,
    }));
}

// Live branch summary derived from the CURRENT canvas edges (not the saved
// payload) — the card shows branches the moment they are drawn (n8n/Dify
// pattern), empty labels fall back to localized branch placeholders.
function ConditionBranchLine({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation();
  // Live edges/nodes via XYFlow hooks — branches appear as they are drawn,
  // before any save; empty labels show generated branch names.
  const edges = useEdges();
  const nodes = useNodes() as FlowNode[];
  const summary = branchSummary(nodeId, edges, nodes, t("agent_teams_canvas_branch_placeholder"));
  return <p className="text-amber-600 mt-1 truncate text-11 leading-relaxed">{summary || t("agent_teams_canvas_pull_branch_hint")}</p>;
}

function branchSummary(nodeId: string, edges: Edge[], nodes: FlowNode[], placeholder: string): string {
  const out = edges.filter((e) => e.source === nodeId);
  if (out.length === 0) return "";
  return out
    .map((e, i) => {
      const label = ((e as Edge & { label?: string }).label || "").trim();
      const target = nodes.find((n) => n.id === e.target);
      return `${label || placeholder.replace("{index}", String(i + 1))}→${target?.data.name || "?"}`;
    })
    .join("  ");
}

// Type-coded accent (n8n/Dify pattern): one quiet color dot per node class so
// a populated canvas reads by shape of color before any label. Canvas-local
// coding — agent ink, tool neutral, confirm amber (needs a human), condition
// green (routes onward).
const TYPE_ACCENTS: Record<string, string> = {
  agent: "#6366f1",
  tool: "#64748b",
  human_confirm: "#f59e0b",
  condition: "#22c55e",
};

export function GraphNodeCard({ data, selected, type, id }: NodeProps<FlowNode>) {
  const { t } = useTranslation();
  const accent = TYPE_ACCENTS[type] ?? "#64748b";
  const label = nodeTypeLabel(t, type);
  return (
    <div
      className={`w-[220px] rounded-lg border bg-layer-1 px-3.5 py-3 transition-all duration-150 ${
        selected
          ? "border-accent-strong shadow-[0_8px_24px_rgba(20,26,36,0.16)]"
          : "border-subtle shadow-[0_1px_2px_rgba(20,26,36,0.04)] hover:border-strong hover:shadow-[0_4px_14px_rgba(20,26,36,0.09)]"
      }`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-strong !h-[9px] !w-[9px] !border-2 !border-white shadow-[0_0_0_1px_rgba(20,26,36,0.08)]"
      />
      {/* Icon anchor (n8n pattern): the type-colored square alone carries the
          node class — no text type label, it only competed with the title. */}
      <div className="flex items-center gap-2.5">
        <span
          className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-sm text-[10px] font-semibold text-white"
          style={{ backgroundColor: accent }}
          title={label}
          aria-hidden
        >
          {label.slice(0, 1) || "N"}
        </span>
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">{data.name || "—"}</p>
      </div>
      <p className="mt-1.5 line-clamp-2 text-12 leading-relaxed text-secondary">{nodeSummary(data, t("agent_teams_canvas_bound_member")) || "—"}</p>
      {type === "condition" ? <ConditionBranchLine nodeId={id} /> : null}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-strong !h-[9px] !w-[9px] !border-2 !border-white shadow-[0_0_0_1px_rgba(20,26,36,0.08)]"
      />
    </div>
  );
}

const nodeTypes = {
  agent: GraphNodeCard,
  tool: GraphNodeCard,
  human_confirm: GraphNodeCard,
  condition: GraphNodeCard,
};

export function graphToFlow(graph: WorkflowGraph | null | undefined): {
  nodes: FlowNode[];
  edges: Edge[];
} {
  return {
    nodes: (graph?.nodes ?? []).map((n) => ({
      id: n.id,
      type: (NODE_TYPES as readonly string[]).includes(n.type) ? (n.type as GraphNodeType) : "agent",
      position: n.position ?? { x: 0, y: 0 },
      data: {
        ...n.data,
        params: n.data.params ? JSON.stringify(n.data.params, null, 2) : "",
        options: normalizeOptions(n.data.options),
      },
    })),
    edges: (graph?.edges ?? []).map((e) => ({
      id: e.id ?? `${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      // Branch label rides on the edge (n8n/Dify pattern).
      label: e.label || undefined,
      labelStyle: { fill: "#d97706", fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: "#fffbeb", stroke: "#fde68a", strokeWidth: 1 },
      labelBgPadding: [5, 2],
      labelBgBorderRadius: 5,
      markerEnd: { type: MarkerType.Arrow, color: "#94a3b8", width: 14, height: 14 },
      style: { stroke: "#cbd5e1", strokeWidth: 1.5 },
    })),
  };
}

function flowToGraphNodes(nodes: FlowNode[], edges: Edge[], branchPlaceholder: string): WorkflowGraphNode[] {
  return nodes.map((n) => {
    const data: Record<string, unknown> = { name: (n.data.name || "").trim() };
    if (n.type === "agent") {
      data.prompt = (n.data.prompt || "").trim();
      if ((n.data.expertId || "").trim()) data.expertId = (n.data.expertId || "").trim();
    }
    if (n.type === "tool") {
      data.tool_name = (n.data.tool_name || "").trim();
      data.connection = (n.data.connection || "").trim() || undefined;
      const raw = (n.data.params || "").trim();
      if (raw) {
        try {
          data.params = JSON.parse(raw);
        } catch {
          data.params = raw; // backend/tool will surface the invalid JSON
        }
      }
    }
    if (n.type === "condition") {
      const outEdges = edges.filter((e) => e.source === n.id);
      data.branches = outEdges.map((e) => ({
        label: ((e as Edge & { label?: string }).label || "").trim() || branchPlaceholder.replace("{index}", String(outEdges.indexOf(e) + 1)),
        target: e.target,
      }));
    }
    if (n.type === "human_confirm") {
      data.message = (n.data.message || "").trim();
      // The backend rejects an approval node without an active Tenant approver.
      if ((n.data.approverUserId || "").trim()) data.approverUserId = (n.data.approverUserId || "").trim();
      if (n.data.freeText === true) data.freeText = true;
      const options = normalizeOptions(n.data.options);
      if (options.length > 0) {
        data.options = options
          .filter((o) => o.label.trim())
          .map((o) => ({
            label: o.label.trim(),
            value: o.terminate ? "reject" : (o.value || o.label).trim(),
            // 序列化键与审批消费端契约对齐（terminal）——历史写 terminate
            // 曾使所有选项终止性丢失（2026-11-05）
            terminal: o.terminate === true,
          }));
      }
    }
    return {
      id: n.id,
      type: n.type,
      position: n.position,
      data: data as WorkflowGraphNode["data"],
    };
  });
}

function nodeFieldMissing(node: FlowNode): boolean {
  if (!node.data.name.trim()) return true;
  // 成员收敛 §3.1（通用 Agent 取缔）：负责员工必选，工作要求为附加说明——
  // 现状员工留空执行必炸（worker no agent reference），收紧即修复。
  if (node.type === "agent") return !(node.data.expertId || "").trim();
  if (node.type === "tool") return !(node.data.tool_name || "").trim();
  if (node.type === "human_confirm")
    return !(node.data.message || "").trim() || !(node.data.approverUserId || "").trim();
  // condition needs a name only — branches come from drawn out-edges.
  return false;
}

export function hasGraphCycle(nodes: WorkflowGraphNode[], edges: { source: string; target: string }[]): boolean {
  // DFS with coloring; edges referencing missing nodes are ignored (dropped on save).
  const ids = new Set(nodes.map((n) => n.id));
  const successors = new Map<string, string[]>();
  for (const n of nodes) successors.set(n.id, []);
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) successors.get(e.source)?.push(e.target);
  }
  const state = new Map<string, 1 | 2>(); // 1 = in stack, 2 = done
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const next of successors.get(id) ?? []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  for (const n of nodes) if (visit(n.id)) return true;
  return false;
}


// Tool catalog entries for the tool-node dropdown (fetched by the page).
export type ToolCatalogEntry = {
  tool_name: string;
  description: string;
  connection_type?: string;
};

const connectionTypeLabel = (type: string, t: ReturnType<typeof useTranslation>["t"]) =>
  type === "zentao"
    ? t("agent_teams_connection_type_zentao")
    : type === "http_api"
      ? t("agent_teams_connection_type_http_api")
      : type;

// Available connections (name + type) for the tool-node credential dropdown —
// filtered by the selected tool's declared connection_type when known.
export type ConnectionEntry = { name: string; type: string; status?: string };

// Published employees for the agent-node binding dropdown (整改一).
export type EmployeeEntry = { id: string; name: string; categoryName?: string };

// Tenant users offered as human_confirm approvers.
export type UserEntry = { id: string; name: string };

export function WorkflowCanvasEditor({
  initialGraph,
  onSave,
  toolCatalog = [],
  connections = [],
  employees = [],
  users = [],
  headerLeft,
  headerRight,
}: {
  initialGraph: WorkflowGraph | null | undefined;
  onSave: (graph: WorkflowGraph) => Promise<void>;
  toolCatalog?: ToolCatalogEntry[];
  connections?: ConnectionEntry[];
  employees?: EmployeeEntry[];
  users?: UserEntry[];
  /** 单行头部左区（返回/标题等）；缺省渲染添加节点菜单。 */
  headerLeft?: React.ReactNode;
  /** 单行头部右区（发布/设置等），渲染在保存按钮左侧。 */
  headerRight?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(graphToFlow(initialGraph).nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(graphToFlow(initialGraph).edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const ADD_LABELS: Record<string, string> = {
    agent: t("agent_teams_canvas_add_agent"),
    tool: t("agent_teams_canvas_add_tool"),
    human_confirm: t("agent_teams_canvas_add_confirm"),
    condition: t("agent_teams_canvas_add_condition"),
  };
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId]);

  // AI 节点的连接选择数据（设计 §5.2）：数字员工自带工具能力，按连接类型分组提供选择
  const agentConnections = useMemo(() => {
    if (!selectedNode || selectedNode.type !== "agent" || connections.length === 0) return [];
    const grouped = new Map<string, ConnectionEntry[]>();
    for (const conn of connections) {
      if (!grouped.has(conn.type)) grouped.set(conn.type, []);
      grouped.get(conn.type)!.push(conn);
    }
    return Array.from(grouped.entries()).map(([type, options]) => ({ type, options }));
  }, [selectedNode, connections]);

  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            labelStyle: { fill: "#d97706", fontSize: 10, fontWeight: 600 },
            labelBgStyle: { fill: "#fffbeb", stroke: "#fde68a", strokeWidth: 1 },
            labelBgPadding: [5, 2],
            labelBgBorderRadius: 5,
            markerEnd: { type: MarkerType.Arrow, color: "#94a3b8", width: 14, height: 14 },
            style: { stroke: "#cbd5e1", strokeWidth: 1.5 },
          },
          eds
        )
      ),
    [setEdges]
  );

  const addNode = useCallback(
    (type: GraphNodeType) => {
      const id = `n_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
      const maxY = nodes.reduce((acc, n) => Math.max(acc, n.position.y), 0);
      setNodes((current) => [
        ...current,
        {
          id,
          type,
          position: {
            x: 120 + ((current.length % 3) - 1) * (NODE_WIDTH + 60),
            y: maxY + NODE_NEW_OFFSET,
          },
          data:
            type === "tool"
              ? { name: "", tool_name: toolCatalog[0]?.tool_name ?? "", connection: "", params: "" }
              : type === "human_confirm"
                ? { name: "", message: "", options: [] }
                : type === "condition"
                  ? { name: "", branches: [] }
                  : { name: "", prompt: "" },
        },
      ]);
      setSelectedId(id);
    },
    [nodes, setNodes, toolCatalog]
  );

  const patchSelected = (patch: Partial<NodeData>) => {
    if (!selectedId) return;
    setNodes((current) => current.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n)));
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setNodes((current) => current.filter((n) => n.id !== selectedId));
    setEdges((current) => current.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  };

  const save = async () => {
    setError("");
    setMessage("");
    const missing = nodes.filter(nodeFieldMissing);
    if (missing.length > 0) {
      setSelectedId(missing[0].id);
      setError(t("agent_teams_canvas_empty_field_error"));
      return;
    }
    const graphNodes = flowToGraphNodes(nodes, edges, t("agent_teams_canvas_branch_placeholder"));
    const nodeIds = new Set(graphNodes.map((n) => n.id));
    const graph: WorkflowGraph = {
      version: 1,
      nodes: graphNodes,
      edges: edges
        .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target)
        .map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          label: ((e as Edge & { label?: string }).label || "").trim() || undefined,
        })),
    };
    if (hasGraphCycle(graph.nodes, graph.edges)) {
      setError(t("agent_teams_canvas_cycle_error"));
      return;
    }
    setSaving(true);
    try {
      await onSave(graph);
      setMessage(t("agent_teams_canvas_saved_message"));
    } catch {
      setError(t("agent_teams_canvas_save_failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Toolbar — ONE row, grouped (n8n pattern): add-node dropdown left,
          feedback + save right. The four per-type buttons crammed beside save
          read as noise; one quiet menu carries the catalog. */}
      <header className="flex items-center gap-2.5 border-b border-subtle px-4 py-2">
        {headerLeft}
        <CustomMenu
          customButton={
            <Button variant="secondary" size="lg">
              <Plus className="size-3.5" aria-hidden />
              {t("agent_teams_canvas_add_node")}
            </Button>
          }
          placement="bottom-start"
          closeOnSelect
        >
          {(["agent", "tool", "human_confirm", "condition"] as const).map((type) => (
            <CustomMenu.MenuItem key={type} onClick={() => addNode(type)} className="flex items-center gap-2.5">
              <span
                className="size-[7px] shrink-0 rounded-full"
                style={{ backgroundColor: TYPE_ACCENTS[type] }}
                aria-hidden
              />
              {ADD_LABELS[type]}
            </CustomMenu.MenuItem>
          ))}
        </CustomMenu>
        <span className="flex-1" />
        {error ? <span className="text-12 text-danger-primary">{error}</span> : null}
        {message ? <span className="text-emerald-600 text-12">{message}</span> : null}
        {headerRight}
        <Button variant="primary" size="lg" onClick={() => void save()} loading={saving}>
          {saving ? t("agent_teams_canvas_saving") : t("agent_teams_canvas_save")}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Canvas */}
        <div className="min-w-0 flex-1 bg-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            nodeTypes={nodeTypes}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={1.75}
            panOnScroll
            zoomOnScroll={false}
            selectionOnDrag
            panOnDrag={[1, 2]}
            snapToGrid
            snapGrid={[20, 20]}
            connectionRadius={32}
            defaultEdgeOptions={{ type: "smoothstep" }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} color="#cbd5e1" />
            <Controls position="bottom-left" showInteractive={false} showFitView />
            <MiniMap position="bottom-right" pannable zoomable nodeColor="#cbd5e1" maskColor="rgba(250,250,251,0.75)" />
          </ReactFlow>
        </div>

        {/* Property panel */}
        <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-subtle bg-surface-1">
          {selectedNode ? (
            <div className="flex min-h-full flex-col gap-5 p-4">
              <div className="flex items-center gap-2 border-b border-subtle pb-3">
                <span
                  className="grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-semibold text-white"
                  style={{ backgroundColor: TYPE_ACCENTS[selectedNode.type] ?? "#64748b" }}
                  aria-hidden
                >
                  {nodeTypeLabel(t, selectedNode.type).slice(0, 1) || "N"}
                </span>
                <span className="text-13 font-medium text-primary">
                  {nodeTypeLabel(t, selectedNode.type)}
                </span>
                <span className="text-12 text-tertiary">{t("agent_teams_canvas_node_panel_title")}</span>
              </div>
              <div className="grid gap-1.5">
                <span className={FIELD_LABEL_CLASS}>{t("agent_teams_canvas_field_name")}</span>
                <Input
                  mode="primary"
                  inputSize="sm"
                  className="w-full"
                  value={selectedNode.data.name}
                  onChange={(e) => patchSelected({ name: e.target.value })}
                />
              </div>
              {selectedNode.type === "agent" ? (
                <>
                  <div className="grid gap-1.5">
                    <span className={FIELD_LABEL_CLASS}>{t("agent_teams_canvas_field_employee")}</span>
                    {employees.length > 0 ? (
                      <span className="block">
                        <FormSelect
                          value={selectedNode.data.expertId ?? ""}
                          placeholder={t("agent_teams_canvas_generic_agent")}
                          options={employees.map((emp) => ({
                            id: emp.id,
                            name: emp.categoryName ? `${emp.name} (${emp.categoryName})` : emp.name,
                          }))}
                          onChange={(v) => patchSelected({ expertId: v })}
                        />
                      </span>
                    ) : (
                      <>
                        <Input
                          mode="primary"
                          inputSize="sm"
                          className="w-full"
                          value={selectedNode.data.expertId ?? ""}
                          onChange={(e) => patchSelected({ expertId: e.target.value })}
                          placeholder="expert_…"
                        />
                        {t("agent_teams_canvas_field_employee_empty_hint") ? (
                          <span className={FIELD_HINT_CLASS}>· {t("agent_teams_canvas_field_employee_empty_hint")}</span>
                        ) : null}
                      </>
                    )}
                    {(() => {
                      const picked = (selectedNode.data.expertId ?? "").trim();
                      const bound = employees.find((emp) => emp.id === picked);
                      if (bound) return <span className={FIELD_HINT_CLASS}>· {t("agent_teams_canvas_employee_persona_injected")}</span>;
                      // 越界警示：已选值不在团队名册（挂载时后端会拦，提前在画布可见）
                      if (picked && employees.length > 0 && t("agent_teams_canvas_employee_out_of_roster"))
                        return <span className="text-11 text-danger-primary">· {t("agent_teams_canvas_employee_out_of_roster")}</span>;
                      return null;
                    })()}
                    {t("agent_teams_canvas_member_source_hint") ? (
                      <span className={FIELD_HINT_CLASS}>· {t("agent_teams_canvas_member_source_hint")}</span>
                    ) : null}
                  </div>
                  <div className="grid gap-1.5">
                    <span className={FIELD_LABEL_CLASS}>{t("agent_teams_canvas_field_prompt")}</span>
                    <TextArea
                      mode="primary"
                      textAreaSize="sm"
                      className="font-normal min-h-28 w-full resize-y text-13"
                      value={selectedNode.data.prompt ?? ""}
                      onChange={(e) => patchSelected({ prompt: e.target.value })}
                      placeholder={t("agent_teams_canvas_field_prompt_placeholder")}
                    />
                    <span className={FIELD_HINT_CLASS}>{t("agent_teams_canvas_field_prompt_hint")}</span>
                  </div>
                  {/* 连接（条件区，设计 §5.2）：所选员工携带工具时为每类工具选连接 */}
                  {agentConnections.length > 0 ? (
                    <div className="flex flex-col gap-2 rounded-md border border-subtle px-2.5 py-2">
                      <span className={FIELD_LABEL_CLASS}>{t("agent_teams_canvas_connections_section")}</span>
                      {agentConnections.map((entry) => (
                        <div key={entry.type} className="flex flex-col gap-1">
                          <span className="text-11 text-tertiary">{connectionTypeLabel(entry.type, t)}</span>
                          <span className="flex items-center gap-1.5">
                            <FormSelect
                              value={
                                (selectedNode.data.connections as Record<string, string> | undefined)?.[entry.type] ??
                                ""
                              }
                              placeholder={t("agent_teams_canvas_connection_select")}
                              options={entry.options.map((c) => ({
                                id: c.name,
                                name: c.status === "unreachable" ? `${c.name} ⚠` : c.name,
                              }))}
                              onChange={(v) =>
                                patchSelected({
                                  connections: {
                                    ...(selectedNode.data.connections as Record<string, string>),
                                    [entry.type]: v,
                                  } as Record<string, string>,
                                })
                              }
                            />
                          </span>
                        </div>
                      ))}
                      <span className={FIELD_HINT_CLASS}>{t("agent_teams_canvas_connection_hint")}</span>
                    </div>
                  ) : null}
                </>
              ) : null}
              {selectedNode.type === "tool" ? (
                <>
                  <div className="grid gap-1.5">
                    <span className={FIELD_LABEL_CLASS}>{t("agent_teams_canvas_field_tool_name")}</span>
                    {toolCatalog.length > 0 ? (
                      <span className="block">
                        <FormSelect
                          value={selectedNode.data.tool_name ?? ""}
                          placeholder={t("agent_teams_canvas_field_tool_name")}
                          options={toolCatalog.map((t) => ({ id: t.tool_name, name: t.tool_name }))}
                          onChange={(v) => patchSelected({ tool_name: v })}
                        />
                      </span>
                    ) : (
                      <Input
                        mode="primary"
                        inputSize="sm"
                        className="w-full"
                        value={selectedNode.data.tool_name ?? ""}
                        onChange={(e) => patchSelected({ tool_name: e.target.value })}
                        placeholder="demo_pm.login"
                      />
                    )}
                  </div>
                  <div className="grid gap-1.5">
                    <span className={FIELD_LABEL_CLASS}>{t("agent_teams_canvas_field_connection")}</span>
                    {(() => {
                      const toolType = toolCatalog.find(
                        (t) => t.tool_name === selectedNode.data.tool_name
                      )?.connection_type;
                      const options = toolType ? connections.filter((c) => c.type === toolType) : connections;
                      return options.length > 0 ? (
                        <span className="block">
                          <FormSelect
                            value={selectedNode.data.connection ?? ""}
                            placeholder={t("agent_teams_canvas_no_connection")}
                            options={options.map((c) => ({ id: c.name, name: `${c.name} (${c.type})` }))}
                            onChange={(v) => patchSelected({ connection: v })}
                          />
                        </span>
                      ) : (
                        <Input
                          mode="primary"
                          inputSize="sm"
                          className="w-full"
                          value={selectedNode.data.connection ?? ""}
                          onChange={(e) => patchSelected({ connection: e.target.value })}
                          placeholder={t("agent_teams_canvas_connection_placeholder")}
                        />
                      );
                    })()}
                  </div>
                  <div className="grid gap-1.5">
                    <span className={FIELD_LABEL_CLASS}>{t("agent_teams_canvas_field_params")}</span>
                    <TextArea
                      mode="primary"
                      textAreaSize="sm"
                      className="font-mono font-normal w-full resize-y text-12"
                      rows={6}
                      value={selectedNode.data.params ?? ""}
                      onChange={(e) => patchSelected({ params: e.target.value })}
                      placeholder='{"severity": "P1"}'
                    />
                  </div>
                </>
              ) : null}
              {selectedNode.type === "condition" ? (
                <div className="mt-4">
                  <p className="text-12 font-medium text-secondary">{t("agent_teams_canvas_field_branches")}</p>
                  <p className={FIELD_HINT_CLASS}>{t("agent_teams_canvas_field_branches_hint")}</p>
                  <div className="mt-2 space-y-2">
                    {edges
                      .filter((e) => e.source === selectedNode.id)
                      .map((edge) => {
                        const target = nodes.find((n) => n.id === edge.target);
                        return (
                          <div key={edge.id} className="flex items-center gap-2">
                            <Input
                              mode="primary"
                              placeholder={t("agent_teams_canvas_branch_label_auto", { index: edges.filter((x) => x.source === selectedNode.id).indexOf(edge) + 1 })}
                              onChange={(e) =>
                                setEdges((current) =>
                                  current.map((x) => (x.id === edge.id ? ({ ...x, label: e.target.value } as Edge) : x))
                                )
                              }
                              className="w-full"
                              inputSize="xs"
                            />
                            <span className="shrink-0 truncate text-12 text-tertiary">
                              → {target?.data.name || target?.id.slice(0, 8) || "?"}
                            </span>
                          </div>
                        );
                      })}
                    {edges.filter((e) => e.source === selectedNode.id).length === 0 ? (
                      <p className="text-12 text-tertiary">{t("agent_teams_canvas_no_branches")}</p>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {selectedNode.type === "human_confirm" ? (
                <>
                  <div className="grid gap-1.5">
                    <span className={FIELD_LABEL_CLASS}>{t("agent_teams_canvas_field_message")}</span>
                    <TextArea
                      mode="primary"
                      textAreaSize="sm"
                      className="font-normal w-full resize-y text-13"
                      rows={4}
                      value={selectedNode.data.message ?? ""}
                      onChange={(e) => patchSelected({ message: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <span className={FIELD_LABEL_CLASS}>{t("agent_teams_canvas_field_approver")}</span>
                    <span className="block">
                      <FormSelect
                        value={selectedNode.data.approverUserId ?? ""}
                        placeholder={t("agent_teams_canvas_field_approver_placeholder")}
                        options={users.map((u) => ({ id: u.id, name: u.name }))}
                        onChange={(v) => patchSelected({ approverUserId: v })}
                      />
                    </span>
                    {users.length === 0 && t("agent_teams_canvas_field_approver_empty_hint") ? (
                      <span className={FIELD_HINT_CLASS}>· {t("agent_teams_canvas_field_approver_empty_hint")}</span>
                    ) : null}
                    {(() => {
                      // 成员收敛 §3.5：越界警示 + 未指定语义提示（收窄为团队真人可答）
                      const picked = (selectedNode.data.approverUserId ?? "").trim();
                      if (
                        picked &&
                        users.length > 0 &&
                        !users.some((u) => u.id === picked) &&
                        t("agent_teams_canvas_approver_out_of_roster")
                      )
                        return <span className="text-11 text-danger-primary">· {t("agent_teams_canvas_approver_out_of_roster")}</span>;
                      if (!picked && t("agent_teams_canvas_approver_team_hint"))
                        return <span className={FIELD_HINT_CLASS}>· {t("agent_teams_canvas_approver_team_hint")}</span>;
                      return null;
                    })()}
                  </div>
                  <div className="flex items-center gap-2 text-12 text-secondary">
                    <Checkbox
                      checked={selectedNode.data.freeText === true}
                      onChange={(e) => patchSelected({ freeText: e.target.checked })}
                    />
                    {t("agent_teams_canvas_field_free_text")}
                  </div>
                  <div className="grid gap-2.5 rounded-md border-[0.5px] border-subtle-1 bg-layer-1 p-3.5">
                    <div className="grid gap-0.5">
                      <p className="text-12 font-medium text-secondary">{t("agent_teams_canvas_field_options")}</p>
                      <p className={FIELD_HINT_CLASS}>{t("agent_teams_canvas_field_options_hint")}</p>
                    </div>
                    <div className="space-y-2">
                      {editableOptions(selectedNode.data.options).map((option, index, all) => (
                        // 选项为草稿行集合（可空 label、无稳定 id），key 用行号占位是
                        // 刻意选择：重排不发生（仅追加/删除尾行）。
                        // oxlint-disable-next-line react/no-array-index-key
                        <div key={index} className="flex items-center gap-2">
                          <Input
                            mode="primary"
                            value={option.label}
                            placeholder={t("agent_teams_canvas_option_label")}
                            onChange={(e) => {
                              const next = [...all];
                              next[index] = { ...option, label: e.target.value };
                              patchSelected({ options: next });
                            }}
                            className="w-full"
                            inputSize="xs"
                          />
                          <div
                            className="flex shrink-0 cursor-pointer items-center gap-1.5 text-12 text-secondary"
                            title={t("agent_teams_canvas_terminate_hint")}
                          >
                            <Checkbox
                              checked={option.terminate === true}
                              onChange={(e) => {
                                const next = [...all];
                                next[index] = { ...option, terminate: e.target.checked };
                                patchSelected({ options: next });
                              }}
                            />
                            {t("agent_teams_canvas_terminate")}
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              patchSelected({
                                options: all.filter((_, i) => i !== index),
                              })
                            }
                            className="shrink-0 rounded-sm border border-danger-strong px-2 py-1 text-12 text-danger-primary hover:bg-danger-subtle"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          patchSelected({
                            options: [...editableOptions(selectedNode.data.options), { label: "", value: "" }],
                          })
                        }
                        className="text-custom-primary-100 w-full rounded-md border border-dashed border-strong px-3 py-1.5 text-12 hover:border-accent-strong hover:bg-layer-2-hover"
                      >
                        + {t("agent_teams_canvas_add_option")}
                      </button>
                    </div>
                  </div>
                </>
              ) : null}
              <span className="flex-1" />
              <div className="flex justify-end border-t border-subtle pt-3">
                <Button variant="error-outline" size="lg" onClick={deleteSelected}>
                  {t("agent_teams_canvas_delete_node")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid place-items-center p-4 pt-10">
              <MousePointerClick className="size-5 text-tertiary" aria-hidden />
              <p className="mt-3 max-w-[240px] text-center text-12 leading-relaxed text-tertiary">
                {t("agent_teams_canvas_select_node_hint")}
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
