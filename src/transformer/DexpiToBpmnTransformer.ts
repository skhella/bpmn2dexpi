/**
 * DexpiToBpmnTransformer
 *
 * Reverse transformer: DEXPI 2.0 XML → BPMN 2.0 XML with DEXPI extensionElements.
 *
 * Mapping (inverse of BpmnToDexpiTransformer):
 *   Process/Process.Source            → bpmn:StartEvent
 *   Process/Process.Sink              → bpmn:EndEvent
 *   Process/Process.*  (other steps)  → bpmn:Task
 *   Process/Process.Stream            → bpmn:SequenceFlow (MaterialFlow)
 *   Process/Process.*EnergyFlow       → bpmn:SequenceFlow (energy subtype)
 *   Process/Process.InformationFlow   → bpmn:Association + DataObjectReference
 *   Process/Process.MaterialTemplate  → bpmn:DataObjectReference
 *
 * Layout: layered left-to-right topology using BFS from Source nodes.
 */

interface DexpiStep {
  id: string;
  dexpiType: string;      // e.g. "Pumping", "Source", "Sink"
  identifier: string;
  label: string;
  ports: DexpiPort[];
  referenceUri?: string;
}

interface DexpiPort {
  id: string;
  portType: string;       // MaterialPort, ThermalEnergyPort, etc.
  direction: string;      // In / Out
  label: string;
  identifier: string;
}

interface DexpiConnection {
  id: string;
  dexpiType: string;      // Stream, ThermalEnergyFlow, InformationFlow, etc.
  identifier: string;
  label: string;
  sourcePortId: string;
  targetPortId: string;
  informationVariantLabel?: string;
}

interface DexpiMaterialTemplate {
  id: string;
  identifier: string;
  label: string;
}

interface ParsedDexpi {
  steps: DexpiStep[];
  connections: DexpiConnection[];
  materialTemplates: DexpiMaterialTemplate[];
}

// Layout constants
const TASK_W = 100;
const TASK_H = 80;
const EVENT_D = 36;      // diameter
const H_GAP = 80;        // horizontal gap between elements
const V_GAP = 60;        // vertical gap between elements
const MARGIN_X = 100;
const MARGIN_Y = 100;

export class DexpiToBpmnTransformer {

  // ── Public API ─────────────────────────────────────────────────────────────

  transform(dexpiXml: string): string {
    const parsed = this.parseDexpi(dexpiXml);
    const layout = this.computeLayout(parsed);
    return this.buildBpmn(parsed, layout);
  }

  // ── Parser ──────────────────────────────────────────────────────────────────

  private parseDexpi(xml: string): ParsedDexpi {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');

    // Find ProcessModel — may be nested under EngineeringModel/ConceptualModel
    const processModel = this.findProcessModel(doc);
    if (!processModel) throw new Error('No ProcessModel found in DEXPI XML');

    // Build port → step ID index (needed to resolve connection Source/Target)
    const portToStep = new Map<string, string>();

    // Parse steps
    const steps: DexpiStep[] = [];
    const stepsContainer = this.findComponents(processModel, 'ProcessSteps');
    if (stepsContainer) {
      Array.from(stepsContainer.children)
        .filter(el => el.tagName === 'Object')
        .forEach(obj => {
          const step = this.parseStep(obj);
          steps.push(step);
          step.ports.forEach(p => portToStep.set(p.id, step.id));
        });
    }

    // Parse connections
    const connections: DexpiConnection[] = [];
    const connContainer = this.findComponents(processModel, 'ProcessConnections');
    if (connContainer) {
      Array.from(connContainer.children)
        .filter(el => el.tagName === 'Object')
        .forEach(obj => {
          const conn = this.parseConnection(obj);
          if (conn) connections.push(conn);
        });
    }

    // Parse MaterialTemplates
    const materialTemplates: DexpiMaterialTemplate[] = [];
    const tmplContainer = this.findComponents(processModel, 'MaterialTemplates');
    if (tmplContainer) {
      Array.from(tmplContainer.children)
        .filter(el => el.tagName === 'Object')
        .forEach(obj => {
          const id = obj.getAttribute('id') || this.uid();
          const identifier = this.getDataString(obj, 'Identifier') || id;
          const label = this.getDataString(obj, 'Label') || identifier;
          materialTemplates.push({ id, identifier, label });
        });
    }

    return { steps, connections, materialTemplates };
  }

