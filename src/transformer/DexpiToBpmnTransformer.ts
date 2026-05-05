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

import { DexpiProcessClassRegistry } from './DexpiProcessClassRegistry';

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
  subPortIds?: string[];
  superPortId?: string;
}

interface DexpiConnection {
  id: string;
  dexpiType: string;      // Stream, ThermalEnergyFlow, InformationFlow, etc.
  identifier: string;
  label: string;
  sourcePortId: string;
  targetPortId: string;
  informationVariantLabel?: string;
  hidden?: boolean;
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
type EdgeSide = 'left' | 'right' | 'top' | 'bottom';

// Layout constants
const TASK_W = 130;
const TASK_H = 90;
const EVENT_D = 52;      // diameter
const H_GAP = 200;       // horizontal gap between elements
const V_GAP = 100;       // vertical gap between elements
const MARGIN_X = 100;
const MARGIN_Y = 100;
const ENERGY_BAND_GAP = 80; // vertical gap between an energy boundary event and its connected task

export interface DexpiToBpmnTransformOptions {
  /** Pre-loaded Process.xml string (for browser builds where the file isn't on disk). */
  processXml?: string;
}

export class DexpiToBpmnTransformer {

  /** DEXPI Process class registry — loaded from Process.xml. Empty until first transform(). */
  private registry: DexpiProcessClassRegistry = DexpiProcessClassRegistry.empty();

  // ── Public API ─────────────────────────────────────────────────────────────

