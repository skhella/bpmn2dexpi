/**
 * BpmnFileRelayout
 *
 * Read a BPMN 2.0 XML file, run ELK layout, and write back the
 * `bpmndi:BPMNDiagram` section(s) with fresh coordinates. Logical content
 * (definitions / process / tasks / sequenceFlows / extensionElements) is
 * preserved verbatim; only the `bpmndi:BPMNShape` / `bpmndi:BPMNEdge`
 * positions are recomputed.
 *
 * Hierarchy handling: each container (the root process and every
 * `bpmn:subProcess`) is laid out as its OWN plane. A subprocess therefore
 * appears twice in the DI:
 *   - on its parent plane as a single COLLAPSED box (`isExpanded="false"`),
 *     sized like a task — never expanded inline; and
 *   - as its own `bpmndi:BPMNPlane` (bpmnElement = subprocess id) holding
 *     its children, reachable by drilling in.
 * This is the default authoring convention for imported DEXPI: subprocesses
 * start collapsed so the top-level PFD stays readable, and the user expands
 * them on demand. (The previous single-plane relayout force-expanded every
 * subprocess, which is the behaviour this module deliberately replaces.)
 *
 * Usage:
 *   await relayoutBpmnFile(bpmnXml) → string  (BPMN with new BPMNDiagram(s))
 */

import { layoutWithElk, type InputNode, type InputEdge, type InputPort, type LayoutResult } from './ElkBpmnLayout';

const NS = {
  bpmn:    'http://www.omg.org/spec/BPMN/20100524/MODEL',
  bpmndi:  'http://www.omg.org/spec/BPMN/20100524/DI',
  ns4_dc:  'http://www.omg.org/spec/DD/20100524/DC',
  ns5_di:  'http://www.omg.org/spec/DD/20100524/DI',
  dexpi:   'http://dexpi.org/schema/bpmn-extension',
};

/**
 * BPMN element kinds we recognise as nodes (shapes) for layout.
 * Edges (sequenceFlow / association / dataInputAssociation /
 * dataOutputAssociation) are handled separately.
 */
const NODE_LOCAL_NAMES = new Set([
  'task', 'subProcess', 'startEvent', 'endEvent',
  'intermediateThrowEvent', 'intermediateCatchEvent',
  'dataObjectReference',
  'serviceTask', 'userTask', 'manualTask', 'businessRuleTask',
  'sendTask', 'receiveTask', 'scriptTask', 'callActivity',
]);

const EDGE_LOCAL_NAMES = new Set([
  'sequenceFlow', 'association', 'dataInputAssociation', 'dataOutputAssociation',
]);

/**
 * Size of a collapsed subprocess box on its parent plane. A collapsed
 * subprocess renders as a task-sized box with a [+] marker; its real
 * content lives on its own plane.
 */
const COLLAPSED_SUBPROCESS = { width: 100, height: 80 };

/**
 * One container's worth of layout input: the root process or a subProcess.
 * `containerId` becomes the BPMNPlane's `bpmnElement`.
 */
interface PlaneSpec {
  containerId: string;
  /** Whether this container is the root bpmn:process (always gets a plane). */
  isProcess: boolean;
  /** Direct-child nodes; subprocesses appear here as collapsed, fixed-size leaves. */
  nodes: InputNode[];
  /** Edges whose endpoints are both direct children of this container. */
  edges: InputEdge[];
  /** Ids of direct-child subprocesses that have content (need isExpanded="false"). */
  collapsedSubprocessIds: Set<string>;
}

/**
 * Map BPMN local-name to the kind key used by DEFAULT_NODE_DIMENSIONS.
 */
function kindToBpmnElementName(localName: string): string {
  if (localName === 'subProcess') return 'SubProcess';
  if (localName === 'startEvent') return 'StartEvent';
  if (localName === 'endEvent') return 'EndEvent';
  if (localName === 'intermediateThrowEvent' || localName === 'intermediateCatchEvent') return 'IntermediateEvent';
  if (localName === 'dataObjectReference') return 'DataObjectReference';
  // All Task kinds (task, serviceTask, userTask, ...) map to Task for sizing.
  return 'Task';
}

/**
 * Extract dexpi:port children (if any) and convert to ELK input ports.
 * Inlets become WEST (left-incoming); Outlets become EAST.
 */