  private findProcessModel(doc: Document): Element | null {
    // Try direct: Object[type="Process/ProcessModel"]
    const direct = Array.from(doc.querySelectorAll('Object')).find(
      el => el.getAttribute('type') === 'Process/ProcessModel'
    );
    return direct || null;
  }

  private findComponents(parent: Element, property: string): Element | null {
    return Array.from(parent.children)
      .find(el =>
        el.tagName === 'Components' &&
        el.getAttribute('property') === property
      ) || null;
  }

  private parseStep(obj: Element): DexpiStep {
    const id = obj.getAttribute('id') || this.uid();
    const fullType = obj.getAttribute('type') || 'Process/Process.ProcessStep';
    const dexpiType = fullType.replace('Process/Process.', '');
    const identifier = this.getDataString(obj, 'Identifier') || id;
    const label = this.getDataString(obj, 'Label') || dexpiType;

    const ports: DexpiPort[] = [];
    const portsContainer = this.findComponents(obj, 'Ports');
    if (portsContainer) {
      Array.from(portsContainer.children)
        .filter(el => el.tagName === 'Object')
        .forEach(portObj => {
          const portId = portObj.getAttribute('id') || this.uid();
          const portFullType = portObj.getAttribute('type') || 'Process/Process.MaterialPort';
          const portType = portFullType.replace('Process/Process.', '');
          const portLabel = this.getDataString(portObj, 'Label') || portId;
          const portIdentifier = this.getDataString(portObj, 'Identifier') || portId;

          // Direction: In → Inlet, Out → Outlet
          const dirRef = portObj.querySelector('Data[property="NominalDirection"] DataReference');
          const dirData = dirRef?.getAttribute('data') || '';
          const direction = dirData.includes('.Out') ? 'Outlet' : 'Inlet';

          ports.push({ id: portId, portType, direction, label: portLabel, identifier: portIdentifier });
        });
    }

    return { id, dexpiType, identifier, label, ports };
  }

  private parseConnection(obj: Element): DexpiConnection | null {
    const id = obj.getAttribute('id') || this.uid();
    const fullType = obj.getAttribute('type') || '';
    const dexpiType = fullType.replace('Process/Process.', '');
    const identifier = this.getDataString(obj, 'Identifier') || id;
    const label = this.getDataString(obj, 'Label') || identifier;

    // Resolve Source and Target port references
    const sourceRef = obj.querySelector('References[property="Source"]')?.getAttribute('objects') || '';
    const targetRef = obj.querySelector('References[property="Target"]')?.getAttribute('objects') || '';
    const sourcePortId = sourceRef.replace('#', '');
    const targetPortId = targetRef.replace('#', '');

    if (!sourcePortId || !targetPortId) return null;

    // InformationVariant label (for InformationFlow)
    const infoVariantLabel = this.getDataString(
      obj.querySelector('Components[property="InformationValue"] Object') as Element,
      'Label'
    ) || undefined;

    return {
      id, dexpiType, identifier, label,
      sourcePortId, targetPortId,
      informationVariantLabel: infoVariantLabel,
    };
  }

  private getDataString(parent: Element | null, property: string): string {
    if (!parent) return '';
    const dataEl = parent.querySelector(`Data[property="${property}"] String`);
    return dataEl?.textContent?.trim() || '';
  }

  // ── Layout engine ───────────────────────────────────────────────────────────

