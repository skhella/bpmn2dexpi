/**
 * ELK-based BPMN layout engine.
 *
 * Replaces ad-hoc node placement / port positioning / subprocess sizing
 * with the Eclipse Layout Kernel (elkjs). Designed to address four pain
 * points observed in DEXPI→BPMN imports:
 *
 *   1. Node placement   — elk.layered packs nodes into layers without overlap
 *   2. Port positioning — elk respects fixed port sides + offsets when given
 *   3. Subprocess layout — hierarchical option lays out children inside their
 *                          parent and sizes the parent to fit
 *   4. Flow direction   — elk.direction='RIGHT' produces canonical L→R PFD-style
 *
 * Input: a BPMN moddle tree (the bpmn:definitions / bpmn:process subtree
 *        as exposed by bpmn-moddle) — same shape consumed by bpmn-js.
 *
 * Output: a parallel structure of nodes/edges/ports with `{ x, y, width,
 *         height }` for every shape and `[ {x, y}, ... ]` waypoints for
 *         every edge. The caller writes these back into bpmndi:BPMNDiagram.
 *
 * Why ELK rather than bpmn-js's built-in auto-layout: bpmn-js handles only
 * basic linear flows; it does not address subprocess nesting, port-aware
 * routing, or DEXPI's left-to-right PFD convention. ELK's `layered`
 * algorithm is the de facto standard for this layout class.
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge, ElkPort, LayoutOptions } from 'elkjs/lib/elk-api';

/** Re-export the ElkNode shape so callers can build inputs without importing elkjs. */
export type { ElkNode, ElkExtendedEdge, ElkPort } from 'elkjs/lib/elk-api';

/**
 * Layout option presets. Defaults aim at DEXPI block-flow / process-flow
 * diagrams: left-to-right, layered, with generous spacing for clarity.
 */
export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  // The layered algorithm is the right choice for directed flow diagrams.
  'elk.algorithm': 'layered',
  // Left-to-right matches PFD/BFD reading convention.
  'elk.direction': 'RIGHT',
  // Spacing — adjusted up vs ELK defaults so labels and ports don't collide.
  'elk.spacing.nodeNode': '60',
  'elk.layered.spacing.nodeNodeBetweenLayers': '100',
  'elk.spacing.edgeNode': '30',
  'elk.spacing.edgeEdge': '20',
  'elk.padding': '[top=30,left=30,right=30,bottom=30]',
  // Port side constraints: respect fixed sides we've placed (Inlet=WEST,
  // Outlet=EAST) but allow ELK to pick the offset along the side.
  'elk.portConstraints': 'FIXED_SIDE',
  // Edge routing: orthogonal lines look like piping, with avoidance.
  'elk.edgeRouting': 'ORTHOGONAL',
  // Hierarchy: lay out subprocesses inside their parents and size the
  // parent to fit. Without this, subprocess content overflows.
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  // Crossing minimization — denser PFDs benefit from this.
  'elk.layered.crossingMinimization.semiInteractive': 'true',
};

/**
 * Result of running ELK on a node tree.
 *
 * The shape mirrors ELK's own output, with positions resolved to absolute
 * coordinates (no per-parent relative offsets). Callers writing back to
 * bpmndi:BPMNDiagram need absolute coordinates per BPMN DI semantics.
 */
export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Absolute port positions on this node's perimeter. */
  ports: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  /** Recursive: laid-out children for subprocess nesting. */
  children: LaidOutNode[];
}

export interface LaidOutEdge {
  id: string;
  /** Absolute waypoints along the edge. First point is at source, last at target. */
  waypoints: Array<{ x: number; y: number }>;
}

export interface LayoutResult {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  /** Total bounding box of the layout — useful for sizing the canvas. */
  bounds: { width: number; height: number };
}

/**
 * Input shape — kept flat per ELK's expected JSON. The caller is
 * responsible for hierarchically nesting subprocess children inside their
 * parent's `children` field.
 *
 * Default sizing is provided when width/height aren't specified, so callers
 * can let ELK decide based on label length or just use these defaults.
 */
export interface LayoutInput {
  /** Top-level container nodes (e.g., bpmn:Process / Pool). */
  nodes: InputNode[];
  /** Edges with absolute (cross-hierarchy) source/target ids. */
  edges: InputEdge[];
  /** Optional layout option overrides; merged on top of DEFAULT_LAYOUT_OPTIONS. */
  options?: LayoutOptions;
}

export interface InputNode {
  id: string;
  width?: number;
  height?: number;
  /**
   * Children for nested layout (e.g. subprocess content laid out within).
   * When set, ELK lays children out inside this node and sizes the node
   * to fit them, respecting `elk.padding`.
   */
  children?: InputNode[];
  /**
   * Ports owned by this node. Position is resolved by ELK; we only state
   * the side constraint. See `direction`.
   */
  ports?: InputPort[];
  /** BPMN-tagged element kind (Task, SubProcess, StartEvent, EndEvent, DataObject, etc.). */
  kind?: string;
  /** Optional layout-option overrides applied to just this node. */
  options?: LayoutOptions;
}

export interface InputPort {
  id: string;
  /** Inlet → WEST side (left-incoming for L→R flow); Outlet → EAST. */
  direction: 'Inlet' | 'Outlet' | 'Top' | 'Bottom';
  /** Optional port size. Defaults to 8×8 (small visible square). */
  width?: number;
  height?: number;
}

