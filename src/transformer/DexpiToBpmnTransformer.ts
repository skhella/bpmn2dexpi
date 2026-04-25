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
  parentId?: string;
  children: DexpiStep[];
}

interface DexpiPort {
  id: string;
  type: string;       // MaterialPort, ThermalEnergyPort, etc.
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

type LayoutBox = {x: number, y: number, w: number, h: number};

// Layout constants
const TASK_W = 100;
const TASK_H = 80;
const EVENT_D = 36;      // diameter
const H_GAP = 200;       // horizontal gap between elements
const V_GAP = 100;       // vertical gap between elements
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

    // Parse steps
    const steps: DexpiStep[] = [];
    const stepsContainer = this.findComponents(processModel, 'ProcessSteps');
    if (stepsContainer) {
      Array.from(stepsContainer.children)
        .filter(el => el.tagName === 'Object')
        .forEach(obj => {
          const step = this.parseStep(obj);
          this.collectStep(step, steps);
        });
    }

    // Parse connections
    const connections: DexpiConnection[] = [];
    Array.from(processModel.querySelectorAll('Components[property="ProcessConnections"]'))
      .forEach(connContainer => {
        Array.from(connContainer.children)
          .filter(el => el.tagName === 'Object')
          .forEach(obj => {
            const conn = this.parseConnection(obj);
            if (conn) connections.push(conn);
          });
      });

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

