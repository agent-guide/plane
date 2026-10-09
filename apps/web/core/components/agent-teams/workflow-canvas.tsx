// Workflow canvas editor (docs/workflow-graph-editor-plan.md §4-§5), extracted from
// the admin page so it stays route-agnostic: the upcoming execution-visualization
// view (P3) reuses the same canvas in read-only form. Nodes/edges are edited on
// XYFlow and handed back via onSave as ONE graph document (whole-document
// replace, never partial patches). Validation mirrors the backend: node name +
// per-type required fields, no dangling edges, no cycles. position is view-only.
//
// Node types (§5): agent (autonomous LLM work), tool (deterministic MCP call,
// connection-resolved credentials), human_confirm (pauses the run for a person).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
// 表单样式常量内联自管理端 ui-fields（画布编辑器整体沿用其成熟视觉，
// 页面外壳才使用 Plane 组件体系——专用编辑面与页面 chrome 分层）。
const FIELD_LABEL_CLASS = "mt-5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a948a]";
const FIELD_HINT_CLASS = "mt-1 block text-[12px] font-normal leading-[1.6] text-[#9a948a]";
const FIELD_INPUT_CLASS =
  "mt-1.5 w-full rounded-[10px] border border-[#e6e2da] bg-white px-3 py-2 text-[13px] font-normal text-[#1f242d] outline-none transition-colors hover:border-[#d8d2c8] focus:border-[#4a5260]";
const FIELD_TEXTAREA_CLASS = `${FIELD_INPUT_CLASS} resize-y leading-[1.7]`;
const FIELD_MONO_TEXTAREA_CLASS =
  "mt-1.5 w-full resize-y rounded-[10px] border border-[#e6e2da] bg-white px-3 py-2 font-mono text-[12px] font-normal leading-[1.6] text-[#1f242d] outline-none transition-colors hover:border-[#d8d2c8] focus:border-[#4a5260]";
const FIELD_ROW_INPUT_CLASS =
  "min-w-0 flex-1 rounded-[8px] border border-[#e6e2da] bg-white px-2.5 py-1.5 text-[13px] font-normal text-[#1f242d] outline-none focus:border-[#4a5260]";

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

const TYPE_LABELS: Record<string, string> = {
  agent: "Agent",
  tool: "Tool",
  human_confirm: "确认",
  condition: "条件",
};

function nodeSummary(data: NodeData): string {
  if (data.expertId) return data.prompt || "已绑定员工";
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
      terminate: o.value === "reject" || o.terminate === true,
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
      terminate: o.value === "reject" || o.terminate === true,
    }));
}

// Live branch summary derived from the CURRENT canvas edges (not the saved
// payload) — the card shows branches the moment they are drawn (n8n/Dify
// pattern), empty labels fall back to 分支N placeholders.
function ConditionBranchLine({ nodeId }: { nodeId: string }) {
  // Live edges/nodes via XYFlow hooks — branches appear as they are drawn,
  // before any save (n8n/Dify pattern); empty labels show 分支N placeholders.
  const edges = useEdges();
  const nodes = useNodes() as FlowNode[];
  const summary = branchSummary(nodeId, edges, nodes);
  return <p className="mt-1 truncate text-[11px] leading-[1.6] text-[#a16207]">{summary || "（拉出连线定义分支）"}</p>;
}

function branchSummary(nodeId: string, edges: Edge[], nodes: FlowNode[]): string {
  const out = edges.filter((e) => e.source === nodeId);
  if (out.length === 0) return "";
  return out
    .map((e, i) => {
      const label = ((e as Edge & { label?: string }).label || "").trim();
      const target = nodes.find((n) => n.id === e.target);
      return `${label || `分支${i + 1}`}→${target?.data.name || "?"}`;
    })
    .join("  ");
}

function PlusIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

// Type-coded accent (n8n/Dify pattern): one quiet color dot per node class so
// a populated canvas reads by shape of color before any label. Canvas-local
// coding — agent ink, tool neutral, confirm amber (needs a human), condition
// green (routes onward).
const TYPE_ACCENTS: Record<string, string> = {
  agent: "#232f3e",
  tool: "#6f7783",
  human_confirm: "#a16207",
  condition: "#3ba272",
};