function extractDexpiPorts(stepEl: Element, stepId: string): InputPort[] {
  const ports: InputPort[] = [];
  // Look inside extensionElements for a dexpi:element with dexpi:port children.
  for (const ext of Array.from(stepEl.children).filter(c => c.localName === 'extensionElements')) {
    for (const dexpiEl of Array.from(ext.children).filter(c =>
      c.localName === 'element' && c.namespaceURI?.includes('dexpi.org')
    )) {
      for (const portEl of Array.from(dexpiEl.children).filter(c => c.localName === 'port')) {
        const portId = portEl.getAttribute('id') ?? `${stepId}_${portEl.getAttribute('name') ?? 'port'}`;
        const directionAttr = portEl.getAttribute('direction') ?? 'Inlet';
        const direction = (directionAttr === 'Outlet' ? 'Outlet' : 'Inlet') as InputPort['direction'];
        ports.push({ id: portId, direction });
      }
    }
  }
  return ports;
}

/** True if the container has at least one direct-child node element. */
function hasNodeChildren(container: Element): boolean {
  return Array.from(container.children).some(c => NODE_LOCAL_NAMES.has(c.localName));
}

/**
 * Build the InputNode for a direct-child element. Subprocesses become
 * fixed-size collapsed leaves (their content is laid out on their own plane,
 * not nested inside this box).
 */
function buildNode(child: Element, id: string): InputNode {
  const node: InputNode = { id, kind: kindToBpmnElementName(child.localName) };

  const ports = extractDexpiPorts(child, id);
  if (ports.length > 0) node.ports = ports;

  if (child.localName === 'subProcess') {
    node.width = COLLAPSED_SUBPROCESS.width;
    node.height = COLLAPSED_SUBPROCESS.height;
  }
  return node;
}

/**
 * Build a PlaneSpec from a container element (process or subProcess) by
 * scanning its DIRECT children only — nested subprocess content belongs to
 * that subprocess's own plane, not this one.
 */
function buildPlaneSpec(container: Element): PlaneSpec {
  const containerId = container.getAttribute('id') ?? 'Process_1';
  const isProcess = container.localName === 'process';
  const nodes: InputNode[] = [];
  const rawEdges: InputEdge[] = [];
  const collapsedSubprocessIds = new Set<string>();
  const nodeIds = new Set<string>();

  for (const child of Array.from(container.children) as Element[]) {
    const kind = child.localName;
    const id = child.getAttribute('id');
    if (!id) continue;

    if (NODE_LOCAL_NAMES.has(kind)) {
      nodes.push(buildNode(child, id));
      nodeIds.add(id);
      if (kind === 'subProcess' && hasNodeChildren(child)) collapsedSubprocessIds.add(id);
    } else if (EDGE_LOCAL_NAMES.has(kind)) {
      const sourceRef = child.getAttribute('sourceRef');
      const targetRef = child.getAttribute('targetRef');
      if (sourceRef && targetRef) {
        rawEdges.push({ id, sources: [sourceRef], targets: [targetRef] });
      } else {
        // dataInputAssociation / dataOutputAssociation use child <sourceRef>/<targetRef>.
        const sources = Array.from(child.children)
          .filter(c => c.localName === 'sourceRef')
          .map(e => (e.textContent ?? '').trim()).filter(Boolean);
        const targets = Array.from(child.children)
          .filter(c => c.localName === 'targetRef')
          .map(e => (e.textContent ?? '').trim()).filter(Boolean);
        if (sources.length && targets.length) rawEdges.push({ id, sources, targets });
      }
    }
  }

  // Keep only edges that stay within this plane — both endpoints must be
  // direct-child nodes here. Cross-plane refs would make ELK throw.
  const edges = rawEdges.filter(e =>
    e.sources.every(s => nodeIds.has(s)) && e.targets.every(t => nodeIds.has(t)),
  );

  return { containerId, isProcess, nodes, edges, collapsedSubprocessIds };
}

/**
 * Collect the root process(es) and every nested subProcess as containers,
 * each of which becomes its own plane.
 */