  async transform(dexpiXml: string, options: DexpiToBpmnTransformOptions = {}): Promise<string> {
    // Load DEXPI class registry (cached after first call). Used to classify
    // instrumentation steps via the InstrumentationActivity ancestor check —
    // no hardcoded list of subclass names.
    this.registry = await DexpiProcessClassRegistry.load(options.processXml);

    const parsed = this.parseDexpi(dexpiXml);
    this.materializeBoundaryProxyEvents(parsed);
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
          const subPortIds = this.getReferenceIds(portObj, 'SubReference');
          const superPortIds = this.getReferenceIds(portObj, 'SuperReference');

          ports.push({
            id: portId,
            type: portType as any,
            direction,
            label: portLabel,
            identifier: portIdentifier,
            subPortIds: subPortIds.length > 0 ? subPortIds : undefined,
            superPortId: superPortIds[0],
          });
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

  private getReferenceIds(parent: Element | null, property: string): string[] {
    if (!parent) return [];
    const refs = Array.from(parent.querySelectorAll(`References[property="${property}"]`));
    return refs.flatMap(ref => (ref.getAttribute('objects') || '')
      .split(/\s+/)
      .map(value => value.trim().replace(/^#/, ''))
      .filter(Boolean));
  }

  private materializeBoundaryProxyEvents(parsed: ParsedDexpi): void {
    const stepById = new Map(parsed.steps.map(step => [step.id, step]));
    const portById = new Map<string, DexpiPort>();
    const portToStep = new Map<string, DexpiStep>();
    parsed.steps.forEach(step => {
      step.ports.forEach(port => {
        portById.set(port.id, port);
        portToStep.set(port.id, step);
      });
    });

    const stepIds = new Set(parsed.steps.map(step => step.id));
    const portIds = new Set(Array.from(portById.keys()));
    const connectionIds = new Set(parsed.connections.map(conn => conn.id));

    const isDescendantOf = (step: DexpiStep | undefined, parentId: string): boolean => {
      let current = step;
      while (current?.parentId) {
        if (current.parentId === parentId) return true;
        current = stepById.get(current.parentId);
      }
      return false;
    };

    const addSubReference = (parentPort: DexpiPort, childPortId: string) => {
      if (!parentPort.subPortIds) parentPort.subPortIds = [];
      if (!parentPort.subPortIds.includes(childPortId)) parentPort.subPortIds.push(childPortId);
    };

    const oppositeEventType = (parentPort: DexpiPort) =>
      parentPort.direction === 'Outlet' ? 'Sink' : 'Source';
    const oppositePortDirection = (parentPort: DexpiPort) =>
      parentPort.direction === 'Outlet' ? 'Inlet' : 'Outlet';

    const findExistingProxyPorts = (parent: DexpiStep, parentPort: DexpiPort): string[] => {
      const expectedType = oppositeEventType(parentPort);
      const expectedDirection = oppositePortDirection(parentPort);
      const explicitRefs = new Set(parentPort.subPortIds || []);

      return parsed.steps
        .filter(step =>
          step.dexpiType === expectedType &&
          step.ports.length > 0
        )
        .flatMap(step => step.ports)
        .filter(port =>
          port.direction === expectedDirection &&
          (
            port.superPortId === parentPort.id ||
            explicitRefs.has(port.id) ||
            // Generic rule: a user-modeled Source/Sink event nested directly
            // inside the subprocess, with the same port label and direction
            // as the parent boundary port, IS the visual representation of
            // that boundary. Use it instead of auto-materializing a duplicate
            // — even when the parent port also has explicit subReferences
            // (the subRefs route the flow to inner tasks; the user-modeled
            // event is the visible boundary marker).
            (portToStep.get(port.id)?.parentId === parent.id &&
              port.label === parentPort.label &&
              !port.superPortId)
          )
        )
        .map(port => {
          const proxyStep = portToStep.get(port.id);
          const isExplicitBoundaryProxy = port.superPortId === parentPort.id || explicitRefs.has(port.id);
          if (proxyStep && !proxyStep.parentId && isExplicitBoundaryProxy) {
            proxyStep.parentId = parent.id;
            if (!parent.children.some(child => child.id === proxyStep.id)) {
              parent.children.push(proxyStep);
            }
          }
          return port.id;
        });
    };

    const uniqueId = (base: string, used: Set<string>) => {
      const sanitized = base.replace(/[^a-zA-Z0-9_]/g, '_') || 'BoundaryProxy';
      let candidate = sanitized;
      let counter = 2;
      while (used.has(candidate)) {
        candidate = `${sanitized}_${counter}`;
        counter += 1;
      }
      used.add(candidate);
      return candidate;
    };

    const streamTypeForPort = (port: DexpiPort) => {
      switch (port.type) {
        case 'ThermalEnergyPort':
          return 'ThermalEnergyFlow';
        case 'MechanicalEnergyPort':
          return 'MechanicalEnergyFlow';
        case 'ElectricalEnergyPort':
          return 'ElectricalEnergyFlow';
        default:
          return 'Stream';
      }
    };
    const isEnergyPortLike = (port: DexpiPort) =>
      ['ThermalEnergyPort', 'MechanicalEnergyPort', 'ElectricalEnergyPort'].includes(port.type) ||
      /^(TEI|TEO|MEI|MEO|EEI|EEO)\d+$/i.test(port.label);
    const isEnergyConnection = (conn: DexpiConnection) =>
      ['ThermalEnergyFlow', 'MechanicalEnergyFlow', 'ElectricalEnergyFlow', 'EnergyFlow'].includes(conn.dexpiType);

    const addBoundaryProxy = (
      parent: DexpiStep,
      parentPort: DexpiPort,
      innerPortIds: string[],
      sourceConnections: DexpiConnection[] = []
    ) => {
      const eventType = oppositeEventType(parentPort);
      const eventPortDirection = oppositePortDirection(parentPort);
      const eventId = uniqueId(`${parent.id}_${parentPort.label}_${eventType}`, stepIds);
      const eventPortId = uniqueId(`${eventId}_${parentPort.label}_port`, portIds);
      const eventPort: DexpiPort = {
        id: eventPortId,
        type: parentPort.type,
        direction: eventPortDirection,
        label: parentPort.label,
        identifier: eventPortId,
        superPortId: parentPort.id,
      };
      const eventStep: DexpiStep = {
        id: eventId,
        dexpiType: eventType,
        identifier: eventId,
        label: parentPort.label,
        ports: [eventPort],
        parentId: parent.id,
        children: [],
      };

      parent.children.push(eventStep);
      parsed.steps.push(eventStep);
      stepById.set(eventStep.id, eventStep);
      portById.set(eventPort.id, eventPort);
      portToStep.set(eventPort.id, eventStep);
      parentPort.subPortIds = [eventPort.id];

      innerPortIds.forEach((innerPortId, index) => {
        if (!portById.has(innerPortId)) return;
        const sourcePortId = parentPort.direction === 'Inlet' ? eventPort.id : innerPortId;
        const targetPortId = parentPort.direction === 'Inlet' ? innerPortId : eventPort.id;
        const sourcePort = portById.get(sourcePortId);
        const targetPort = portById.get(targetPortId);
        const sourceConnection = sourceConnections[index] || sourceConnections[0];
        const flowId = uniqueId(`${eventId}_flow_${index + 1}`, connectionIds);

        parsed.connections.push({
          id: flowId,
          dexpiType: sourceConnection?.dexpiType || streamTypeForPort(parentPort),
          identifier: flowId,
          label: `${sourcePort?.label || sourcePortId} - ${targetPort?.label || targetPortId}`,
          sourcePortId,
          targetPortId,
        });
      });
    };

    parsed.steps
      .filter(parent => parent.children.length > 0)
      .forEach(parent => {
        parent.ports.forEach(parentPort => {
          if (parentPort.type === 'InformationPort') return;

          const existingProxyPortIds = findExistingProxyPorts(parent, parentPort);
          if (existingProxyPortIds.length > 0) {
            existingProxyPortIds.forEach(portId => {
              const childPort = portById.get(portId);
              if (childPort) childPort.superPortId = parentPort.id;
              addSubReference(parentPort, portId);
            });
            return;
          }

          const innerPortIdsFromSubReference = (parentPort.subPortIds || [])
            .filter(portId => {
              const innerStep = portToStep.get(portId);
              return isDescendantOf(innerStep, parent.id);
            });

          if (innerPortIdsFromSubReference.length > 0) {
            const parentPortConnections = parsed.connections.filter(conn =>
              !conn.hidden &&
              conn.dexpiType !== 'InformationFlow' &&
              (conn.sourcePortId === parentPort.id || conn.targetPortId === parentPort.id)
            );
            const isPeerEnergyBoundary = parentPortConnections.length > 0 &&
              (
                isEnergyPortLike(parentPort) ||
                innerPortIdsFromSubReference.some(portId => {
                  const innerPort = portById.get(portId);
                  return innerPort ? isEnergyPortLike(innerPort) : false;
                }) ||
                parentPortConnections.some(isEnergyConnection)
              ) &&
              parentPortConnections.every(conn => {
                const otherPortId = conn.sourcePortId === parentPort.id ? conn.targetPortId : conn.sourcePortId;
                const otherStep = portToStep.get(otherPortId);
                return !!otherStep &&
                  !isDescendantOf(otherStep, parent.id) &&
                  otherStep.id !== parent.id &&
                  otherStep.dexpiType !== 'Source' &&
                  otherStep.dexpiType !== 'Sink';
              });

            if (isPeerEnergyBoundary) return;
            addBoundaryProxy(parent, parentPort, innerPortIdsFromSubReference);
            return;
          }

          const crossingConnections = parsed.connections.filter(conn => {
            if (conn.hidden || conn.dexpiType === 'InformationFlow') return false;
            const sourceStep = portToStep.get(conn.sourcePortId);
            const targetStep = portToStep.get(conn.targetPortId);
            if (!sourceStep || !targetStep) return false;
            if (conn.sourcePortId === parentPort.id) return isDescendantOf(targetStep, parent.id);
            if (conn.targetPortId === parentPort.id) return isDescendantOf(sourceStep, parent.id);
            return false;
          });

          if (crossingConnections.length === 0) return;

          const innerPortIds = crossingConnections
            .map(conn => conn.sourcePortId === parentPort.id ? conn.targetPortId : conn.sourcePortId)
            .filter(portId => {
              const innerStep = portToStep.get(portId);
              return isDescendantOf(innerStep, parent.id);
            });

          if (innerPortIds.length === 0) return;
          crossingConnections.forEach(conn => { conn.hidden = true; });
          addBoundaryProxy(parent, parentPort, innerPortIds, crossingConnections);
        });
      });
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

    // Place MaterialTemplates as reference data near the upper-right of the process.
    const maxRight = Math.max(
      MARGIN_X + TASK_W,
      ...Array.from(layout.values()).map(pos => pos.x + pos.w)
    );
    let dtX = Math.max(MARGIN_X, maxRight - parsed.materialTemplates.length * 120 - 60);
    const dtY = Math.max(20, MARGIN_Y - 80);
    parsed.materialTemplates.forEach(tmpl => {
      layout.set(`dt_${tmpl.id}`, { x: dtX, y: dtY, w: 36, h: 50 });
      dtX += 120;
    });

    return layout;
  }

  private positionInstrumentationActivities(
    steps: DexpiStep[],
    connections: DexpiConnection[],
    layout: Map<string, LayoutBox>,
    hiddenStepIds: Set<string>
  ): void {
    const visibleSteps = steps.filter(step => !hiddenStepIds.has(step.id));
    const instruments = visibleSteps.filter(step => this.isInstrumentationStep(step) && layout.has(step.id));
    if (instruments.length === 0) return;

    const stepById = new Map(visibleSteps.map(step => [step.id, step]));
    const portToStep = new Map<string, string>();
    visibleSteps.forEach(step => step.ports.forEach(port => portToStep.set(port.id, step.id)));

    const mainSteps = visibleSteps.filter(step => !this.isInstrumentationStep(step) && layout.has(step.id));
    const mainBoxes = () => mainSteps.map(step => layout.get(step.id)!);
    if (mainBoxes().length === 0) return;

    type InstrumentBandItem = { id: string; desiredX: number; band: 'top' | 'bottom' };
    const topBand: InstrumentBandItem[] = [];
    const bottomBand: InstrumentBandItem[] = [];

    instruments.forEach(step => {
      const linkedStepIds = connections
        .filter(conn => !conn.hidden && conn.dexpiType === 'InformationFlow')
        .map(conn => {
          const src = portToStep.get(conn.sourcePortId);
          const tgt = portToStep.get(conn.targetPortId);
          if (src === step.id && tgt && !this.isInstrumentationStep(stepById.get(tgt))) return tgt;
          if (tgt === step.id && src && !this.isInstrumentationStep(stepById.get(src))) return src;
          return undefined;
        })
        .filter((id): id is string => !!id && layout.has(id));

      const anchorCenters = linkedStepIds.map(id => {
        const box = layout.get(id)!;
        return box.x + box.w / 2;
      });
      const current = layout.get(step.id)!;
      const desiredCenter = anchorCenters.length > 0
        ? anchorCenters.reduce((sum, x) => sum + x, 0) / anchorCenters.length
        : current.x + current.w / 2;
      const item = {
        id: step.id,
        desiredX: desiredCenter - current.w / 2,
        band: step.dexpiType === 'ControllingProcessVariable' ? 'top' as const : 'bottom' as const,
      };

      if (item.band === 'top') topBand.push(item);
      else bottomBand.push(item);
    });

    if (topBand.length > 0) {
      const minY = Math.min(...mainBoxes().map(box => box.y));
      const wantedTopY = minY - TASK_H - 120;
      const shiftY = Math.max(0, 20 - wantedTopY);
      if (shiftY > 0) {
        mainSteps.forEach(step => {
          const current = layout.get(step.id);
          if (current) layout.set(step.id, { ...current, y: current.y + shiftY });
        });
      }
    }

    const updatedMainBoxes = mainBoxes();
    const minY = Math.min(...updatedMainBoxes.map(box => box.y));
    const maxY = Math.max(...updatedMainBoxes.map(box => box.y + box.h));
    const topY = minY - TASK_H - 120;
    const bottomY = maxY + 120;

    const placeBand = (items: InstrumentBandItem[], y: number) => {
      const minGap = TASK_W + 45;
      let nextX = MARGIN_X;
      items
        .sort((a, b) => a.desiredX - b.desiredX || a.id.localeCompare(b.id))
        .forEach(item => {
          const current = layout.get(item.id);
          if (!current) return;
          const x = Math.max(MARGIN_X, item.desiredX, nextX);
          layout.set(item.id, { ...current, x, y });
          nextX = x + minGap;
        });
    };

    placeBand(topBand, topY);
    placeBand(bottomBand, bottomY);
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

    // Generic rule: energy boundary proxy events (Source/Sink that mirror an
    // energy port on the parent subprocess) are kept in the BFS so they
    // contribute to connectivity, then moved to a top/bottom band in
    // post-processing — matching how EEI/TEI/MEI are drawn in the BPMN
    // convention from the DEXPI mapping paper.
    const energyBoundaryProxies = new Set(
      visibleSteps.filter(step => this.isEnergyBoundaryProxy(step)).map(step => step.id)
    );

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
      if (conn.hidden) return;
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

    // Generic rule: process roots are source-adjacent steps that aren't also
    // sink-adjacent (i.e. real "first stage" tasks, not single-step throughputs).
    // BUT in tightly looped subprocesses every source-adjacent step often also
    // feeds the sink (e.g. MI1 → RegulatingFlow → … → MO1). When the strict
    // exclusion would leave processRoots empty, fall back to using the full
    // source-adjacent set; otherwise BFS from Source can never propagate and
    // everything collapses into a single layer.
    let processRoots = [...sourceAdjacent].filter(id => !sinkAdjacent.has(id));
    if (processRoots.length === 0 && sourceAdjacent.size > 0) {
      processRoots = [...sourceAdjacent];
    }
    const processRootSet = new Set(processRoots);
    // Generic rule: choose BFS roots in priority order:
    //   1. Real Sources (Source dexpiType)
    //   2. Steps with no upstream AND at least one downstream (true graph roots)
    //   3. Any step on a cycle that has downstream (break the cycle deterministically)
    //   4. Last resort: first non-sink step
    // Rule 3 prevents isolated instrumentation tasks (no flow connections) from
    // becoming roots and starving the actual closed-loop flow tasks of layering.
    const flowConnected = (step: DexpiStep) =>
      (downstream.get(step.id)?.size ?? 0) > 0;
    const fallbackRoots = visibleSteps
      .filter(step =>
        step.dexpiType !== 'Source' &&
        step.dexpiType !== 'Sink' &&
        (upstream.get(step.id)?.size ?? 0) === 0 &&
        flowConnected(step)
      )
      .map(step => step.id);
    const cycleRoots = visibleSteps
      .filter(step =>
        step.dexpiType !== 'Source' &&
        step.dexpiType !== 'Sink' &&
        flowConnected(step)
      )
      .map(step => step.id);
    const roots = sources.length > 0
      ? [...sources, ...processRoots]
      : (fallbackRoots.length > 0
          ? fallbackRoots
          : (cycleRoots.length > 0
              ? [cycleRoots[0]]
              : [visibleSteps.find(step => step.dexpiType !== 'Sink')?.id || visibleSteps[0].id]));

    const layer = new Map<string, number>();
    sources.forEach(id => layer.set(id, 0));
    processRoots.forEach(id => layer.set(id, 1));
    if (sources.length === 0) roots.forEach(id => layer.set(id, 0));

    const queue = [...roots];

    // Generic rule: cap per-step updates so closed-loop subprocesses (no
    // source/sink, every node in a cycle) don't make the BFS spiral with each
    // node bumping the next around the loop. A small cap (≤ visibleSteps.length)
    // is enough for legitimate convergent paths that should push a downstream
    // step to a later layer; beyond that we're chasing a cycle.
    const updateCap = 1;
    const updateCount = new Map<string, number>();
    const maxLayer = Math.max(1, visibleSteps.length);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curLayer = layer.get(cur) ?? 0;
      downstream.get(cur)?.forEach(next => {
        if (stepById.get(next)?.dexpiType === 'Source') return;
        if (processRootSet.has(next) && stepById.get(cur)?.dexpiType !== 'Source') return;
        if (stepById.get(cur)?.dexpiType === 'Source' && !processRootSet.has(next)) return;
        const proposed = Math.min(maxLayer, curLayer + 1);
        const existing = layer.get(next) ?? -1;
        const count = updateCount.get(next) ?? 0;
        if (proposed > existing && count < updateCap) {
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

    const recycleStepIds = new Set<string>();
    visibleSteps.forEach(step => {
      if (step.dexpiType === 'Source' || step.dexpiType === 'Sink') return;

      const hasSinkOutput = [...(downstream.get(step.id) || [])]
        .some(targetId => stepById.get(targetId)?.dexpiType === 'Sink');
      if (hasSinkOutput) return;

      const currentLayer = layer.get(step.id) ?? 0;
      const returnTargets = [...(downstream.get(step.id) || [])]
        .filter(targetId => {
          const target = stepById.get(targetId);
          return target && target.dexpiType !== 'Sink' && (layer.get(targetId) ?? 0) < currentLayer;
        });

      if (returnTargets.length === 0) return;

      recycleStepIds.add(step.id);
      const returnLayer = Math.min(...returnTargets.map(targetId => layer.get(targetId) ?? currentLayer));
      const upstreamLayers = [...(upstream.get(step.id) || [])]
        .map(sourceId => layer.get(sourceId))
        .filter((value): value is number => value !== undefined);
      const feedLayer = upstreamLayers.length > 0 ? Math.max(...upstreamLayers) : currentLayer;
      const midpointLayer = Math.round((returnLayer + feedLayer) / 2);
      const branchLayer = Math.max(returnLayer + 1, Math.min(feedLayer - 1, midpointLayer));
      layer.set(step.id, branchLayer);
    });

    processRoots.forEach(id => layer.set(id, 1));
    const sinkLayer = Math.max(1, ...visibleSteps
      .filter(step => step.dexpiType !== 'Sink')
      .map(step => layer.get(step.id) ?? 0)) + 1;
    sinks.forEach(id => layer.set(id, sinkLayer));

    // Generic rule: instrumentation tasks (MeasuringProcessVariable, Controlling…
    // etc) are repositioned by positionInstrumentationActivities into top/bottom
    // bands aligned with their connected flow tasks. They should NOT claim an X
    // layer slot, otherwise they leave a gap that pushes downstream tasks/sinks
    // far to the right when they're moved out of the main grid.
    const byLayer = new Map<number, string[]>();
    visibleSteps.forEach(step => {
      if (this.isInstrumentationStep(step)) return;
      const l = layer.get(step.id) ?? 0;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(step.id);
    });

    const sortedLayers = Array.from(byLayer.keys()).sort((a, b) => a - b);
    const initialOrder = new Map(visibleSteps.map((step, index) => [step.id, index]));
    const yOrder = new Map<string, number>();

    const activityLane = (id: string) => {
      const step = stepById.get(id);
      if (!step || step.dexpiType === 'Source' || step.dexpiType === 'Sink') return 1;
      if (recycleStepIds.has(id)) return 0;

      const nonSinkOutputs = [...(downstream.get(id) || [])]
        .filter(targetId => stepById.get(targetId)?.dexpiType !== 'Sink');
      const hasForwardNonSinkOutput = nonSinkOutputs
        .some(targetId => (layer.get(targetId) ?? 0) > (layer.get(id) ?? 0));
      if (sinkAdjacent.has(id) && !hasForwardNonSinkOutput) return 2;

      return 1;
    };

    const branchLane = (id: string) => {
      const step = stepById.get(id);
      if (!step) return 1;

      if (step.dexpiType === 'Source') {
        const targets = [...(downstream.get(id) || [])];
        if (targets.length === 0) return 1;
        return Math.round(targets.reduce((sum, targetId) => sum + activityLane(targetId), 0) / targets.length);
      }

      if (step.dexpiType === 'Sink') {
        const sourcesForSink = [...(upstream.get(id) || [])];
        if (sourcesForSink.length === 0) return 1;
        return Math.round(sourcesForSink.reduce((sum, sourceId) => sum + activityLane(sourceId), 0) / sourcesForSink.length);
      }

      return activityLane(id);
    };

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
          // Generic rule: when source labels share a common alphabetic prefix
          // and differ only by numeric suffix (e.g. MI1, MI2, MI3, ..., or
          // EEI1, TEI1, ...), sort by the numeric suffix. This preserves the
          // user's port-naming intent regardless of any downstream-layer
          // ambiguity (which can otherwise reorder them based on which inner
          // port the boundary proxy bound to). Falls back to sourceScore +
          // alphabetic when labels don't fit the suffix-numbered pattern.
          const labelA = stepById.get(a)?.label || a;
          const labelB = stepById.get(b)?.label || b;
          const suffixA = labelA.match(/^([A-Za-z]+)(\d+)$/);
          const suffixB = labelB.match(/^([A-Za-z]+)(\d+)$/);
          if (suffixA && suffixB && suffixA[1] === suffixB[1]) {
            return parseInt(suffixA[2], 10) - parseInt(suffixB[2], 10);
          }
          const delta = sourceScore(a) - sourceScore(b);
          if (delta !== 0) return delta;
          return labelA.localeCompare(labelB);
        }
        if (ta === 'Source' && tb !== 'Source') return -1;
        if (tb === 'Source' && ta !== 'Source') return 1;
        if (ta === 'Sink' && tb === 'Sink') {
          // Same generic rule as sources: numeric port-suffix sort when labels
          // share an alphabetic prefix (MO1, MO2, ...).
          const labelA = stepById.get(a)?.label || a;
          const labelB = stepById.get(b)?.label || b;
          const suffixA = labelA.match(/^([A-Za-z]+)(\d+)$/);
          const suffixB = labelB.match(/^([A-Za-z]+)(\d+)$/);
          if (suffixA && suffixB && suffixA[1] === suffixB[1]) {
            return parseInt(suffixA[2], 10) - parseInt(suffixB[2], 10);
          }
          return labelA.localeCompare(labelB);
        }
        if (ta === 'Sink' && tb !== 'Sink') return 1;
        if (tb === 'Sink' && ta !== 'Sink') return -1;

        const laneDelta = branchLane(a) - branchLane(b);
        if (laneDelta !== 0) return laneDelta;

        const barycenter = (id: string) => {
          const refs = [...(upstream.get(id) || [])].filter(ref => yOrder.has(ref));
          if (refs.length === 0) return initialOrder.get(id) ?? 0;
          return refs.reduce((sum, ref) => sum + (yOrder.get(ref) ?? 0), 0) / refs.length;
        };

        const delta = barycenter(a) - barycenter(b);
        return delta !== 0 ? delta : a.localeCompare(b);
      });

      const x = MARGIN_X + layerPosition * (TASK_W + H_GAP);
      const laneTotals = new Map<number, number>();
      ids.forEach(id => {
        const lane = branchLane(id);
        laneTotals.set(lane, (laneTotals.get(lane) ?? 0) + 1);
      });
      const laneCounts = new Map<number, number>();

      ids.forEach(id => {
        const step = stepById.get(id)!;
        const isEvent = step.dexpiType === 'Source' || step.dexpiType === 'Sink';
        const w = isEvent ? EVENT_D : TASK_W;
        const h = isEvent ? EVENT_D : TASK_H;
        const lane = branchLane(id);
        const laneIndex = laneCounts.get(lane) ?? 0;
        const laneTotal = laneTotals.get(lane) ?? 1;
        laneCounts.set(lane, laneIndex + 1);

        const laneGap = TASK_H + V_GAP;
        const stackGap = isEvent ? EVENT_D + 70 : TASK_H + 55;
        const stackOffset = (laneIndex - (laneTotal - 1) / 2) * stackGap;
        const yOffset = isEvent ? (TASK_H - EVENT_D) / 2 : 0;
        const y = MARGIN_Y + lane * laneGap + stackOffset + yOffset;
        layout.set(id, { x, y, w, h });
        yOrder.set(id, y);
      });
    });

    // Instrumentation steps were excluded from byLayer above. Give them a
    // placeholder layout entry so positionInstrumentationActivities can pick
    // them up and move them to the proper top/bottom band.
    visibleSteps.forEach(step => {
      if (!this.isInstrumentationStep(step) || layout.has(step.id)) return;
      layout.set(step.id, { x: MARGIN_X, y: MARGIN_Y, w: TASK_W, h: TASK_H });
    });

    this.positionInstrumentationActivities(visibleSteps, connections, layout, hiddenStepIds);

    // Generic rule: place energy-port boundary proxy events (TEI/TEO/MEI/MEO/
    // EEI/EEO sources/sinks at a subprocess boundary) above or below the
    // interior task they connect to, instead of mixing them into the left/right
    // material flow.
    this.positionEnergyBoundaryProxies(
      visibleSteps.filter(step => energyBoundaryProxies.has(step.id)),
      connections,
      layout,
      portToStep
    );

    return layout;
  }

  /**
   * Move energy boundary proxies (sources/sinks for energy ports at a
   * subprocess boundary) above or below the interior task they connect to.
   * This is a no-op for proxies whose connected task isn't laid out (e.g.
   * disconnected boundary).
   */
  private positionEnergyBoundaryProxies(
    proxies: DexpiStep[],
    connections: DexpiConnection[],
    layout: Map<string, LayoutBox>,
    portToStep: Map<string, string>
  ): void {
    if (proxies.length === 0) return;

    const placedByAnchor = new Map<string, number>();
    proxies.forEach(proxy => {
      const port = proxy.ports[0];
      if (!port) return;

      // Find the interior task this proxy connects to.
      const connection = connections.find(conn =>
        !conn.hidden &&
        conn.dexpiType !== 'InformationFlow' &&
        (conn.sourcePortId === port.id || conn.targetPortId === port.id)
      );
      if (!connection) return;

      const otherPortId = connection.sourcePortId === port.id ? connection.targetPortId : connection.sourcePortId;
      const otherStepId = portToStep.get(otherPortId);
      if (!otherStepId) return;
      const otherPos = layout.get(otherStepId);
      if (!otherPos) return;

      // Generic rule: a Source supplies energy that flows DOWN into the
      // consumer — draw the Source ABOVE. A Sink absorbs energy flowing UP
      // from the producer — draw it BELOW. The proxy's own port direction
      // doesn't matter for placement; only its role (Source vs Sink) does.
      const placeAbove = proxy.dexpiType === 'Source';
      const w = EVENT_D;
      const h = EVENT_D;
      const y = placeAbove
        ? otherPos.y - h - ENERGY_BAND_GAP
        : otherPos.y + otherPos.h + ENERGY_BAND_GAP;

      // Stagger horizontally if multiple proxies attach to the same task on the
      // same side, so their circles don't overlap.
      const anchorKey = `${otherStepId}:${placeAbove ? 'top' : 'bottom'}`;
      const stack = placedByAnchor.get(anchorKey) ?? 0;
      placedByAnchor.set(anchorKey, stack + 1);
      const slotWidth = w + 24;
      const stackOffset = stack * slotWidth;
      const baseX = otherPos.x + (otherPos.w - w) / 2;
      const x = baseX + (stack === 0 ? 0 : (stack % 2 === 1 ? stackOffset : -stackOffset));

      layout.set(proxy.id, { x, y, w, h });
    });
  }

  // ── BPMN builder ────────────────────────────────────────────────────────────

  private buildBpmn(parsed: ParsedDexpi, layout: Map<string, LayoutBox>): string {
    const { steps, connections, materialTemplates } = parsed;

    // Build port → step map for resolving connection endpoints
    const portToStep = new Map<string, string>();
    steps.forEach(s => s.ports.forEach(p => portToStep.set(p.id, s.id)));
    const stepById = new Map(steps.map(s => [s.id, s]));
    const hiddenStepIds = new Set(steps
      .filter(step => !step.parentId && this.isPortProxyStep(step))
      .map(step => step.id));

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
    const seqFlows = connections.filter(c => !c.hidden && c.dexpiType !== 'InformationFlow' && !isHiddenConnection(c));
    const infoFlows = connections.filter(c => !c.hidden && c.dexpiType === 'InformationFlow' && !isHiddenConnection(c));

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

    const stepOwnerKey = (stepId: string) => ownerKey(stepById.get(stepId)?.parentId);
    const visibleSeqFlowsForStep = (stepId: string, direction: 'incoming' | 'outgoing') =>
      seqFlows.filter(conn => {
        const src = portToStep.get(conn.sourcePortId);
        const tgt = portToStep.get(conn.targetPortId);
        return direction === 'incoming' ? tgt === stepId : src === stepId;
      });

    const recycleStepIds = new Set<string>();
    steps
      .filter(step => !hiddenStepIds.has(step.id) && step.dexpiType !== 'Source' && step.dexpiType !== 'Sink')
      .forEach(step => {
        const owner = stepOwnerKey(step.id);
        const ownerLayout = ownerLayouts.get(owner) || layout;
        const stepPos = ownerLayout.get(step.id);
        if (!stepPos) return;

        const incomingFromRight = visibleSeqFlowsForStep(step.id, 'incoming').some(conn => {
          const src = portToStep.get(conn.sourcePortId);
          if (!src || stepOwnerKey(src) !== owner) return false;
          const srcPos = ownerLayout.get(src);
          return srcPos ? srcPos.x > stepPos.x : false;
        });
        const outgoingToLeft = visibleSeqFlowsForStep(step.id, 'outgoing').some(conn => {
          const tgt = portToStep.get(conn.targetPortId);
          if (!tgt || stepOwnerKey(tgt) !== owner) return false;
          const tgtPos = ownerLayout.get(tgt);
          return tgtPos ? tgtPos.x < stepPos.x : false;
        });
        const outgoingToSink = visibleSeqFlowsForStep(step.id, 'outgoing').some(conn => {
          const tgt = portToStep.get(conn.targetPortId);
          return tgt ? stepById.get(tgt)?.dexpiType === 'Sink' : false;
        });

        if (incomingFromRight && outgoingToLeft && !outgoingToSink) {
          recycleStepIds.add(step.id);
        }
      });

    type EndpointRole = 'source' | 'target';
    type Anchor = { side: EdgeSide; offset: number; yNudge?: number; xNudge?: number };
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const isEnergyPortFn = (port: DexpiPort | undefined) => this.isEnergyPort(port);

    /**
     * Generic rule: choose which edge of the task box a port should anchor on,
     * based purely on port type/direction and whether the owning step is part
     * of a recycle loop (which inverts left/right).
     *
     *   energy ports (Thermal/Mechanical/Electrical or labelled TEI/TEO/MEI/...):
     *     Inlet  → top
     *     Outlet → bottom
     *   recycle steps:
     *     Inlet  → right   (so the return line enters on the recycle side)
     *     Outlet → left
     *   everything else (material + information ports):
     *     Inlet  → left
     *     Outlet → right
     */
    const preferredEdgeSide = (
      port: DexpiPort | undefined,
      isRecycleStep: boolean
    ): EdgeSide => {
      const bpmnDir = port?.direction === 'Outlet' ? 'Outlet' : 'Inlet';
      if (isEnergyPortFn(port)) return bpmnDir === 'Outlet' ? 'bottom' : 'top';
      if (isRecycleStep) return bpmnDir === 'Outlet' ? 'left' : 'right';
      return bpmnDir === 'Outlet' ? 'right' : 'left';
    };
    const isVisualPortLabel = (label?: string) =>
      !!label && (
        /^(MI|MO|TEI|TEO|MEI|MEO|EEI|EEO)\d+$/i.test(label) ||
        /^IP[IO]_/i.test(label)
      );
    const streamEndpointLabels = (label: string) => {
      const parts = label.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
      if (parts.length < 2) return {};

      const source = parts[0];
      const target = parts[parts.length - 1];
      return {
        source: isVisualPortLabel(source) ? source : undefined,
        target: isVisualPortLabel(target) ? target : undefined,
      };
    };
    const endpointPort = (conn: DexpiConnection, role: EndpointRole) => {
      const portId = role === 'source' ? conn.sourcePortId : conn.targetPortId;
      const stepId = portToStep.get(portId);
      const step = stepId ? stepById.get(stepId) : undefined;
      const port = step?.ports.find(p => p.id === portId);
      return { portId, stepId, step, port };
    };
    const visualEndpointLabel = (conn: DexpiConnection, role: EndpointRole, port?: DexpiPort) =>
      streamEndpointLabels(conn.label)[role] || port?.label || (role === 'source' ? conn.sourcePortId : conn.targetPortId);
    const visualEndpointKey = (conn: DexpiConnection, role: EndpointRole) => {
      const { portId, stepId, port } = endpointPort(conn, role);
      const bpmnDir = port?.direction === 'Outlet' ? 'Outlet' : 'Inlet';
      const portKind = port?.type || 'MaterialPort';
      return `${stepId || ''}:${role}:${bpmnDir}:${portKind}:${visualEndpointLabel(conn, role, port) || portId}`;
    };

    const connectedOtherPos = (step: DexpiStep, port: DexpiPort): LayoutBox[] => {
      const owner = stepOwnerKey(step.id);
      const ownerLayout = ownerLayouts.get(owner) || layout;
      const isOutlet = port.direction === 'Outlet';
      return seqFlows
        .map(conn => {
          if (isOutlet && conn.sourcePortId !== port.id) return undefined;
          if (!isOutlet && conn.targetPortId !== port.id) return undefined;
          const otherStepId = isOutlet
            ? portToStep.get(conn.targetPortId)
            : portToStep.get(conn.sourcePortId);
          if (!otherStepId || stepOwnerKey(otherStepId) !== owner) return undefined;
          return ownerLayout.get(otherStepId);
        })
        .filter((value): value is LayoutBox => !!value);
    };

    const connectedPortY = (step: DexpiStep, port: DexpiPort): number | undefined => {
      const others = connectedOtherPos(step, port);
      if (others.length === 0) return undefined;
      return others.reduce((sum, box) => sum + box.y + box.h / 2, 0) / others.length;
    };

    const connectedPortX = (step: DexpiStep, port: DexpiPort): number | undefined => {
      const others = connectedOtherPos(step, port);
      if (others.length === 0) return undefined;
      return others.reduce((sum, box) => sum + box.x + box.w / 2, 0) / others.length;
    };

    /**
     * Generic rule: when distributing multiple anchors along the same edge of a
     * task, the offset is along Y for left/right edges and along X for
     * top/bottom edges. Returns the connected partner's position on the
     * relevant axis (for ordering / desired offset computation).
     */
    const connectedAxisPos = (step: DexpiStep, port: DexpiPort, side: EdgeSide): number | undefined => {
      return side === 'top' || side === 'bottom'
        ? connectedPortX(step, port)
        : connectedPortY(step, port);
    };
    const stepAxisStart = (pos: LayoutBox, side: EdgeSide) =>
      side === 'top' || side === 'bottom' ? pos.x : pos.y;
    const stepAxisLength = (pos: LayoutBox, side: EdgeSide) =>
      side === 'top' || side === 'bottom' ? pos.w : pos.h;

    const connectionAnchor = (
      step: DexpiStep | undefined,
      portId: string,
      conn: DexpiConnection,
      role: EndpointRole
    ): Anchor => {
      if (!step) return { side: 'left', offset: 0.5 };

      const port = step.ports.find(p => p.id === portId);
      const isRecycleStep = recycleStepIds.has(step.id);
      const side = preferredEdgeSide(port, isRecycleStep);
      const bpmnDir = port?.direction === 'Outlet' ? 'Outlet' : 'Inlet';
      const isInfoPort = port?.type === 'InformationPort';
      const owner = stepOwnerKey(step.id);
      const ownerLayout = ownerLayouts.get(owner) || layout;
      const stepPos = ownerLayout.get(step.id);
      const axisStart = stepPos ? stepAxisStart(stepPos, side) : 0;
      const axisLength = stepPos ? stepAxisLength(stepPos, side) : 1;
      const records = new Map<string, { firstIndex: number; linked: number[] }>();

      seqFlows.forEach((candidate, candidateIndex) => {
        const roles: EndpointRole[] = [];
        if (portToStep.get(candidate.sourcePortId) === step.id) roles.push('source');
        if (portToStep.get(candidate.targetPortId) === step.id) roles.push('target');

        roles.forEach(candidateRole => {
          const candidatePortId = candidateRole === 'source' ? candidate.sourcePortId : candidate.targetPortId;
          const candidatePort = step.ports.find(p => p.id === candidatePortId);
          if (!candidatePort) return;
          // Group only ports that share an edge with the current port; offsets
          // are distributed independently per edge side.
          if (preferredEdgeSide(candidatePort, isRecycleStep) !== side) return;
          const candidateDir = candidatePort.direction === 'Outlet' ? 'Outlet' : 'Inlet';
          if (candidateDir !== bpmnDir) return;
          const candidateIsInfo = candidatePort.type === 'InformationPort';
          if (candidateIsInfo !== !!isInfoPort) return;

          const otherStepId = candidateRole === 'source'
            ? portToStep.get(candidate.targetPortId)
            : portToStep.get(candidate.sourcePortId);
          const otherPos = otherStepId && stepOwnerKey(otherStepId) === owner
            ? ownerLayout.get(otherStepId)
            : undefined;
          const key = visualEndpointKey(candidate, candidateRole);
          const record = records.get(key) || { firstIndex: candidateIndex, linked: [] };
          if (otherPos) {
            record.linked.push(side === 'top' || side === 'bottom'
              ? otherPos.x + otherPos.w / 2
              : otherPos.y + otherPos.h / 2);
          }
          record.firstIndex = Math.min(record.firstIndex, candidateIndex);
          records.set(key, record);
        });
      });

      if (records.size <= 1) {
        let offset = 0.5;
        if (isRecycleStep && (side === 'left' || side === 'right')) {
          offset = bpmnDir === 'Outlet' ? 0.35 : 0.65;
        }
        return { side, offset };
      }

      const orderedRecords = [...records.entries()].sort(([, a], [, b]) => {
        const aPos = a.linked.length > 0 ? a.linked.reduce((sum, v) => sum + v, 0) / a.linked.length : undefined;
        const bPos = b.linked.length > 0 ? b.linked.reduce((sum, v) => sum + v, 0) / b.linked.length : undefined;
        if (aPos !== undefined && bPos !== undefined && aPos !== bPos) return aPos - bPos;
        if (aPos !== undefined && bPos === undefined) return -1;
        if (aPos === undefined && bPos !== undefined) return 1;
        return a.firstIndex - b.firstIndex;
      });
      const desiredOffsets = orderedRecords.map(([, record], groupIdx) => {
        if (axisLength > 0 && record.linked.length > 0) {
          const linkedAxis = record.linked.reduce((sum, v) => sum + v, 0) / record.linked.length;
          return clamp((linkedAxis - axisStart) / axisLength, 0.12, 0.88);
        }
        return (groupIdx + 1) / (orderedRecords.length + 1);
      });

      const minOffset = 0.12;
      const maxOffset = 0.88;
      const minSpacing = Math.min(0.16, (maxOffset - minOffset) / (orderedRecords.length - 1));
      for (let i = 0; i < desiredOffsets.length; i += 1) {
        desiredOffsets[i] = clamp(desiredOffsets[i], minOffset, maxOffset);
        if (i > 0) desiredOffsets[i] = Math.max(desiredOffsets[i], desiredOffsets[i - 1] + minSpacing);
      }
      for (let i = desiredOffsets.length - 1; i >= 0; i -= 1) {
        desiredOffsets[i] = clamp(desiredOffsets[i], minOffset, maxOffset);
        if (i < desiredOffsets.length - 1) desiredOffsets[i] = Math.min(desiredOffsets[i], desiredOffsets[i + 1] - minSpacing);
      }

      const key = visualEndpointKey(conn, role);
      const idx = Math.max(0, orderedRecords.findIndex(([recordKey]) => recordKey === key));
      return { side, offset: desiredOffsets[idx] ?? 0.5 };
    };

    const portAnchor = (step: DexpiStep | undefined, portId: string): { side: EdgeSide; offset: number } => {
      if (!step) return { side: 'left', offset: 0.5 };

      const port = step.ports.find(p => p.id === portId);
      const bpmnDir = port?.direction === 'Outlet' ? 'Outlet' : 'Inlet';
      const isRecycleStep = recycleStepIds.has(step.id);
      const side = preferredEdgeSide(port, isRecycleStep);
      const isInfoPort = port?.type === 'InformationPort';
      // Group only ports that share the same edge — distribution is per-edge.
      const group = step.ports.filter(p => {
        if ((p.direction === 'Outlet' ? 'Outlet' : 'Inlet') !== bpmnDir) return false;
        if ((p.type === 'InformationPort') !== !!isInfoPort) return false;
        return preferredEdgeSide(p, isRecycleStep) === side;
      });
      // Generic rule: order ports along the edge by their connected partner's
      // axis position. Ports without any connection fall back to the same
      // numeric-suffix sort used for sources/sinks (MI1 < MI2 < … MO1 < MO2)
      // so unused ports don't end up in arbitrary positions disrupting the
      // visual port stack.
      const labelOrderKey = (p: DexpiPort) => {
        const m = (p.label || '').match(/^([A-Za-z]+)(\d+)$/);
        return m ? { prefix: m[1], num: parseInt(m[2], 10) } : null;
      };
      const orderedGroup = isInfoPort ? group : [...group].sort((a, b) => {
        const aPos = connectedAxisPos(step, a, side);
        const bPos = connectedAxisPos(step, b, side);
        if (aPos !== undefined && bPos !== undefined && aPos !== bPos) return aPos - bPos;
        // Both connected at same axis or both disconnected → sort by label
        // suffix, then by initial group order.
        const aKey = labelOrderKey(a);
        const bKey = labelOrderKey(b);
        if (aKey && bKey && aKey.prefix === bKey.prefix) return aKey.num - bKey.num;
        if (aPos !== undefined && bPos === undefined) return -1;
        if (aPos === undefined && bPos !== undefined) return 1;
        return group.findIndex(p => p.id === a.id) - group.findIndex(p => p.id === b.id);
      });
      const idx = Math.max(0, orderedGroup.findIndex(p => p.id === portId));

      const stepPos = (ownerLayouts.get(stepOwnerKey(step.id)) || layout).get(step.id);
      const axisStart = stepPos ? stepAxisStart(stepPos, side) : 0;
      const axisLength = stepPos ? stepAxisLength(stepPos, side) : 1;
      const desiredOffsets = orderedGroup.map((p, groupIdx) => {
        const connected = !isInfoPort && stepPos ? connectedAxisPos(step, p, side) : undefined;
        if (connected !== undefined && axisLength > 0) {
          return clamp((connected - axisStart) / axisLength, 0.12, 0.88);
        }
        return orderedGroup.length <= 1 ? 0.5 : (groupIdx + 1) / (orderedGroup.length + 1);
      });

      if (orderedGroup.length > 1) {
        const minOffset = 0.12;
        const maxOffset = 0.88;
        const minSpacing = Math.min(0.16, (maxOffset - minOffset) / (orderedGroup.length - 1));
        for (let i = 0; i < desiredOffsets.length; i += 1) {
          desiredOffsets[i] = clamp(desiredOffsets[i], minOffset, maxOffset);
          if (i > 0) desiredOffsets[i] = Math.max(desiredOffsets[i], desiredOffsets[i - 1] + minSpacing);
        }
        for (let i = desiredOffsets.length - 1; i >= 0; i -= 1) {
          desiredOffsets[i] = clamp(desiredOffsets[i], minOffset, maxOffset);
          if (i < desiredOffsets.length - 1) desiredOffsets[i] = Math.min(desiredOffsets[i], desiredOffsets[i + 1] - minSpacing);
        }
      }

      let offset = desiredOffsets[idx] ?? 0.5;
      if (isRecycleStep && orderedGroup.length <= 1 && (side === 'left' || side === 'right')) {
        // Separate the single recycle inlet and outlet so return lines do not read as one continuous stroke.
        offset = bpmnDir === 'Outlet' ? 0.35 : 0.65;
      }

      return { side, offset };
    };

    const connectionPoint = (pos: LayoutBox, anchor: Anchor) => {
      if (anchor.side === 'top') {
        return {
          x: clamp(pos.x + pos.w * anchor.offset + (anchor.xNudge ?? 0), pos.x, pos.x + pos.w),
          y: pos.y,
        };
      }
      if (anchor.side === 'bottom') {
        return {
          x: clamp(pos.x + pos.w * anchor.offset + (anchor.xNudge ?? 0), pos.x, pos.x + pos.w),
          y: pos.y + pos.h,
        };
      }
      return {
        x: anchor.side === 'left' ? pos.x : pos.x + pos.w,
        y: clamp(pos.y + pos.h * anchor.offset + (anchor.yNudge ?? 0), pos.y, pos.y + pos.h),
      };
    };

    type Waypoint = { x: number; y: number };
    const horizontalIntersections = (
      x1: number,
      x2: number,
      y: number,
      obstacles: LayoutBox[],
      padding = 12
    ) => {
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      return obstacles.filter(box =>
        maxX > box.x - padding &&
        minX < box.x + box.w + padding &&
        y >= box.y - padding &&
        y <= box.y + box.h + padding
      );
    };

    const segmentIntersectsObstacle = (
      a: Waypoint,
      b: Waypoint,
      obstacles: LayoutBox[],
      padding = 12
    ) => {
      if (a.y === b.y) {
        return horizontalIntersections(a.x, b.x, a.y, obstacles, padding).length > 0;
      }

      if (a.x === b.x) {
        const minY = Math.min(a.y, b.y);
        const maxY = Math.max(a.y, b.y);
        return obstacles.some(box =>
          a.x >= box.x - padding &&
          a.x <= box.x + box.w + padding &&
          maxY > box.y - padding &&
          minY < box.y + box.h + padding
        );
      }

      return false;
    };

    const routeIntersectsObstacle = (points: Waypoint[], obstacles: LayoutBox[]) =>
      points.some((point, index) => index > 0 && segmentIntersectsObstacle(points[index - 1], point, obstacles));

    const simplifyWaypoints = (points: Waypoint[]) => {
      const withoutDuplicates = points.filter((point, index) => {
        const previous = points[index - 1];
        return !previous || previous.x !== point.x || previous.y !== point.y;
      });

      return withoutDuplicates.filter((point, index) => {
        if (index === 0 || index === withoutDuplicates.length - 1) return true;
        const previous = withoutDuplicates[index - 1];
        const next = withoutDuplicates[index + 1];
        const vertical = previous.x === point.x && point.x === next.x;
        const horizontal = previous.y === point.y && point.y === next.y;
        return !(vertical || horizontal);
      });
    };

    const routeSequenceFlow = (
      srcPos: LayoutBox,
      tgtPos: LayoutBox,
      lane: number,
      srcAnchor: Anchor,
      tgtAnchor: Anchor,
      obstacles: LayoutBox[]
    ) => {
      const srcPoint = connectionPoint(srcPos, srcAnchor);
      const tgtPoint = connectionPoint(tgtPos, tgtAnchor);
      const srcX = srcPoint.x;
      const srcY = srcPoint.y;
      const tgtX = tgtPoint.x;
      const tgtY = tgtPoint.y;
      const laneOffset = (lane % 6) * 18;

      // Generic rule: when either endpoint anchors on a top/bottom edge, route
      // with a stub-corner-stub pattern. The stub direction is dictated by the
      // edge so the connection visibly enters/exits perpendicular to the box.
      if (srcAnchor.side === 'top' || srcAnchor.side === 'bottom' ||
          tgtAnchor.side === 'top' || tgtAnchor.side === 'bottom') {
        const stub = 30 + laneOffset;
        const stubFor = (point: Waypoint, side: EdgeSide): Waypoint => {
          if (side === 'left')   return { x: point.x - stub, y: point.y };
          if (side === 'right')  return { x: point.x + stub, y: point.y };
          if (side === 'top')    return { x: point.x, y: point.y - stub };
          return { x: point.x, y: point.y + stub };  // bottom
        };
        const srcStub = stubFor(srcPoint, srcAnchor.side);
        const tgtStub = stubFor(tgtPoint, tgtAnchor.side);

        // For mixed sides, insert a single corner so the line travels along
        // the dominant axis between the stubs without re-entering either box.
        const srcVertical = srcAnchor.side === 'top' || srcAnchor.side === 'bottom';
        const tgtVertical = tgtAnchor.side === 'top' || tgtAnchor.side === 'bottom';

        let mid: Waypoint;
        if (srcVertical && tgtVertical) {
          // both top/bottom — go vertical from src, horizontal across, vertical into tgt
          mid = { x: tgtStub.x, y: srcStub.y };
        } else if (!srcVertical && !tgtVertical) {
          // both left/right — fall through to existing logic below
          mid = { x: tgtStub.x, y: srcStub.y };
        } else if (srcVertical) {
          // src vertical, tgt horizontal — first horizontal from tgtStub, then vertical to srcStub
          mid = { x: srcStub.x, y: tgtStub.y };
        } else {
          // src horizontal, tgt vertical
          mid = { x: tgtStub.x, y: srcStub.y };
        }

        return [srcPoint, srcStub, mid, tgtStub, tgtPoint];
      }

      if (srcAnchor.side === 'right' && tgtAnchor.side === 'left' && tgtX >= srcX + 50) {
        const bendX = Math.max(srcX + 35, tgtX - 60 - laneOffset);
        const directRoute = [
          { x: srcX, y: srcY },
          { x: bendX, y: srcY },
          { x: bendX, y: tgtY },
          { x: tgtX, y: tgtY },
        ];

        if (!routeIntersectsObstacle(directRoute, obstacles)) {
          return directRoute;
        }

        const crossed = [
          ...horizontalIntersections(srcX, bendX, srcY, obstacles),
          ...horizontalIntersections(bendX, tgtX, tgtY, obstacles),
        ];
        const relevant = crossed.length > 0 ? crossed : obstacles;
        const topLane = Math.min(srcY, tgtY, ...relevant.map(box => box.y)) - 45 - laneOffset;
        const bottomLane = Math.max(srcY, tgtY, ...relevant.map(box => box.y + box.h)) + 45 + laneOffset;
        const sourceCenterY = srcPos.y + srcPos.h / 2;
        const targetCenterY = tgtPos.y + tgtPos.h / 2;
        const detourY = targetCenterY > sourceCenterY ? bottomLane : topLane;
        const exitX = srcX + 35 + laneOffset;
        const entryMin = srcX + 35;
        const entryMax = Math.max(entryMin, tgtX - 25);
        const entryX = clamp(tgtX - 60 - laneOffset, entryMin, entryMax);

        return [
          { x: srcX, y: srcY },
          { x: exitX, y: srcY },
          { x: exitX, y: detourY },
          { x: entryX, y: detourY },
          { x: entryX, y: tgtY },
          { x: tgtX, y: tgtY },
        ];
      }

      if (srcAnchor.side === 'right' && tgtAnchor.side === 'left' && srcX > tgtX) {
        const corridorX = Math.max(srcX, tgtX) + 45 + laneOffset;
        return [
          { x: srcX, y: srcY },
          { x: corridorX, y: srcY },
          { x: corridorX, y: tgtY },
          { x: tgtX, y: tgtY },
        ];
      }

      if (srcAnchor.side === 'left' && tgtAnchor.side === 'right' && srcX < tgtX) {
        const corridorX = Math.min(srcX, tgtX) - 45 - laneOffset;
        return [
          { x: srcX, y: srcY },
          { x: corridorX, y: srcY },
          { x: corridorX, y: tgtY },
          { x: tgtX, y: tgtY },
        ];
      }

      if (srcAnchor.side === tgtAnchor.side) {
        const corridorPadding = 45 + laneOffset;
        const corridorX = srcAnchor.side === 'left'
          ? Math.min(srcX, tgtX) - corridorPadding
          : Math.max(srcX, tgtX) + corridorPadding;
        return [
          { x: srcX, y: srcY },
          { x: corridorX, y: srcY },
          { x: corridorX, y: tgtY },
          { x: tgtX, y: tgtY },
        ];
      }

      const srcDetourX = srcAnchor.side === 'right'
        ? srcX + 60 + laneOffset
        : srcX - 60 - laneOffset;
      const tgtDetourX = tgtAnchor.side === 'right'
        ? tgtX + 60 + laneOffset
        : tgtX - 60 - laneOffset;
      const detourY = Math.min(srcPos.y, tgtPos.y, srcY, tgtY) - 55 - laneOffset;
      return [
        { x: srcX, y: srcY },
        { x: srcDetourX, y: srcY },
        { x: srcDetourX, y: detourY },
        { x: tgtDetourX, y: detourY },
        { x: tgtDetourX, y: tgtY },
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
      const portsXml = step.ports.map(p => {
        const bpmnDir = p.direction === 'Outlet' ? 'Outlet' : 'Inlet';
        const anchor = portAnchor(step, p.id);
        const subReference = p.subPortIds && p.subPortIds.length > 0 ? ` subReference="${p.subPortIds.join(' ')}"` : '';
        const superReference = p.superPortId ? ` superReference="${p.superPortId}"` : '';
        return `${indent}    <dexpi:port portId="${p.id}" name="${p.label}" portType="${p.type}" direction="${bpmnDir}" label="${p.label}" anchorSide="${anchor.side}" anchorOffset="${anchor.offset.toFixed(2)}"${subReference}${superReference}/>`;
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

    // Build per-port share counts to sub-distribute waypoints when multiple
    // streams share the same physical port (e.g. 5 feeds all entering MI1).
    type PortShare = { total: number; next: number };
    const portShareIndex = new Map<string, PortShare>();
    seqFlows.forEach(conn => {
      for (const key of [visualEndpointKey(conn, 'source'), visualEndpointKey(conn, 'target')]) {
        if (!portShareIndex.has(key)) portShareIndex.set(key, { total: 0, next: 0 });
        portShareIndex.get(key)!.total++;
      }
    });

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
    <dexpi:Stream uid="${conn.id}" identifier="${conn.identifier}"${streamTypeAttr} sourcePortRef="${conn.sourcePortId}" targetPortRef="${conn.targetPortId}"/>
  </bpmn:extensionElements>
</bpmn:sequenceFlow>`);

      const ownerLayout = ownerLayouts.get(key) || layout;
      const srcPos = ownerLayout.get(src);
      const tgtPos = ownerLayout.get(tgt);
      if (!srcPos || !tgtPos) return;

      const srcAnchor = connectionAnchor(srcStep, conn.sourcePortId, conn, 'source');
      const tgtAnchor = connectionAnchor(tgtStep, conn.targetPortId, conn, 'target');

      // Sub-distribute waypoints: if multiple streams share a port, stagger
      // their connection points by ±spread px so they're visually distinct.
      const SPREAD = 12;
      const withNudge = (shareKey: string, anchor: Anchor): Anchor => {
        const share = portShareIndex.get(shareKey);
        if (!share || share.total <= 1) return anchor;
        const idx = share.next++;
        const totalSpread = (share.total - 1) * SPREAD;
        const nudge = idx * SPREAD - totalSpread / 2;
        // Top/bottom anchors stagger horizontally; left/right anchors vertically.
        return anchor.side === 'top' || anchor.side === 'bottom'
          ? { ...anchor, xNudge: nudge }
          : { ...anchor, yNudge: nudge };
      };
      const srcA = withNudge(visualEndpointKey(conn, 'source'), srcAnchor);
      const tgtA = withNudge(visualEndpointKey(conn, 'target'), tgtAnchor);

      const obstacles = [...ownerLayout.entries()]
        .filter(([stepId, box]) => {
          if (stepId === src || stepId === tgt) return false;
          const obstacleStep = stepById.get(stepId);
          if (!obstacleStep || obstacleStep.dexpiType === 'Source' || obstacleStep.dexpiType === 'Sink') return false;
          return box.w > 0 && box.h > 0;
        })
        .map(([, box]) => box);
      const routedWaypoints = routeSequenceFlow(srcPos, tgtPos, nextLane(key), srcA, tgtA, obstacles);
      const rawWaypoints = routedWaypoints.length > 4 ? simplifyWaypoints(routedWaypoints) : routedWaypoints;

      const waypoints = rawWaypoints
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

    // InformationFlows → DataObjectReference + bidirectional associations.
    // One DataObject per (source-port, variable) pair; one output association
    // source→DataObject, then one input association DataObject→target per target.
    const dobjBySourcePort = new Map<string, { dobjId: string; dobjX: number; dobjY: number; key: string }>();
    infoFlows.forEach(conn => {
      const src = portToStep.get(conn.sourcePortId);
      const tgt = portToStep.get(conn.targetPortId);
      if (!src || !tgt) return;
      const srcStep = stepById.get(src);
      const tgtStep = stepById.get(tgt);
      const key = ownerKey(srcStep?.parentId);
      const varName = conn.informationVariantLabel || conn.label;

      let dobjInfo = dobjBySourcePort.get(conn.sourcePortId);
      if (!dobjInfo) {
        const ownerLayout = ownerLayouts.get(key) || layout;
        const srcPos = ownerLayout.get(src);
        const tgtPos = ownerLayout.get(tgt);
        const srcCenter = srcPos
          ? { x: srcPos.x + srcPos.w / 2, y: srcPos.y + srcPos.h / 2 }
          : { x: MARGIN_X + TASK_W / 2, y: MARGIN_Y + TASK_H / 2 };
        const tgtCenter = tgtPos
          ? { x: tgtPos.x + tgtPos.w / 2, y: tgtPos.y + tgtPos.h / 2 }
          : srcCenter;
        const dobjId = `dobj_${bpmnId(src)}_${bpmnId(varName.replace(/[^a-zA-Z0-9]/g, '_'))}`;
        const dobjX = (srcCenter.x + tgtCenter.x) / 2 - 18;
        // Generic rule: prefer the midpoint between source and target centers
        // (natural visual centering between task and instrument bands). But if
        // that midpoint would put the data object on top of ANY flow step in
        // the same column (not just the partner task), shift it vertically to
        // the nearest gap. This avoids data objects landing inside the task
        // row when source/target are in different lanes.
        const dataObjWidth = 36;
        const dataObjHeight = 50;
        const dataObjGap = 12;
        let dobjY = (srcCenter.y + tgtCenter.y) / 2 - dataObjHeight / 2;

        // Build vertical obstacle list from steps overlapping the data object's
        // X range — only those can collide.
        const dataLeft = dobjX;
        const dataRight = dobjX + dataObjWidth;
        const overlappingObstacles = [...ownerLayout.values()]
          .filter(box => box.w > 0 && box.h > 0)
          .filter(box => box.x < dataRight + 4 && box.x + box.w > dataLeft - 4)
          .sort((a, b) => a.y - b.y);

        const intersects = (y: number) =>
          overlappingObstacles.find(box =>
            y + dataObjHeight > box.y - 4 && y < box.y + box.h + 4
          );

        const collide = intersects(dobjY);
        if (collide) {
          // Try below the colliding obstacle, then above. Prefer the side
          // closer to the instrument partner.
          const srcIsInstrument = srcStep && this.isInstrumentationStep(srcStep);
          const tgtIsInstrument = tgtStep && this.isInstrumentationStep(tgtStep);
          const instrumentPos = srcIsInstrument ? srcPos : (tgtIsInstrument ? tgtPos : undefined);
          const preferBelow = instrumentPos
            ? (instrumentPos.y + instrumentPos.h / 2) > (collide.y + collide.h / 2)
            : true;

          const tryShift = (downward: boolean) => {
            let candidate = dobjY;
            for (let i = 0; i < overlappingObstacles.length + 2; i += 1) {
              const c = intersects(candidate);
              if (!c) return candidate;
              candidate = downward
                ? c.y + c.h + dataObjGap
                : c.y - dataObjGap - dataObjHeight;
            }
            return undefined;
          };

          const first = preferBelow ? tryShift(true) : tryShift(false);
          const second = first === undefined
            ? (preferBelow ? tryShift(false) : tryShift(true))
            : undefined;
          if (first !== undefined) dobjY = first;
          else if (second !== undefined) dobjY = second;
        }
        dobjInfo = { dobjId, dobjX, dobjY, key };
        dobjBySourcePort.set(conn.sourcePortId, dobjInfo);

        const assocOutId = `assocOut_${dobjId}`;
        const dataObjectXml = `<bpmn:dataObjectReference id="${dobjId}" name="${varName}" dataObjectRef="DataObject_${dobjId}"/>
  <bpmn:dataObject id="DataObject_${dobjId}"/>
  <bpmn:association id="${assocOutId}" sourceRef="${bpmnId(src)}" targetRef="${dobjId}" associationDirection="One"/>`;
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
          const dobjCenterY = dobjY + 25;
          const srcCenterY = srcPos.y + srcPos.h / 2;
          const dataObjectIsBelowSource = dobjCenterY >= srcCenterY;
          const srcEdgeY = dataObjectIsBelowSource ? srcPos.y + srcPos.h : srcPos.y;
          const dobjEdgeY = dataObjectIsBelowSource ? dobjY : dobjY + 50;
          const edgeOutXml = `      <bpmndi:BPMNEdge id="${assocOutId}_di" bpmnElement="${assocOutId}">
        <di:waypoint x="${srcPos.x + srcPos.w / 2}" y="${srcEdgeY}"/>
        <di:waypoint x="${dobjX + 18}" y="${dobjEdgeY}"/>
      </bpmndi:BPMNEdge>`;
          if (key === rootOwner) {
            edgeElements.push(edgeOutXml);
          } else {
            pushOwned(edgeElementsByOwner, key, edgeOutXml);
          }
        }
      }

      // Input association: DataObject → target task
      const tgtKey = ownerKey(tgtStep?.parentId);
      const assocInId = `assocIn_${bpmnId(conn.id)}`;
      const assocSemanticId = `assocInfo_${bpmnId(conn.id)}`;

      const dataInputXml = `<bpmn:association id="${assocInId}" sourceRef="${dobjInfo.dobjId}" targetRef="${bpmnId(tgt)}" associationDirection="One"/>
<bpmn:association id="${assocSemanticId}" name="${varName}" sourceRef="${bpmnId(src)}" targetRef="${bpmnId(tgt)}" associationDirection="One">
  <bpmn:extensionElements>
    <dexpi:Stream streamType="InformationFlow" uid="${conn.id}" identifier="${conn.identifier}" sourcePortRef="${conn.sourcePortId}" targetPortRef="${conn.targetPortId}"/>
  </bpmn:extensionElements>
</bpmn:association>`;
      if (tgtKey === rootOwner) {
        processElements.push(indentBlock(dataInputXml, '  '));
      } else {
        pushOwned(extraProcessElementsByOwner, tgtKey, dataInputXml);
      }

      const ownerLayout = ownerLayouts.get(tgtKey) || layout;
      const tgtPos = ownerLayout.get(tgt);
      if (tgtPos) {
        const dobjCenterY = dobjInfo.dobjY + 25;
        const tgtCenterY = tgtPos.y + tgtPos.h / 2;
        const dataObjectIsBelowTarget = dobjCenterY >= tgtCenterY;
        const dobjEdgeY = dataObjectIsBelowTarget ? dobjInfo.dobjY : dobjInfo.dobjY + 50;
        const tgtEdgeY = dataObjectIsBelowTarget ? tgtPos.y + tgtPos.h : tgtPos.y;
        const edgeInXml = `      <bpmndi:BPMNEdge id="${assocInId}_di" bpmnElement="${assocInId}">
        <di:waypoint x="${dobjInfo.dobjX + 18}" y="${dobjEdgeY}"/>
        <di:waypoint x="${tgtPos.x + tgtPos.w / 2}" y="${tgtEdgeY}"/>
      </bpmndi:BPMNEdge>`;
        if (tgtKey === rootOwner) {
          edgeElements.push(edgeInXml);
        } else {
          pushOwned(edgeElementsByOwner, tgtKey, edgeInXml);
        }
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
  xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
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
    if (step.ports.some(port => port.superPortId)) return true;

    // Generic rule: a Source/Sink that owns a real (non-mirrored) energy port
    // represents an energy supply/sink boundary, not a visual port proxy from
    // the BPMN exporter. Keep it visible — positionEnergyBoundaryProxies will
    // place it above/below the connected interior task.
    if (step.ports.some(port => this.isEnergyPort(port) && !port.superPortId)) {
      return false;
    }

    const label = step.label.trim();
    if (!label) return false;

    const isPortLikeLabel = /^(MI|MO|TEI|TEO|MEI|MEO|EEI|EEO)\d+$/i.test(label) ||
      /^IP[IO]_/i.test(label);
    if (isPortLikeLabel) return true;

    return step.ports.length > 0 && step.ports.every(port => port.label === label);
  }

  /**
   * Generic rule: energy ports (Thermal/Mechanical/Electrical) are routed on
   * the top or bottom edge of the owning task instead of left/right. This
   * frees the left/right edges for material flow and matches the BPMN-for-
   * process-engineering convention used in the DEXPI mapping paper.
   *
   * Detection is purely type-driven against the standardised DEXPI 2.0 port
   * type names. Source data must use the correct port type — energy ports
   * mistyped as MaterialPort will be treated as material ports.
   */
  private isEnergyPort(port: DexpiPort | undefined): boolean {
    if (!port) return false;
    return ['ThermalEnergyPort', 'MechanicalEnergyPort', 'ElectricalEnergyPort'].includes(port.type);
  }

  /**
   * Generic rule: any Source/Sink event whose only port is energy-type (TEI/
   * TEO/MEI/MEO/EEI/EEO or ThermalEnergyPort/Mechanical…/Electrical…) is
   * conceptually an energy supply/sink and should be placed above (Inlet) or
   * below (Outlet) the interior task it connects to — not in the left/right
   * material flow. Matches both auto-materialized boundary proxies (which
   * carry a superPortId) and user-modeled energy events.
   */
  private isEnergyBoundaryProxy(step: DexpiStep): boolean {
    if (step.dexpiType !== 'Source' && step.dexpiType !== 'Sink') return false;
    if (step.ports.length === 0) return false;
    return step.ports.every(port => this.isEnergyPort(port));
  }

  /**
   * A step is "instrumentation" if its DEXPI class is the abstract
   * InstrumentationActivity itself or any subtype of it. The set is computed
   * dynamically from Process.xml via the registry — no hardcoded subclass list,
   * so adding a new instrumentation class to a future DEXPI release just
   * requires updating dexpi-schema-files/Process.xml.
   *
   * Fallback when the registry didn't load (e.g. browser without bundled
   * Process.xml): match the abstract base name itself, so at least exact-match
   * cases still work.
   */
  private isInstrumentationStep(step: DexpiStep | undefined): boolean {
    if (!step) return false;
    if (this.registry.size === 0) {
      return step.dexpiType === 'InstrumentationActivity';
    }
    return this.registry.hasAncestor(step.dexpiType, 'InstrumentationActivity');
  }

  private _uidCounter = 0;
  private uid(): string {
    return `uid_gen_${++this._uidCounter}`;
  }
}
