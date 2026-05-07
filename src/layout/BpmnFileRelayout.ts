/**
 * BpmnFileRelayout
 *
 * Read a BPMN 2.0 XML file, extract its node/edge graph, run ELK layout,
 * and write back the BPMNDiagram (`bpmndi:BPMNDiagram`) section with
 * fresh coordinates. Logical content (definitions / process / tasks /
 * sequenceFlows / extensionElements) is preserved verbatim; only the
 * `bpmndi:BPMNShape` and `bpmndi:BPMNEdge` positions are recomputed.
 *
 * This lets us evaluate ELK's layout quality on existing BPMN files (the
 * TEP fixture in particular) without coupling layout to the import path
 * yet — the same ELK module will plug into the importer once branches
 * converge.
 *
 * Usage:
 *   await relayoutBpmnFile(bpmnXml) → string  (BPMN with new BPMNDiagram)
 */

import { layoutWithElk, type InputNode, type InputPort, type LayoutResult } from './ElkBpmnLayout';

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

interface ExtractedGraph {
  nodes: InputNode[];
  edges: { id: string; sources: string[]; targets: string[] }[];
  /** Map nodeId → BPMN local element kind, used for default sizing. */
  nodeKinds: Map<string, string>;
  /** Map nodeId → DEXPI port direction info (for matching dexpi:port to ELK ports). */
  nodePortDirections: Map<string, Map<string, InputPort['direction']>>;
}

/**
 * Walk the XML DOM building a hierarchical InputNode tree. SubProcesses
 * become parents whose `children` are their nested elements.
 */
function extractGraph(doc: Document): ExtractedGraph {
  const nodes: InputNode[] = [];
  const edges: { id: string; sources: string[]; targets: string[] }[] = [];
  const nodeKinds = new Map<string, string>();
  const nodePortDirections = new Map<string, Map<string, InputPort['direction']>>();

  // Find the bpmn:process element(s) — top-level container(s).
  const processes = Array.from(doc.getElementsByTagNameNS(NS.bpmn, 'process'));
  if (processes.length === 0) {
    // Fall back to localName scan if namespace-aware lookup misses.
    const all = Array.from(doc.getElementsByTagName('*')) as Element[];
    for (const el of all) {
      if (el.localName === 'process') processes.push(el);
    }
  }

  for (const proc of processes) {
    extractFromContainer(proc, nodes, edges, nodeKinds, nodePortDirections);
  }

  return { nodes, edges, nodeKinds, nodePortDirections };
}

/**
 * Recursively extract nodes + edges from a container element (process or subProcess).
 */