  private computeLayout(parsed: ParsedDexpi): Map<string, {x: number, y: number, w: number, h: number}> {
    const { steps, connections } = parsed;

    // Build adjacency: stepId → downstream stepIds (via connections through ports)
    // Build port→step map
    const portToStep = new Map<string, string>();
    steps.forEach(s => s.ports.forEach(p => portToStep.set(p.id, s.id)));

    const downstream = new Map<string, Set<string>>();
    const upstream = new Map<string, Set<string>>();
    steps.forEach(s => { downstream.set(s.id, new Set()); upstream.set(s.id, new Set()); });

    connections.forEach(conn => {
      // Skip InformationFlow for layout purposes (non-sequential)
      if (conn.dexpiType === 'InformationFlow') return;
      const src = portToStep.get(conn.sourcePortId);
      const tgt = portToStep.get(conn.targetPortId);
      if (src && tgt && src !== tgt) {
        downstream.get(src)?.add(tgt);
        upstream.get(tgt)?.add(src);
      }
    });

    // BFS from Source nodes to assign layers
    const layer = new Map<string, number>();
    const sourceIds = steps.filter(s => s.dexpiType === 'Source').map(s => s.id);

    // If no explicit Source, use nodes with no upstream
    const roots = sourceIds.length > 0
      ? sourceIds
      : steps.filter(s => (upstream.get(s.id)?.size ?? 0) === 0).map(s => s.id);

    const queue = [...roots];
    roots.forEach(id => layer.set(id, 0));

    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curLayer = layer.get(cur) ?? 0;
      downstream.get(cur)?.forEach(next => {
        const existing = layer.get(next) ?? -1;
        if (existing < curLayer + 1) {
          layer.set(next, curLayer + 1);
          queue.push(next);
        }
      });
    }

    // Assign Sink nodes to last layer + 1
    const maxLayer = Math.max(0, ...Array.from(layer.values()));
    steps.forEach(s => {
      if (!layer.has(s.id)) {
        layer.set(s.id, s.dexpiType === 'Sink' ? maxLayer + 1 : maxLayer);
      }
      if (s.dexpiType === 'Sink') {
        layer.set(s.id, Math.max(layer.get(s.id) ?? 0, maxLayer + 1));
      }
    });

    // Group steps by layer
    const byLayer = new Map<number, string[]>();
    steps.forEach(s => {
      const l = layer.get(s.id) ?? 0;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(s.id);
    });

    // Assign x/y coordinates
    const layout = new Map<string, {x: number, y: number, w: number, h: number}>();
    const stepById = new Map(steps.map(s => [s.id, s]));

    const sortedLayers = Array.from(byLayer.keys()).sort((a, b) => a - b);
    let x = MARGIN_X;

    sortedLayers.forEach(layerIdx => {
      const ids = byLayer.get(layerIdx)!;
      // Sort: Sources first, Sinks last, others by id for determinism
      ids.sort((a, b) => {
        const ta = stepById.get(a)?.dexpiType || '';
        const tb = stepById.get(b)?.dexpiType || '';
        if (ta === 'Source') return -1;
        if (tb === 'Source') return 1;
        if (ta === 'Sink') return 1;
        if (tb === 'Sink') return -1;
        return a.localeCompare(b);
      });

      let y = MARGIN_Y;
      let maxW = 0;

      ids.forEach(id => {
        const step = stepById.get(id)!;
        const isEvent = step.dexpiType === 'Source' || step.dexpiType === 'Sink';
        const w = isEvent ? EVENT_D : TASK_W;
        const h = isEvent ? EVENT_D : TASK_H;
        // Center events vertically relative to tasks
        const yOffset = isEvent ? (TASK_H - EVENT_D) / 2 : 0;
        layout.set(id, { x, y: y + yOffset, w, h });
        y += h + V_GAP;
        maxW = Math.max(maxW, w);
      });

      x += maxW + H_GAP;
    });

    // Place MaterialTemplates as Data Objects below the diagram
    let dtX = MARGIN_X;
    const dtY = MARGIN_Y + (Math.max(1, ...Array.from(byLayer.values()).map(ids => ids.length)) * (TASK_H + V_GAP)) + 80;
    parsed.materialTemplates.forEach(tmpl => {
      layout.set(`dt_${tmpl.id}`, { x: dtX, y: dtY, w: 36, h: 50 });
      dtX += 120;
    });