export function GraphNodeCard({ data, selected, type, id }: NodeProps<FlowNode>) {
  const accent = TYPE_ACCENTS[type] ?? "#6f7783";
  return (
    <div
      className={`w-[220px] rounded-[14px] border bg-gradient-to-b from-white to-[#fbfaf8] px-3.5 py-3 ring-1 transition-all duration-150 ${
        selected
          ? "border-[#232f3e] shadow-[0_8px_24px_rgba(20,26,36,0.16)] ring-[#232f3e]"
          : "border-[#e6e2da] shadow-[0_1px_2px_rgba(20,26,36,0.04)] ring-transparent hover:border-[#d8d2c8] hover:shadow-[0_4px_14px_rgba(20,26,36,0.09)]"
      }`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-[9px] !w-[9px] !border-2 !border-white !bg-[#c8c2b6] shadow-[0_0_0_1px_rgba(20,26,36,0.08)]"
      />
      {/* Icon anchor (n8n pattern): the type-colored square alone carries the
          node class — no text type label, it only competed with the title. */}
      <div className="flex items-center gap-2.5">
        <span
          className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-[6px] text-[10px] font-semibold text-white"
          style={{ backgroundColor: accent }}
          title={TYPE_LABELS[type] ?? type}
          aria-hidden
        >
          {(TYPE_LABELS[type] ?? "N").slice(0, 1)}
        </span>
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#1f242d]">{data.name || "—"}</p>
      </div>
      <p className="mt-1.5 line-clamp-2 text-[12px] leading-[1.55] text-[#6f6a61]">{nodeSummary(data) || "—"}</p>
      {type === "condition" ? <ConditionBranchLine nodeId={id} /> : null}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-[9px] !w-[9px] !border-2 !border-white !bg-[#c8c2b6] shadow-[0_0_0_1px_rgba(20,26,36,0.08)]"
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
      labelStyle: { fill: "#a16207", fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: "#fffdf8", stroke: "#f1dec1", strokeWidth: 1 },
      labelBgPadding: [5, 2],
      labelBgBorderRadius: 5,
      markerEnd: { type: MarkerType.Arrow, color: "#a39d91", width: 14, height: 14 },
      style: { stroke: "#c8c2b6", strokeWidth: 1.5 },
    })),
  };
}