function extractFromContainer(
  container: Element,
  parentNodeChildren: InputNode[],
  edges: ExtractedGraph['edges'],
  nodeKinds: Map<string, string>,
  nodePortDirections: Map<string, Map<string, InputPort['direction']>>,
): void {
  for (const child of Array.from(container.children) as Element[]) {
    const kind = child.localName;
    const id = child.getAttribute('id');
    if (!id) continue;

    if (NODE_LOCAL_NAMES.has(kind)) {
      nodeKinds.set(id, kindToBpmnElementName(kind));
      const node: InputNode = { id, kind: kindToBpmnElementName(kind) };

      // Extract DEXPI ports if present.
      const ports = extractDexpiPorts(child, id);
      if (ports.length > 0) {
        node.ports = ports;
        const dirMap = new Map<string, InputPort['direction']>();
        for (const p of ports) dirMap.set(p.id, p.direction);
        nodePortDirections.set(id, dirMap);
      }

      // Recurse into subprocesses.
      if (kind === 'subProcess') {
        node.children = [];
        extractFromContainer(child, node.children, edges, nodeKinds, nodePortDirections);
      }

      parentNodeChildren.push(node);
    } else if (EDGE_LOCAL_NAMES.has(kind)) {
      // Sequence flow / association: source and target are by element id.
      const sourceRef = child.getAttribute('sourceRef');
      const targetRef = child.getAttribute('targetRef');
      if (sourceRef && targetRef) {
        edges.push({ id, sources: [sourceRef], targets: [targetRef] });
      } else {
        // dataInputAssociation / dataOutputAssociation use child <sourceRef>/<targetRef>.
        const sourceEls = Array.from(child.children).filter(c => c.localName === 'sourceRef');
        const targetEls = Array.from(child.children).filter(c => c.localName === 'targetRef');
        const sources = sourceEls.map(e => (e.textContent ?? '').trim()).filter(Boolean);
        const targets = targetEls.map(e => (e.textContent ?? '').trim()).filter(Boolean);
        if (sources.length && targets.length) {
          edges.push({ id, sources, targets });
        }
      }
    }
  }
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

// ── Writing back to BPMNDiagram ─────────────────────────────────────────

/**
 * Replace the bpmndi:BPMNDiagram in the document with one whose shapes
 * and edges reflect the laid-out coordinates.
 */
function writeBackDiagram(
  doc: Document,
  graph: ExtractedGraph,
  layout: LayoutResult,
): void {
  const definitions = doc.documentElement;

  // Remove existing BPMNDiagram(s).
  const existing = Array.from(definitions.getElementsByTagNameNS(NS.bpmndi, 'BPMNDiagram'));
  for (const d of existing) {
    if (d.parentNode === definitions) {
      definitions.removeChild(d);
    }
  }

  // Find the bpmn:process id (used as the BPMNPlane.bpmnElement attribute).
  const processes = Array.from(definitions.getElementsByTagNameNS(NS.bpmn, 'process'));
  const procId = processes[0]?.getAttribute('id') ?? 'Process_1';

  // Build the new BPMNDiagram tree.
  const diagram = doc.createElementNS(NS.bpmndi, 'bpmndi:BPMNDiagram');
  diagram.setAttribute('id', 'BPMNDiagram_relayout');

  const plane = doc.createElementNS(NS.bpmndi, 'bpmndi:BPMNPlane');
  plane.setAttribute('id', 'BPMNPlane_relayout');
  plane.setAttribute('bpmnElement', procId);
  diagram.appendChild(plane);

  // Add shapes for every node (recursive — subprocess children too).
  const addShapes = (nodes: typeof layout.nodes) => {
    for (const n of nodes) {
      const shape = doc.createElementNS(NS.bpmndi, 'bpmndi:BPMNShape');
      shape.setAttribute('id', `${n.id}_di`);
      shape.setAttribute('bpmnElement', n.id);
      // Subprocesses get isExpanded so children render visibly.
      if (n.children.length > 0) shape.setAttribute('isExpanded', 'true');

      const bounds = doc.createElementNS(NS.ns4_dc, 'dc:Bounds');
      bounds.setAttribute('x', String(Math.round(n.x)));
      bounds.setAttribute('y', String(Math.round(n.y)));
      bounds.setAttribute('width', String(Math.round(n.width)));
      bounds.setAttribute('height', String(Math.round(n.height)));
      shape.appendChild(bounds);

      plane.appendChild(shape);
      if (n.children.length > 0) addShapes(n.children);
    }
  };
  addShapes(layout.nodes);

  // Add edges with waypoints.
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

/**
 * End-to-end: parse BPMN → ELK layout → write back BPMNDiagram. Returns
 * the modified BPMN XML as a string. Idempotent: running twice on the
 * same input yields the same output (deterministic ELK seed by default).
 */
export async function relayoutBpmnFile(bpmnXml: string): Promise<string> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(bpmnXml, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('BPMN parse error');
  }

  const graph = extractGraph(doc);

  // Convert extracted-graph edges to InputEdge format expected by layoutWithElk.
  const layout = await layoutWithElk({
    nodes: graph.nodes,
    edges: graph.edges,
  });

  writeBackDiagram(doc, graph, layout);

  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}