    return layout;
  }

  // ── BPMN builder ────────────────────────────────────────────────────────────

  private buildBpmn(parsed: ParsedDexpi, layout: Map<string, {x: number, y: number, w: number, h: number}>): string {
    const { steps, connections, materialTemplates } = parsed;

    // Build port → step map for resolving connection endpoints
    const portToStep = new Map<string, string>();
    steps.forEach(s => s.ports.forEach(p => portToStep.set(p.id, s.id)));

    const processId = 'Process_imported';
    const defId = 'Definitions_imported';
    const planeId = 'BPMNPlane_imported';

    // Classify connections
    const seqFlows = connections.filter(c => c.dexpiType !== 'InformationFlow');
    const infoFlows = connections.filter(c => c.dexpiType === 'InformationFlow');

    // Build incoming/outgoing maps for steps
    const incoming = new Map<string, string[]>();
    const outgoing = new Map<string, string[]>();
    steps.forEach(s => { incoming.set(s.id, []); outgoing.set(s.id, []); });

    seqFlows.forEach(conn => {
      const src = portToStep.get(conn.sourcePortId);
      const tgt = portToStep.get(conn.targetPortId);
      if (src) outgoing.get(src)?.push(conn.id);
      if (tgt) incoming.get(tgt)?.push(conn.id);
    });

    // Generate unique IDs for BPMN elements
    const bpmnId = (base: string) => `bpmn_${base.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    // ── Process elements ────────────────────────────────────────────────────
    const processElements: string[] = [];
    const shapeElements: string[] = [];
    const edgeElements: string[] = [];

    steps.forEach(step => {
      const pos = layout.get(step.id);
      if (!pos) return;

      const elId = bpmnId(step.id);
      const name = step.label !== step.dexpiType ? step.label : step.dexpiType;

      // Extension elements
      const portsXml = step.ports.map(p => {
        const bpmnDir = p.direction === 'Outlet' ? 'Outlet' : 'Inlet';
        return `        <dexpi:port portId="${p.id}" name="${p.label}" portType="${p.portType}" direction="${bpmnDir}" label="${p.label}"/>`;
      }).join('\n');

      const extEl = `    <bpmn:extensionElements>
      <dexpi:element dexpiType="${step.dexpiType}" identifier="${step.identifier}" uid="${step.id}"${portsXml ? '\n' + portsXml + '\n    ' : ''}>
      </dexpi:element>
    </bpmn:extensionElements>`;

      const inc = incoming.get(step.id)?.map(id => `    <bpmn:incoming>${bpmnId(id)}</bpmn:incoming>`).join('\n') || '';
      const out = outgoing.get(step.id)?.map(id => `    <bpmn:outgoing>${bpmnId(id)}</bpmn:outgoing>`).join('\n') || '';

      if (step.dexpiType === 'Source') {
        processElements.push(`  <bpmn:startEvent id="${elId}" name="${name}">
${extEl}
${out}
  </bpmn:startEvent>`);
      } else if (step.dexpiType === 'Sink') {
        processElements.push(`  <bpmn:endEvent id="${elId}" name="${name}">
${extEl}
${inc}
  </bpmn:endEvent>`);
      } else {
        processElements.push(`  <bpmn:task id="${elId}" name="${name}">
${extEl}
${inc}
${out}
  </bpmn:task>`);
      }

      // BPMN shape
      shapeElements.push(`      <bpmndi:BPMNShape id="${elId}_di" bpmnElement="${elId}"${step.dexpiType === 'Source' || step.dexpiType === 'Sink' ? ' isHorizontal="false"' : ''}>
        <dc:Bounds x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}"/>
        <bpmndi:BPMNLabel/>
      </bpmndi:BPMNShape>`);
    });

    // Sequence flows
    seqFlows.forEach(conn => {
      const src = portToStep.get(conn.sourcePortId);
      const tgt = portToStep.get(conn.targetPortId);
      if (!src || !tgt) return;

      const srcPos = layout.get(src);
      const tgtPos = layout.get(tgt);
      if (!srcPos || !tgtPos) return;

      const connId = bpmnId(conn.id);
      const streamTypeAttr = conn.dexpiType !== 'Stream' ? ` streamType="${conn.dexpiType}"` : '';

      processElements.push(`  <bpmn:sequenceFlow id="${connId}" name="${conn.label}" sourceRef="${bpmnId(src)}" targetRef="${bpmnId(tgt)}">
    <bpmn:extensionElements>
      <dexpi:Stream uid="${conn.id}" identifier="${conn.identifier}"${streamTypeAttr}/>
    </bpmn:extensionElements>
  </bpmn:sequenceFlow>`);

      // Edge waypoints: simple straight line
      const srcCx = srcPos.x + srcPos.w;
      const srcCy = srcPos.y + srcPos.h / 2;
      const tgtCx = tgtPos.x;
      const tgtCy = tgtPos.y + tgtPos.h / 2;

      edgeElements.push(`      <bpmndi:BPMNEdge id="${connId}_di" bpmnElement="${connId}">
        <di:waypoint x="${srcCx}" y="${srcCy}"/>
        <di:waypoint x="${tgtCx}" y="${tgtCy}"/>
        <bpmndi:BPMNLabel/>
      </bpmndi:BPMNEdge>`);
    });

    // InformationFlows → Association + DataObjectReference
    infoFlows.forEach(conn => {
      const src = portToStep.get(conn.sourcePortId);
      if (!src) return;

      const varName = conn.informationVariantLabel || conn.label;
      const dobjId = `dobj_${bpmnId(conn.id)}`;
      const assocId = `assoc_${bpmnId(conn.id)}`;
      const srcEl = bpmnId(src);

      // Place DataObject between source and target
      const srcPos = layout.get(src);
      const dobjX = (srcPos?.x ?? MARGIN_X) + TASK_W + 30;
      const dobjY = (srcPos?.y ?? MARGIN_Y) - 60;

      processElements.push(`  <bpmn:dataObjectReference id="${dobjId}" name="${varName}" dataObjectRef="DataObject_${dobjId}"/>
  <bpmn:dataObject id="DataObject_${dobjId}"/>
  <bpmn:association id="${assocId}" sourceRef="${srcEl}" targetRef="${dobjId}" associationDirection="One">
    <bpmn:extensionElements>
      <dexpi:Stream streamType="InformationFlow" uid="${conn.id}" identifier="${conn.identifier}"/>
    </bpmn:extensionElements>
  </bpmn:association>`);

      shapeElements.push(`      <bpmndi:BPMNShape id="${dobjId}_di" bpmnElement="${dobjId}">
        <dc:Bounds x="${dobjX}" y="${dobjY}" width="36" height="50"/>
        <bpmndi:BPMNLabel/>
      </bpmndi:BPMNShape>`);

      if (srcPos) {
        edgeElements.push(`      <bpmndi:BPMNEdge id="${assocId}_di" bpmnElement="${assocId}">
        <di:waypoint x="${srcPos.x + srcPos.w / 2}" y="${srcPos.y}"/>
        <di:waypoint x="${dobjX + 18}" y="${dobjY + 50}"/>
      </bpmndi:BPMNEdge>`);
      }
    });

    // MaterialTemplates as standalone DataObjectReferences
    materialTemplates.forEach(tmpl => {
      const pos = layout.get(`dt_${tmpl.id}`);
      if (!pos) return;
      const dobjId = `dt_dobj_${bpmnId(tmpl.id)}`;
      processElements.push(`  <bpmn:dataObjectReference id="${dobjId}" name="${tmpl.label}" dataObjectRef="DataObject_${dobjId}"/>
  <bpmn:dataObject id="DataObject_${dobjId}"/>`);
      shapeElements.push(`      <bpmndi:BPMNShape id="${dobjId}_di" bpmnElement="${dobjId}">
        <dc:Bounds x="${pos.x}" y="${pos.y}" width="36" height="50"/>
        <bpmndi:BPMNLabel/>
      </bpmndi:BPMNShape>`);
    });

    // ── Assemble full BPMN XML ─────────────────────────────────────────────
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
  xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  xmlns:dexpi="http://dexpi.org/bpmn-extension/1.0"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  id="${defId}"
  targetNamespace="http://bpmn.io/schema/bpmn"
  exporter="bpmn2dexpi-importer"
  exporterVersion="1.0">

  <bpmn:process id="${processId}" isExecutable="false">
${processElements.join('\n\n')}
  </bpmn:process>

  <bpmndi:BPMNDiagram id="BPMNDiagram_imported">
    <bpmndi:BPMNPlane id="${planeId}" bpmnElement="${processId}">
${shapeElements.join('\n')}
${edgeElements.join('\n')}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>

</bpmn:definitions>`;
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  private _uidCounter = 0;
  private uid(): string {
    return `uid_gen_${++this._uidCounter}`;
  }
}