function flowToGraphNodes(nodes: FlowNode[], edges: Edge[]): WorkflowGraphNode[] {
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
        label: ((e as Edge & { label?: string }).label || "").trim() || `分支${outEdges.indexOf(e) + 1}`,
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
            terminate: o.terminate === true,
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
  // 整改一: an agent node needs a prompt OR a bound employee (whose persona the
  // backend injects; the prompt then acts as optional extra instruction).
  if (node.type === "agent") return !(node.data.prompt || "").trim() && !(node.data.expertId || "").trim();
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

export type WorkflowCanvasEditorLabels = {
  addAgent: string;
  addTool: string;
  addConfirm: string;
  addCondition: string;
  fieldBranches: string;
  fieldBranchesHint: string;
  branchLabel: string;
  noBranches: string;
  save: string;
  saving: string;
  savedMessage: string;
  saveFailed: string;
  emptyFieldError: string;
  cycleError: string;
  nodePanelTitle: string;
  fieldName: string;
  fieldEmployee: string;
  genericAgent: string;
  employeePersonaInjected: string;
  addNode: string;
  fieldPrompt: string;
  fieldPromptHint: string;
  fieldPromptPlaceholder: string;
  fieldToolName: string;
  fieldConnection: string;
  noConnection: string;
  connectionPlaceholder: string;
  fieldParams: string;
  fieldMessage: string;
  fieldApprover: string;
  fieldApproverPlaceholder: string;
  fieldFreeText: string;
  fieldOptions: string;
  fieldOptionsHint: string;
  optionLabel: string;
  terminate: string;
  terminateHint: string;
  addOption: string;
  deleteNode: string;
  selectNodeHint: string;
};

// Tool catalog entries for the tool-node dropdown (fetched by the page).
export type ToolCatalogEntry = {
  tool_name: string;
  description: string;
  connection_type?: string;
};

// Available connections (name + type) for the tool-node credential dropdown —
// filtered by the selected tool's declared connection_type when known.
export type ConnectionEntry = { name: string; type: string };

// Published employees for the agent-node binding dropdown (整改一).
export type EmployeeEntry = { id: string; name: string; categoryName?: string };

// Tenant users offered as human_confirm approvers.
export type UserEntry = { id: string; name: string };

export function WorkflowCanvasEditor({
  initialGraph,
  onSave,
  labels,
  toolCatalog = [],
  connections = [],
  employees = [],
  users = [],
}: {
  initialGraph: WorkflowGraph | null | undefined;
  onSave: (graph: WorkflowGraph) => Promise<void>;
  labels: WorkflowCanvasEditorLabels;
  toolCatalog?: ToolCatalogEntry[];
  connections?: ConnectionEntry[];
  employees?: EmployeeEntry[];
  users?: UserEntry[];
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(graphToFlow(initialGraph).nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(graphToFlow(initialGraph).edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Element)) setAddMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [addMenuOpen]);
  const ADD_LABELS: Record<string, string> = {
    agent: labels.addAgent,
    tool: labels.addTool,
    human_confirm: labels.addConfirm,
    condition: labels.addCondition,
  };
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId]);

  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            labelStyle: { fill: "#a16207", fontSize: 10, fontWeight: 600 },
            labelBgStyle: { fill: "#fffdf8", stroke: "#f1dec1", strokeWidth: 1 },
            labelBgPadding: [5, 2],
            labelBgBorderRadius: 5,
            markerEnd: { type: MarkerType.Arrow, color: "#a39d91", width: 14, height: 14 },
            style: { stroke: "#c8c2b6", strokeWidth: 1.5 },
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
      setError(labels.emptyFieldError);
      return;
    }
    const graphNodes = flowToGraphNodes(nodes, edges);
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
      setError(labels.cycleError);
      return;
    }
    setSaving(true);
    try {
      await onSave(graph);
      setMessage(labels.savedMessage);
    } catch {
      setError(labels.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Toolbar — ONE row, grouped (n8n pattern): add-node dropdown left,
          feedback + save right. The four per-type buttons crammed beside save
          read as noise; one quiet menu carries the catalog. */}
      <header className="flex items-center gap-3 border-b border-[#ece8e2] px-4 py-2.5">
        <div className="relative" ref={addMenuRef}>
          <button
            type="button"
            onClick={() => setAddMenuOpen((open) => !open)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[#e6e2da] bg-white px-3.5 py-2 text-[13px] font-medium text-[#1f242d] transition-colors hover:border-[#d8d2c8] hover:bg-[#faf9f7]"
          >
            <PlusIcon className="h-[15px] w-[15px]" />
            {labels.addNode}
          </button>
          {addMenuOpen ? (
            <div className="absolute top-11 left-0 z-30 w-[184px] overflow-hidden rounded-[12px] border border-[#e0dcd4] bg-white py-1 shadow-[0_12px_34px_rgba(20,26,36,0.16)]">
              {(["agent", "tool", "human_confirm", "condition"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    addNode(type);
                    setAddMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[#222832] hover:bg-[#f6f4f0]"
                >
                  <span
                    className="h-[7px] w-[7px] shrink-0 rounded-full"
                    style={{ backgroundColor: TYPE_ACCENTS[type] }}
                    aria-hidden
                  />
                  {ADD_LABELS[type]}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <span className="flex-1" />
        {error ? <span className="text-[13px] text-[#b42318]">{error}</span> : null}
        {message ? <span className="text-[13px] text-[#047857]">{message}</span> : null}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-xl bg-[#232f3e] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#2c3a4d] disabled:opacity-50"
        >
          {saving ? labels.saving : labels.save}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Canvas */}
        <div className="min-w-0 flex-1">
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
            <Background variant={BackgroundVariant.Dots} gap={20} color="#ece8e0" />
            <Controls position="bottom-left" showInteractive={false} showFitView />
            <MiniMap position="bottom-right" pannable zoomable nodeColor="#d5cfc3" maskColor="rgba(250,249,247,0.7)" />
          </ReactFlow>
        </div>

        {/* Property panel */}
        <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-[#ece8e2] bg-[#faf9f7] px-5 py-4">
          {selectedNode ? (
            <div className="flex min-h-full flex-col">
              <p className="tracking-widest text-[11px] font-medium text-[#9a948a] uppercase">
                {TYPE_LABELS[selectedNode.type] ?? selectedNode.type} · {labels.nodePanelTitle}
              </p>
              <label className={FIELD_LABEL_CLASS}>
                {labels.fieldName}
                <input
                  value={selectedNode.data.name}
                  onChange={(e) => patchSelected({ name: e.target.value })}
                  className={FIELD_INPUT_CLASS}
                />
              </label>
              {selectedNode.type === "agent" ? (
                <>
                  <label className={FIELD_LABEL_CLASS}>
                    {labels.fieldEmployee}
                    {employees.length > 0 ? (
                      <select
                        value={selectedNode.data.expertId ?? ""}
                        onChange={(e) => patchSelected({ expertId: e.target.value })}
                        className={FIELD_INPUT_CLASS}
                      >
                        <option value="">{labels.genericAgent}</option>
                        {employees.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.name}
                            {emp.categoryName ? `（${emp.categoryName}）` : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={selectedNode.data.expertId ?? ""}
                        onChange={(e) => patchSelected({ expertId: e.target.value })}
                        placeholder="expert_…"
                        className={FIELD_INPUT_CLASS}
                      />
                    )}
                    {(() => {
                      const bound = employees.find((emp) => emp.id === selectedNode.data.expertId);
                      return bound ? (
                        <span className="font-normal mt-1 block text-[12px] leading-[1.6] text-[#a16207]">
                          {bound.name} · {labels.employeePersonaInjected}
                        </span>
                      ) : null;
                    })()}
                  </label>
                  <label className={FIELD_LABEL_CLASS}>
                    {labels.fieldPrompt}
                    <span className={FIELD_HINT_CLASS}>{labels.fieldPromptHint}</span>
                    <textarea
                      value={selectedNode.data.prompt ?? ""}
                      onChange={(e) => patchSelected({ prompt: e.target.value })}
                      rows={10}
                      placeholder={labels.fieldPromptPlaceholder}
                      className={FIELD_TEXTAREA_CLASS}
                    />
                  </label>
                </>
              ) : null}
              {selectedNode.type === "tool" ? (
                <>
                  <label className={FIELD_LABEL_CLASS}>
                    {labels.fieldToolName}
                    {toolCatalog.length > 0 ? (
                      <select
                        value={selectedNode.data.tool_name ?? ""}
                        onChange={(e) => patchSelected({ tool_name: e.target.value })}
                        className={FIELD_INPUT_CLASS}
                      >
                        {toolCatalog.map((t) => (
                          <option key={t.tool_name} value={t.tool_name}>
                            {t.tool_name} — {t.description}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={selectedNode.data.tool_name ?? ""}
                        onChange={(e) => patchSelected({ tool_name: e.target.value })}
                        placeholder="demo_pm.login"
                        className={FIELD_INPUT_CLASS}
                      />
                    )}
                  </label>
                  <label className={FIELD_LABEL_CLASS}>
                    {labels.fieldConnection}
                    {(() => {
                      const toolType = toolCatalog.find(
                        (t) => t.tool_name === selectedNode.data.tool_name
                      )?.connection_type;
                      const options = toolType ? connections.filter((c) => c.type === toolType) : connections;
                      return options.length > 0 ? (
                        <select
                          value={selectedNode.data.connection ?? ""}
                          onChange={(e) => patchSelected({ connection: e.target.value })}
                          className={FIELD_INPUT_CLASS}
                        >
                          <option value="">{labels.noConnection}</option>
                          {options.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}（{c.type}）
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={selectedNode.data.connection ?? ""}
                          onChange={(e) => patchSelected({ connection: e.target.value })}
                          placeholder={labels.connectionPlaceholder}
                          className={FIELD_INPUT_CLASS}
                        />
                      );
                    })()}
                  </label>
                  <label className={FIELD_LABEL_CLASS}>
                    {labels.fieldParams}
                    <textarea
                      value={selectedNode.data.params ?? ""}
                      onChange={(e) => patchSelected({ params: e.target.value })}
                      rows={6}
                      placeholder='{"severity": "P1"}'
                      className={FIELD_MONO_TEXTAREA_CLASS}
                    />
                  </label>
                </>
              ) : null}
              {selectedNode.type === "condition" ? (
                <div className="mt-4">
                  <p className="text-[11px] font-semibold tracking-[0.12em] text-[#9a948a] uppercase">
                    {labels.fieldBranches}
                  </p>
                  <p className="mt-1 text-[12px] leading-[1.6] text-[#9a948a]">{labels.fieldBranchesHint}</p>
                  <div className="mt-2 space-y-2">
                    {edges
                      .filter((e) => e.source === selectedNode.id)
                      .map((edge) => {
                        const target = nodes.find((n) => n.id === edge.target);
                        return (
                          <div key={edge.id} className="flex items-center gap-2">
                            <input
                              value={(edge as Edge & { label?: string }).label ?? ""}
                              placeholder={`${labels.branchLabel}${edges.filter((x) => x.source === selectedNode.id).indexOf(edge) + 1}（留空自动命名）`}
                              onChange={(e) =>
                                setEdges((current) =>
                                  current.map((x) => (x.id === edge.id ? ({ ...x, label: e.target.value } as Edge) : x))
                                )
                              }
                              className={FIELD_ROW_INPUT_CLASS}
                            />
                            <span className="shrink-0 truncate text-[12px] text-[#9a948a]">
                              → {target?.data.name || target?.id.slice(0, 8) || "?"}
                            </span>
                          </div>
                        );
                      })}
                    {edges.filter((e) => e.source === selectedNode.id).length === 0 ? (
                      <p className="text-[12px] text-[#b3b9c4]">{labels.noBranches}</p>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {selectedNode.type === "human_confirm" ? (
                <>
                  <label className={FIELD_LABEL_CLASS}>
                    {labels.fieldMessage}
                    <textarea
                      value={selectedNode.data.message ?? ""}
                      onChange={(e) => patchSelected({ message: e.target.value })}
                      rows={4}
                      className={FIELD_TEXTAREA_CLASS}
                    />
                  </label>
                  <label className={FIELD_LABEL_CLASS}>
                    {labels.fieldApprover}
                    <select
                      value={selectedNode.data.approverUserId ?? ""}
                      onChange={(e) => patchSelected({ approverUserId: e.target.value })}
                      className={FIELD_ROW_INPUT_CLASS}
                    >
                      <option value="">{labels.fieldApproverPlaceholder}</option>
                      {users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="mt-1 flex items-center gap-2 text-[12px] text-[#9a948a]">
                    <input
                      type="checkbox"
                      checked={selectedNode.data.freeText === true}
                      onChange={(e) => patchSelected({ freeText: e.target.checked })}
                      className="h-4 w-4 accent-[#232f3e]"
                    />
                    {labels.fieldFreeText}
                  </label>
                  <div className="mt-4">
                    <p className="text-[11px] font-semibold tracking-[0.12em] text-[#9a948a] uppercase">
                      {labels.fieldOptions}
                    </p>
                    <p className="mt-1 text-[12px] leading-[1.6] text-[#9a948a]">{labels.fieldOptionsHint}</p>
                    <div className="mt-2 space-y-2">
                      {editableOptions(selectedNode.data.options).map((option, index, all) => (
                        // 选项为草稿行集合（可空 label、无稳定 id），key 用行号占位是
                        // 刻意选择：重排不发生（仅追加/删除尾行）。
                        // oxlint-disable-next-line react/no-array-index-key
                        <div key={index} className="flex items-center gap-2">
                          <input
                            value={option.label}
                            placeholder={labels.optionLabel}
                            onChange={(e) => {
                              const next = [...all];
                              next[index] = { ...option, label: e.target.value };
                              patchSelected({ options: next });
                            }}
                            className={FIELD_ROW_INPUT_CLASS}
                          />
                          <label
                            className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px] text-[#4a5260]"
                            title={labels.terminateHint}
                          >
                            <input
                              type="checkbox"
                              checked={option.terminate === true}
                              onChange={(e) => {
                                const next = [...all];
                                next[index] = { ...option, terminate: e.target.checked };
                                patchSelected({ options: next });
                              }}
                              className="h-3.5 w-3.5 accent-[#b42318]"
                            />
                            {labels.terminate}
                          </label>
                          <button
                            type="button"
                            onClick={() =>
                              patchSelected({
                                options: all.filter((_, i) => i !== index),
                              })
                            }
                            className="shrink-0 rounded-[6px] border border-[#f1b0b7] px-2 py-1 text-[12px] text-[#b42318] hover:bg-[#fff1f1]"
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
                        className="w-full rounded-[8px] border border-dashed border-[#d8d2c8] px-3 py-1.5 text-[12px] text-[#232f3e] hover:border-[#232f3e] hover:bg-[#faf9f7]"
                      >
                        + {labels.addOption}
                      </button>
                    </div>
                  </div>
                </>
              ) : null}
              <span className="flex-1" />
              <button
                type="button"
                onClick={deleteSelected}
                className="mt-4 rounded-[8px] border border-[#fcd7d7] bg-[#fff8f8] px-3 py-2 text-[13px] font-medium text-[#b42318] transition-colors hover:bg-[#fff1f1]"
              >
                {labels.deleteNode}
              </button>
            </div>
          ) : (
            <p className="px-1 py-6 text-[13px] leading-[1.8] text-[#9a948a]">{labels.selectNodeHint}</p>
          )}
        </aside>
      </div>
    </div>
  );
}