function collectContainers(doc: Document): Element[] {
  let processes = Array.from(doc.getElementsByTagNameNS(NS.bpmn, 'process'));
  if (processes.length === 0) {
    // Fall back to localName scan if namespace-aware lookup misses.
    processes = (Array.from(doc.getElementsByTagName('*')) as Element[])
      .filter(el => el.localName === 'process');
  }

  const containers: Element[] = [];
  const addContainer = (el: Element) => {
    containers.push(el);
    for (const child of Array.from(el.children) as Element[]) {
      if (child.localName === 'subProcess') addContainer(child);
    }
  };
  for (const proc of processes) addContainer(proc);
  return containers;
}

// ── Writing back to BPMNDiagram ─────────────────────────────────────────

/**
 * Replace every bpmndi:BPMNDiagram in the document with one diagram per
 * plane (root process + each subprocess), reflecting the laid-out
 * coordinates. Subprocesses are emitted COLLAPSED on their parent plane.
 */
function writePlanes(
  doc: Document,
  results: Array<{ spec: PlaneSpec; layout: LayoutResult }>,
): void {
  const definitions = doc.documentElement;

  // Remove existing BPMNDiagram(s).
  for (const d of Array.from(definitions.getElementsByTagNameNS(NS.bpmndi, 'BPMNDiagram'))) {
    if (d.parentNode === definitions) definitions.removeChild(d);
  }

  for (const { spec, layout } of results) {
    const diagram = doc.createElementNS(NS.bpmndi, 'bpmndi:BPMNDiagram');
    diagram.setAttribute('id', `BPMNDiagram_${spec.containerId}`);

    const plane = doc.createElementNS(NS.bpmndi, 'bpmndi:BPMNPlane');
    plane.setAttribute('id', `BPMNPlane_${spec.containerId}`);
    plane.setAttribute('bpmnElement', spec.containerId);
    diagram.appendChild(plane);

    // Shapes — flat per plane (subprocess children live on their own plane).
    for (const n of layout.nodes) {
      const shape = doc.createElementNS(NS.bpmndi, 'bpmndi:BPMNShape');
      shape.setAttribute('id', `${n.id}_di`);
      shape.setAttribute('bpmnElement', n.id);
      // Collapsed subprocess: render the [+] box, not its content inline.
      if (spec.collapsedSubprocessIds.has(n.id)) shape.setAttribute('isExpanded', 'false');

      const bounds = doc.createElementNS(NS.ns4_dc, 'dc:Bounds');
      bounds.setAttribute('x', String(Math.round(n.x)));
      bounds.setAttribute('y', String(Math.round(n.y)));
      bounds.setAttribute('width', String(Math.round(n.width)));
      bounds.setAttribute('height', String(Math.round(n.height)));
      shape.appendChild(bounds);

      plane.appendChild(shape);
    }

    // Edges with waypoints.
    for (const e of layout.edges) {
      const edge = doc.createElementNS(NS.bpmndi, 'bpmndi:BPMNEdge');
      edge.setAttribute('id', `${e.id}_di`);
      edge.setAttribute('bpmnElement', e.id);
      for (const wp of e.waypoints) {
        const waypoint = doc.createElementNS(NS.ns5_di, 'di:waypoint');
        waypoint.setAttribute('x', String(Math.round(wp.x)));
        waypoint.setAttribute('y', String(Math.round(wp.y)));
        edge.appendChild(waypoint);
      }
      plane.appendChild(edge);
    }

    definitions.appendChild(diagram);
  }
}

/**
 * End-to-end: parse BPMN → ELK layout (one pass per plane) → write back the
 * BPMNDiagram(s). Returns the modified BPMN XML as a string. Deterministic:
 * running twice on the same input yields the same output.
 */
export async function relayoutBpmnFile(bpmnXml: string): Promise<string> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(bpmnXml, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('BPMN parse error');
  }

  // One plane per container: always the root process, plus any subprocess
  // that actually has content (an empty subprocess needs no drill-in plane).
  const specs = collectContainers(doc)
    .map(buildPlaneSpec)
    .filter(spec => spec.isProcess || spec.nodes.length > 0);

  const results: Array<{ spec: PlaneSpec; layout: LayoutResult }> = [];
  for (const spec of specs) {
    const layout = await layoutWithElk({ nodes: spec.nodes, edges: spec.edges });
    results.push({ spec, layout });
  }

  writePlanes(doc, results);

  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}