export interface InputEdge {
  id: string;
  /** Source node id — or port id if the edge originates at a specific port. */
  sources: string[];
  /** Target node id — or port id if the edge terminates at a specific port. */
  targets: string[];
}

const DEFAULT_NODE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  Task:                { width: 100, height: 80 },
  SubProcess:          { width: 200, height: 120 },
  StartEvent:          { width: 36, height: 36 },
  EndEvent:            { width: 36, height: 36 },
  IntermediateEvent:   { width: 36, height: 36 },
  DataObjectReference: { width: 36, height: 50 },
  DataObject:          { width: 36, height: 50 },
};

const DEFAULT_NODE_DIMENSIONS_FALLBACK = { width: 100, height: 80 };

function dimensionsFor(kind?: string): { width: number; height: number } {
  if (!kind) return DEFAULT_NODE_DIMENSIONS_FALLBACK;
  return DEFAULT_NODE_DIMENSIONS[kind] ?? DEFAULT_NODE_DIMENSIONS_FALLBACK;
}

function directionToSide(d: InputPort['direction']): string {
  switch (d) {
    case 'Inlet':  return 'WEST';
    case 'Outlet': return 'EAST';
    case 'Top':    return 'NORTH';
    case 'Bottom': return 'SOUTH';
  }
}

/**
 * Build an ElkNode tree from our flat InputNode shape, applying defaults.
 */
function buildElkNode(node: InputNode): ElkNode {
  const dims = node.width != null && node.height != null
    ? { width: node.width, height: node.height }
    : dimensionsFor(node.kind);

  const elkNode: ElkNode = {
    id: node.id,
    width: dims.width,
    height: dims.height,
  };

  if (node.options) elkNode.layoutOptions = { ...node.options };

  if (node.ports?.length) {
    elkNode.ports = node.ports.map((p): ElkPort => ({
      id: p.id,
      width: p.width ?? 8,
      height: p.height ?? 8,
      layoutOptions: { 'elk.port.side': directionToSide(p.direction) },
    }));
  }

  if (node.children?.length) {
    elkNode.children = node.children.map(buildElkNode);
  }

  return elkNode;
}

/**
 * Recursively walk an ELK output, accumulating absolute coordinates for
 * each node, port and edge. ELK gives positions relative to the parent;
 * BPMN DI wants absolute, so we resolve on the way down.
 */
function flattenElkOutput(
  node: ElkNode,
  parentX: number,
  parentY: number,
): LaidOutNode {
  const absX = parentX + (node.x ?? 0);
  const absY = parentY + (node.y ?? 0);
  return {
    id: node.id,
    x: absX,
    y: absY,
    width: node.width ?? 0,
    height: node.height ?? 0,
    ports: (node.ports ?? []).map((p): LaidOutNode['ports'][0] => ({
      id: p.id,
      // ELK gives port positions relative to their owning node.
      x: absX + (p.x ?? 0),
      y: absY + (p.y ?? 0),
      width: p.width ?? 0,
      height: p.height ?? 0,
    })),
    children: (node.children ?? []).map(c => flattenElkOutput(c, absX, absY)),
  };
}

function flattenElkEdges(node: ElkNode, parentX: number, parentY: number): LaidOutEdge[] {
  const out: LaidOutEdge[] = [];
  const absX = parentX + (node.x ?? 0);
  const absY = parentY + (node.y ?? 0);
  for (const edge of (node.edges ?? []) as ElkExtendedEdge[]) {
    // ELK gives waypoints relative to the EDGE's container (which is the
    // node we're currently in). Resolve to absolute.
    const waypoints: LaidOutEdge['waypoints'] = [];
    if (edge.sections?.length) {
      for (const section of edge.sections) {
        waypoints.push({ x: section.startPoint.x + absX, y: section.startPoint.y + absY });
        for (const bp of (section.bendPoints ?? [])) {
          waypoints.push({ x: bp.x + absX, y: bp.y + absY });
        }
        waypoints.push({ x: section.endPoint.x + absX, y: section.endPoint.y + absY });
      }
    }
    out.push({ id: edge.id, waypoints });
  }
  for (const child of (node.children ?? [])) {
    out.push(...flattenElkEdges(child, absX, absY));
  }
  return out;
}

function bounds(nodes: LaidOutNode[]): { width: number; height: number } {
  let maxX = 0;
  let maxY = 0;
  const visit = (n: LaidOutNode) => {
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
    n.children.forEach(visit);
  };
  nodes.forEach(visit);
  return { width: maxX, height: maxY };
}

/**
 * Run ELK layered layout on the given graph and return absolute positions.
 *
 * Async because elkjs runs in a Web Worker (browser) or via an inlined
 * worker (Node). For our use case the latency is negligible (~50-200ms
 * for the TEP fixture).
 */
export async function layoutWithElk(input: LayoutInput): Promise<LayoutResult> {
  const elk = new ELK();

  const root: ElkNode = {
    id: '__elk_root__',
    layoutOptions: { ...DEFAULT_LAYOUT_OPTIONS, ...(input.options ?? {}) },
    children: input.nodes.map(buildElkNode),
    edges: input.edges.map((e): ElkExtendedEdge => ({
      id: e.id,
      sources: e.sources,
      targets: e.targets,
    })),
  };

  const out = await elk.layout(root);

  const nodes = (out.children ?? []).map(c => flattenElkOutput(c, 0, 0));
  const edges = flattenElkEdges(out, 0, 0);
  return {
    nodes,
    edges,
    bounds: bounds(nodes),
  };
}