  private parseStep(obj: Element, parentId?: string): DexpiStep {
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

          ports.push({ id: portId, type: portType as any, direction, label: portLabel, identifier: portIdentifier });
        });
    }

    const children = this.findNestedProcessStepObjects(obj)
      .map(childObj => this.parseStep(childObj, id));

    return { id, dexpiType, identifier, label, ports, parentId, children };
  }

  private collectStep(step: DexpiStep, steps: DexpiStep[]): void {
    steps.push(step);
    step.children.forEach(child => this.collectStep(child, steps));
  }

  private findNestedProcessStepObjects(stepObj: Element): Element[] {
    const childObjects: Element[] = [];

    const collectFromStepsContainer = (container: Element | null) => {
      if (!container) return;
      Array.from(container.children)
        .filter(el => el.tagName === 'Object')
        .forEach(el => childObjects.push(el));
    };

    // This is the format emitted by BpmnToDexpiTransformer for BPMN subprocesses.
    collectFromStepsContainer(this.findComponents(stepObj, 'SubProcessSteps'));

    // Some DEXPI exports represent a nested procedure as a ProcessModel child.
    Array.from(stepObj.children)
      .filter(el =>
        el.tagName === 'Components' &&
        ['ProcessModel', 'ProcessModels', 'SubProcessModel', 'SubProcessModels'].includes(el.getAttribute('property') || '')
      )
      .forEach(container => {
        Array.from(container.children)
          .filter(el => el.tagName === 'Object' && el.getAttribute('type') === 'Process/ProcessModel')
          .forEach(processModel => collectFromStepsContainer(this.findComponents(processModel, 'ProcessSteps')));
      });

    // Be liberal for hand-authored XML: ProcessSteps directly beneath the step.
    collectFromStepsContainer(this.findComponents(stepObj, 'ProcessSteps'));

    return childObjects;
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

  private computeLayout(parsed: ParsedDexpi): Map<string, LayoutBox> {
    const { steps, connections } = parsed;
    const visibleSteps = steps.filter(s => !s.parentId && !this.isPortProxyStep(s));
    const layout = this.computeStepLayout(visibleSteps, connections);

    // Place MaterialTemplates as Data Objects below the diagram
    let dtX = MARGIN_X;
    const maxBottom = Math.max(
      MARGIN_Y + TASK_H,
      ...Array.from(layout.values()).map(pos => pos.y + pos.h)
    );
    const dtY = maxBottom + 120;
    parsed.materialTemplates.forEach(tmpl => {
      layout.set(`dt_${tmpl.id}`, { x: dtX, y: dtY, w: 36, h: 50 });
      dtX += 120;
    });

    return layout;
  }

  private computeStepLayout(
    steps: DexpiStep[],
    connections: DexpiConnection[],
    hiddenStepIds: Set<string> = new Set()
  ): Map<string, LayoutBox> {
    const visibleSteps = steps.filter(step => !hiddenStepIds.has(step.id));
    const visibleStepIds = new Set(visibleSteps.map(step => step.id));
    const stepById = new Map(visibleSteps.map(step => [step.id, step]));
    const layout = new Map<string, LayoutBox>();

    if (visibleSteps.length === 0) return layout;

    const portToStep = new Map<string, string>();
    visibleSteps.forEach(step => {
      step.ports.forEach(port => portToStep.set(port.id, step.id));
    });

    const downstream = new Map<string, Set<string>>();
    const upstream = new Map<string, Set<string>>();
    visibleSteps.forEach(step => {
      downstream.set(step.id, new Set());
      upstream.set(step.id, new Set());
    });

    connections.forEach(conn => {
      if (conn.dexpiType === 'InformationFlow') return;
      const src = portToStep.get(conn.sourcePortId);
      const tgt = portToStep.get(conn.targetPortId);
      if (!src || !tgt || src === tgt || !visibleStepIds.has(src) || !visibleStepIds.has(tgt)) return;
      downstream.get(src)?.add(tgt);
      upstream.get(tgt)?.add(src);
    });

    const sources = visibleSteps.filter(step => step.dexpiType === 'Source').map(step => step.id);
    const sinks = new Set(visibleSteps.filter(step => step.dexpiType === 'Sink').map(step => step.id));
    const sourceAdjacent = new Set<string>();
    sources.forEach(sourceId => {
      downstream.get(sourceId)?.forEach(targetId => {
        if (stepById.get(targetId)?.dexpiType !== 'Sink') sourceAdjacent.add(targetId);
      });
    });
    const sinkAdjacent = new Set<string>();
    sinks.forEach(sinkId => {
      upstream.get(sinkId)?.forEach(sourceId => {
        if (stepById.get(sourceId)?.dexpiType !== 'Source') sinkAdjacent.add(sourceId);
      });
    });

    const processRoots = [...sourceAdjacent].filter(id => !sinkAdjacent.has(id));
    const fallbackRoots = visibleSteps
      .filter(step =>
        step.dexpiType !== 'Source' &&
        step.dexpiType !== 'Sink' &&
        (upstream.get(step.id)?.size ?? 0) === 0
      )
      .map(step => step.id);
    const roots = sources.length > 0
      ? [...sources, ...processRoots]
      : (fallbackRoots.length > 0 ? fallbackRoots : [visibleSteps.find(step => step.dexpiType !== 'Sink')?.id || visibleSteps[0].id]);

    const layer = new Map<string, number>();
    sources.forEach(id => layer.set(id, 0));
    processRoots.forEach(id => layer.set(id, 1));
    if (sources.length === 0) roots.forEach(id => layer.set(id, 0));

    const queue = [...roots];

    const updateCount = new Map<string, number>();
    const maxLayer = Math.max(1, visibleSteps.length);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curLayer = layer.get(cur) ?? 0;
      downstream.get(cur)?.forEach(next => {
        if (stepById.get(next)?.dexpiType === 'Source') return;
        if (processRoots.includes(next) && stepById.get(cur)?.dexpiType !== 'Source') return;
        if (stepById.get(cur)?.dexpiType === 'Source' && !processRoots.includes(next)) return;
        const proposed = Math.min(maxLayer, curLayer + 1);
        const existing = layer.get(next) ?? -1;
        const count = updateCount.get(next) ?? 0;
        if (proposed > existing && count < visibleSteps.length) {
          layer.set(next, proposed);
          updateCount.set(next, count + 1);
          queue.push(next);
        }
      });
    }

    visibleSteps.forEach(step => {
      if (!layer.has(step.id)) {
        const fallbackLayer = Math.max(0, ...Array.from(layer.values()));
        layer.set(step.id, step.dexpiType === 'Sink' ? maxLayer : fallbackLayer);
      }
    });

    processRoots.forEach(id => layer.set(id, 1));
    const sinkLayer = Math.max(1, ...visibleSteps
      .filter(step => step.dexpiType !== 'Sink')
      .map(step => layer.get(step.id) ?? 0)) + 1;
    sinks.forEach(id => layer.set(id, sinkLayer));

    const byLayer = new Map<number, string[]>();
    visibleSteps.forEach(step => {
      const l = layer.get(step.id) ?? 0;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(step.id);
    });

    const sortedLayers = Array.from(byLayer.keys()).sort((a, b) => a - b);
    const initialOrder = new Map(visibleSteps.map((step, index) => [step.id, index]));
    const yOrder = new Map<string, number>();

    sortedLayers.forEach((layerIdx, layerPosition) => {
      const ids = byLayer.get(layerIdx)!;
      ids.sort((a, b) => {
        const ta = stepById.get(a)?.dexpiType || '';
        const tb = stepById.get(b)?.dexpiType || '';
        const sourceScore = (id: string) => {
          const targets = [...(downstream.get(id) || [])];
          if (targets.length === 0) return initialOrder.get(id) ?? 0;
          return targets.reduce((sum, target) => sum + (layer.get(target) ?? 0), 0) / targets.length;
        };

        if (ta === 'Source' && tb === 'Source') {
          const delta = sourceScore(a) - sourceScore(b);
          if (delta !== 0) return delta;
          const labelA = stepById.get(a)?.label || a;
          const labelB = stepById.get(b)?.label || b;
          return labelA.localeCompare(labelB);
        }
        if (ta === 'Source' && tb !== 'Source') return -1;
        if (tb === 'Source' && ta !== 'Source') return 1;
        if (ta === 'Sink' && tb !== 'Sink') return 1;
        if (tb === 'Sink' && ta !== 'Sink') return -1;

        const barycenter = (id: string) => {
          const refs = [...(upstream.get(id) || [])].filter(ref => yOrder.has(ref));
          if (refs.length === 0) return initialOrder.get(id) ?? 0;
          return refs.reduce((sum, ref) => sum + (yOrder.get(ref) ?? 0), 0) / refs.length;
        };

        const delta = barycenter(a) - barycenter(b);
        return delta !== 0 ? delta : a.localeCompare(b);
      });

      const x = MARGIN_X + layerPosition * (TASK_W + H_GAP);
      ids.forEach((id, index) => {
        const step = stepById.get(id)!;
        const isEvent = step.dexpiType === 'Source' || step.dexpiType === 'Sink';
        const w = isEvent ? EVENT_D : TASK_W;
        const h = isEvent ? EVENT_D : TASK_H;
        const yOffset = isEvent ? (TASK_H - EVENT_D) / 2 : 0;
        const y = MARGIN_Y + index * (TASK_H + V_GAP) + yOffset;
        layout.set(id, { x, y, w, h });
        yOrder.set(id, index);
      });
    });

    return layout;
  }

  // ── BPMN builder ────────────────────────────────────────────────────────────

  private buildBpmn(parsed: ParsedDexpi, layout: Map<string, LayoutBox>): string {
    const { steps, connections, materialTemplates } = parsed;

    // Build port → step map for resolving connection endpoints
    const portToStep = new Map<string, string>();
    steps.forEach(s => s.ports.forEach(p => portToStep.set(p.id, s.id)));
    const stepById = new Map(steps.map(s => [s.id, s]));
    const hiddenStepIds = new Set(steps.filter(step => this.isPortProxyStep(step)).map(step => step.id));

    const processId = 'Process_imported';
    const defId = 'Definitions_imported';
    const planeId = 'BPMNPlane_imported';

    // Classify connections
    const isHiddenConnection = (conn: DexpiConnection) => {
      const src = portToStep.get(conn.sourcePortId);
      const tgt = portToStep.get(conn.targetPortId);
      return (src !== undefined && hiddenStepIds.has(src)) ||
             (tgt !== undefined && hiddenStepIds.has(tgt));
    };
    const seqFlows = connections.filter(c => c.dexpiType !== 'InformationFlow' && !isHiddenConnection(c));
    const infoFlows = connections.filter(c => c.dexpiType === 'InformationFlow' && !isHiddenConnection(c));

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
    const sequenceFlowsByOwner = new Map<string, string[]>();
    const extraProcessElementsByOwner = new Map<string, string[]>();
    const shapeElementsByOwner = new Map<string, string[]>();
    const edgeElementsByOwner = new Map<string, string[]>();
    const ownerLayouts = new Map<string, Map<string, LayoutBox>>();
    const rootOwner = '__root__';
    const ownerKey = (ownerId?: string) => ownerId || rootOwner;
    const indentBlock = (xml: string, indent: string) =>
      xml.split('\n').map(line => line ? `${indent}${line}` : line).join('\n');
    const visibleChildren = (step: DexpiStep) => step.children.filter(child => !hiddenStepIds.has(child.id));
    const pushOwned = (map: Map<string, string[]>, owner: string, xml: string) => {
      if (!map.has(owner)) map.set(owner, []);
      map.get(owner)!.push(xml);
    };
    const buildChildLayout = (owner: DexpiStep) => {
      const childLayout = this.computeStepLayout(visibleChildren(owner), connections, hiddenStepIds);
      ownerLayouts.set(owner.id, childLayout);
      visibleChildren(owner)
        .filter(child => child.children.length > 0)
        .forEach(buildChildLayout);
    };

    ownerLayouts.set(rootOwner, layout);
    steps
      .filter(step => !hiddenStepIds.has(step.id) && step.children.length > 0)
      .forEach(buildChildLayout);

    const routeSequenceFlow = (srcPos: LayoutBox, tgtPos: LayoutBox, lane: number) => {
      const srcX = srcPos.x + srcPos.w;
      const srcY = srcPos.y + srcPos.h / 2;
      const tgtX = tgtPos.x;
      const tgtY = tgtPos.y + tgtPos.h / 2;
      const laneOffset = (lane % 6) * 18;

      if (tgtX >= srcX + 50) {
        const bendX = Math.max(srcX + 35, tgtX - 60 - laneOffset);
        return [
          { x: srcX, y: srcY },
          { x: bendX, y: srcY },
          { x: bendX, y: tgtY },
          { x: tgtX, y: tgtY },
        ];
      }

      const detourX = srcX + 60 + laneOffset;
      const detourY = Math.min(srcPos.y, tgtPos.y) - 55 - laneOffset;
      return [
        { x: srcX, y: srcY },
        { x: detourX, y: srcY },
        { x: detourX, y: detourY },
        { x: tgtX, y: detourY },
        { x: tgtX, y: tgtY },
      ];
    };

    const edgeLaneByOwner = new Map<string, number>();
    const nextLane = (key: string) => {
      const lane = edgeLaneByOwner.get(key) ?? 0;
      edgeLaneByOwner.set(key, lane + 1);
      return lane;
    };

    const extensionXml = (step: DexpiStep, indent: string): string => {
      // Extension elements — assign anchorSide based on direction and spread offset
      const inlets  = step.ports.filter(p => p.direction === 'Inlet');
      const outlets = step.ports.filter(p => p.direction === 'Outlet');

      const portsXml = step.ports.map(p => {
        const bpmnDir = p.direction === 'Outlet' ? 'Outlet' : 'Inlet';
        const anchorSide = bpmnDir === 'Outlet' ? 'right' : 'left';
        // Spread multiple ports evenly along the side
        const group = bpmnDir === 'Outlet' ? outlets : inlets;
        const idx = group.indexOf(p);
        const anchorOffset = group.length === 1 ? 0.5 : (idx + 1) / (group.length + 1);
        return `${indent}    <dexpi:port portId="${p.id}" name="${p.label}" portType="${p.type}" direction="${bpmnDir}" label="${p.label}" anchorSide="${anchorSide}" anchorOffset="${anchorOffset.toFixed(2)}"/>`;
      }).join('\n');

      return `${indent}<bpmn:extensionElements>
${indent}  <dexpi:element dexpiType="${step.dexpiType}" identifier="${step.identifier}" uid="${step.id}">
${portsXml ? portsXml + '\n' : ''}${indent}  </dexpi:element>
${indent}</bpmn:extensionElements>`;
    };

    const renderStep = (step: DexpiStep, indent: string): string => {
      const elId = bpmnId(step.id);
      const name = step.label !== step.dexpiType ? step.label : step.dexpiType;
      const childIndent = `${indent}  `;
      const extEl = extensionXml(step, childIndent);
      const inc = incoming.get(step.id)?.map(id => `${childIndent}<bpmn:incoming>${bpmnId(id)}</bpmn:incoming>`).join('\n') || '';
      const out = outgoing.get(step.id)?.map(id => `${childIndent}<bpmn:outgoing>${bpmnId(id)}</bpmn:outgoing>`).join('\n') || '';
      const flowRefs = [inc, out].filter(Boolean).join('\n');
      const commonBody = `${extEl}${flowRefs ? '\n' + flowRefs : ''}`;

      if (step.dexpiType === 'Source') {
        return `${indent}<bpmn:startEvent id="${elId}" name="${name}">
${commonBody}
${indent}</bpmn:startEvent>`;
      }

      if (step.dexpiType === 'Sink') {
        return `${indent}<bpmn:endEvent id="${elId}" name="${name}">
${commonBody}
${indent}</bpmn:endEvent>`;
      }

      if (step.children.length > 0) {
        const nestedElements = [
          ...visibleChildren(step).map(child => renderStep(child, childIndent)),
          ...(sequenceFlowsByOwner.get(step.id) || []).map(xml => indentBlock(xml, childIndent)),
          ...(extraProcessElementsByOwner.get(step.id) || []).map(xml => indentBlock(xml, childIndent)),
        ].join('\n\n');

        return `${indent}<bpmn:subProcess id="${elId}" name="${name}">
${commonBody}${nestedElements ? '\n' + nestedElements : ''}
${indent}</bpmn:subProcess>`;
      }

      return `${indent}<bpmn:task id="${elId}" name="${name}">
${commonBody}
${indent}</bpmn:task>`;
    };

    // Sequence flows
    seqFlows.forEach(conn => {
      const src = portToStep.get(conn.sourcePortId);
      const tgt = portToStep.get(conn.targetPortId);
      if (!src || !tgt) return;

      const connId = bpmnId(conn.id);
      const streamTypeAttr = conn.dexpiType !== 'Stream' ? ` streamType="${conn.dexpiType}"` : '';
      const srcStep = stepById.get(src);
      const tgtStep = stepById.get(tgt);
      const owner = srcStep?.parentId === tgtStep?.parentId ? srcStep?.parentId : undefined;
      const key = ownerKey(owner);
      if (!sequenceFlowsByOwner.has(key)) sequenceFlowsByOwner.set(key, []);
      sequenceFlowsByOwner.get(key)!.push(`<bpmn:sequenceFlow id="${connId}" name="${conn.label}" sourceRef="${bpmnId(src)}" targetRef="${bpmnId(tgt)}">
  <bpmn:extensionElements>
    <dexpi:Stream uid="${conn.id}" identifier="${conn.identifier}"${streamTypeAttr}/>
  </bpmn:extensionElements>
</bpmn:sequenceFlow>`);

      const ownerLayout = ownerLayouts.get(key) || layout;
      const srcPos = ownerLayout.get(src);
      const tgtPos = ownerLayout.get(tgt);
      if (!srcPos || !tgtPos) return;

      const waypoints = routeSequenceFlow(srcPos, tgtPos, nextLane(key))
        .map(point => `        <di:waypoint x="${point.x}" y="${point.y}"/>`)
        .join('\n');

      const edgeXml = `      <bpmndi:BPMNEdge id="${connId}_di" bpmnElement="${connId}">
${waypoints}
        <bpmndi:BPMNLabel/>
      </bpmndi:BPMNEdge>`;
      if (key === rootOwner) {
        edgeElements.push(edgeXml);
      } else {
        pushOwned(edgeElementsByOwner, key, edgeXml);
      }
    });

    const shapeForStep = (step: DexpiStep, pos: LayoutBox) => {
      const elId = bpmnId(step.id);
      const isEvent = step.dexpiType === 'Source' || step.dexpiType === 'Sink';
      const isExpandedSubProcess = step.children.length > 0;

      return `      <bpmndi:BPMNShape id="${elId}_di" bpmnElement="${elId}"${isEvent ? ' isHorizontal="false"' : ''}${isExpandedSubProcess ? ' isExpanded="false"' : ''}>
        <dc:Bounds x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}"/>
        <bpmndi:BPMNLabel/>
      </bpmndi:BPMNShape>`;
    };

    steps.filter(step => !step.parentId && !hiddenStepIds.has(step.id)).forEach(step => {
      const pos = layout.get(step.id);
      if (!pos) return;
      shapeElements.push(shapeForStep(step, pos));
    });

    steps.filter(step => step.parentId && !hiddenStepIds.has(step.id)).forEach(step => {
      const owner = step.parentId;
      if (!owner) return;
      const ownerLayout = ownerLayouts.get(owner);
      const pos = ownerLayout?.get(step.id);
      if (!pos) return;
      pushOwned(shapeElementsByOwner, owner, shapeForStep(step, pos));
    });

    // InformationFlows → Association + DataObjectReference
    infoFlows.forEach(conn => {
      const src = portToStep.get(conn.sourcePortId);
      if (!src) return;
      const srcStep = stepById.get(src);
      const key = ownerKey(srcStep?.parentId);

      const varName = conn.informationVariantLabel || conn.label;
      const dobjId = `dobj_${bpmnId(conn.id)}`;
      const assocId = `assoc_${bpmnId(conn.id)}`;
      const srcEl = bpmnId(src);

      // Place DataObject between source and target
      const ownerLayout = ownerLayouts.get(key) || layout;
      const srcPos = ownerLayout.get(src);
      const dobjX = (srcPos?.x ?? MARGIN_X) + TASK_W + 30;
      const dobjY = (srcPos?.y ?? MARGIN_Y) - 60;

      const dataObjectXml = `<bpmn:dataObjectReference id="${dobjId}" name="${varName}" dataObjectRef="DataObject_${dobjId}"/>
  <bpmn:dataObject id="DataObject_${dobjId}"/>
  <bpmn:association id="${assocId}" sourceRef="${srcEl}" targetRef="${dobjId}" associationDirection="One">
    <bpmn:extensionElements>
      <dexpi:Stream streamType="InformationFlow" uid="${conn.id}" identifier="${conn.identifier}"/>
    </bpmn:extensionElements>
  </bpmn:association>`;
      if (key === rootOwner) {
        processElements.push(indentBlock(dataObjectXml, '  '));
      } else {
        pushOwned(extraProcessElementsByOwner, key, dataObjectXml);
      }

      const shapeXml = `      <bpmndi:BPMNShape id="${dobjId}_di" bpmnElement="${dobjId}">
        <dc:Bounds x="${dobjX}" y="${dobjY}" width="36" height="50"/>
        <bpmndi:BPMNLabel/>
      </bpmndi:BPMNShape>`;
      if (key === rootOwner) {
        shapeElements.push(shapeXml);
      } else {
        pushOwned(shapeElementsByOwner, key, shapeXml);
      }

      if (srcPos) {
        const edgeXml = `      <bpmndi:BPMNEdge id="${assocId}_di" bpmnElement="${assocId}">
        <di:waypoint x="${srcPos.x + srcPos.w / 2}" y="${srcPos.y}"/>
        <di:waypoint x="${dobjX + 18}" y="${dobjY + 50}"/>
      </bpmndi:BPMNEdge>`;
        if (key === rootOwner) {
          edgeElements.push(edgeXml);
        } else {
          pushOwned(edgeElementsByOwner, key, edgeXml);
        }
      }
    });

    steps.filter(step => !step.parentId && !hiddenStepIds.has(step.id)).forEach(step => {
      processElements.push(renderStep(step, '  '));
    });

    (sequenceFlowsByOwner.get(rootOwner) || []).forEach(xml => {
      processElements.push(indentBlock(xml, '  '));
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

    const subprocessDiagrams = steps
      .filter(step => !hiddenStepIds.has(step.id) && step.children.length > 0)
      .map(step => {
        const owner = step.id;
        return `  <bpmndi:BPMNDiagram id="${bpmnId(owner)}_diagram">
    <bpmndi:BPMNPlane id="${bpmnId(owner)}_plane" bpmnElement="${bpmnId(owner)}">
${(shapeElementsByOwner.get(owner) || []).join('\n')}
${(edgeElementsByOwner.get(owner) || []).join('\n')}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>`;
      })
      .join('\n\n');

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
${subprocessDiagrams ? '\n' + subprocessDiagrams : ''}

</bpmn:definitions>`;
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  private isPortProxyStep(step: DexpiStep): boolean {
    if (step.dexpiType !== 'Source' && step.dexpiType !== 'Sink') return false;

    const label = step.label.trim();
    if (!label) return false;

    const isPortLikeLabel = /^(MI|MO|TEI|TEO|MEI|MEO|EEI|EEO)\d+$/i.test(label) ||
      /^IP[IO]_/i.test(label);
    if (isPortLikeLabel) return true;

    return step.ports.length > 0 && step.ports.every(port => port.label === label);
  }

  private _uidCounter = 0;
  private uid(): string {
    return `uid_gen_${++this._uidCounter}`;
  }
}
