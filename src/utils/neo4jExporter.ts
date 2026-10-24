/**
 * Neo4j Exporter for DEXPI XML
 * Parses DEXPI XML and exports to Neo4j graph database
 * 
 * Features (reads the DEXPI 2.0 Process.xml shape BpmnToDexpiTransformer writes):
 * - ProcessSteps as nodes with ports as properties
 * - InstrumentationActivity nodes from ProcessModel.InstrumentationSystemActivities
 *   with OBSERVES (→ ProcessStepReference) and MEASURES {variable}
 *   (→ step owning the MeasuredVariableReference QualifiedValue)
 * - Flow relationships typed from the connection class (Stream → MaterialStream,
 *   Thermal/Electrical/MechanicalEnergyFlow, InformationFlow) on ALL hierarchy levels
 * - SUB_PROCESS_ENTRY / SUB_PROCESS_EXIT from Port.SubReference / SuperReference
 * - CONTAINS relationships for subprocess hierarchy
 * - Generic attribute parsing: Data (incl. MultiLanguageString Description,
 *   enum DataReferences) and Components-carried Core/QualifiedValue
 *   quantities flattened to <property>_value / _unit / _provenance / _range
 */

import { DexpiProcessClassRegistry } from '../transformer/DexpiProcessClassRegistry';
import processXmlRaw from '../../dexpi-schema-files/Process.xml?raw';

// Build registry once at module load — synchronous, browser-safe (same approach
// as DexpiRenderer / DexpiPropertiesPanel). Drives DEXPI-class classification
// (e.g. recognising MeasuringProcessVariable as an InstrumentationActivity)
// without hardcoded subtype lists.
const NEO4J_REGISTRY = DexpiProcessClassRegistry.fromXml(processXmlRaw);

interface ExportStats {
  nodes?: number;
  relationships?: number;
  [key: string]: unknown;
}


export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
  database?: string;
}

// Generic attribute map
type AttributeMap = Record<string, string | number | boolean>;

export interface ProcessStepNode {
  id: string;
  identifier: string;
  label: string;
  type: string;
  nodeType: 'ProcessStep' | 'Source' | 'Sink' | 'InstrumentationActivity';
  parent?: string;
  hierarchy_level: number;
  isSubProcess: boolean;
  isNavigational: boolean;
  inputPorts: string[];
  outputPorts: string[];
  attributes: AttributeMap;
  /**
   * InstrumentationActivity only: uid of the ProcessStep named by the
   * activity's `ProcessStepReference` (Process.xml, lower=1 upper=1).
   */
  processStepRef?: string;
  /**
   * InstrumentationActivity only: uid of the Core/QualifiedValue named by
   * `MeasuredVariableReference`. Resolved to its owner via
   * `DexpiGraphData.qualifiedValueOwners`.
   */
  measuredVariableRef?: string;
}

/**
 * Where a Core/QualifiedValue with an id lives: the ProcessStep (or the
 * ProcessStep owning the port) / Stream that carries it, plus the
 * `Components property` name that names the physical variable
 * (Temperature, MassFlow, Level, ...).
 */
export interface QualifiedValueOwner {
  ownerId: string;
  ownerKind: 'step' | 'stream' | 'other';
  property: string;
}

export interface PortInfo {
  id: string;
  label: string;
  type: string;
  direction: 'In' | 'Out';
  ownerStepId: string;
  subReference?: string;   // child port id (for parent subprocess ports)
  superReference?: string; // parent port id (for child ports)
}

export interface StreamConnection {
  id: string;
  identifier: string;
  label: string;
  flowType: 'MaterialStream' | 'ElectricalEnergyFlow' | 'ThermalEnergyFlow' | 'MechanicalEnergyFlow' | 'InformationFlow';
  sourcePortId: string;
  targetPortId: string;
  sourceStepId: string;
  targetStepId: string;
  attributes: AttributeMap;
  /** Resolved from `<References property="MaterialStateReference" objects="#X"/>`. */
  materialStateRef?: string;
  /** Resolved from `<References property="MaterialTemplateReference" objects="#X"/>`. */
  materialTemplateRef?: string;
}

export interface MaterialTemplate {
  id: string;
  identifier: string;
  label: string;
  components: string[];
  attributes: AttributeMap;
}

export interface MaterialComponent {
  id: string;
  identifier: string;
  label: string;
  casNumber?: string;
  attributes: AttributeMap;
}

export interface MaterialState {
  id: string;
  identifier: string;
  label: string;
  /**
   * MaterialStateType this state references via Process.xml's
   * `MaterialState.State` ReferenceProperty (lower=1, upper=1). Resolved
   * from the `<References property="State" objects="#X"/>` element on the
   * MaterialState block.
   */
  typeRef?: string;
  /**
   * Resolved MaterialTemplate uid. Process.xml does NOT declare a template
   * reference on MaterialState directly; the link is via the Stream that
   * carries this state (`Stream.MaterialTemplateReference`). Computed
   * during parse by walking all streams once.
   */
  templateRef?: string;
  attributes: AttributeMap;
}

export interface MaterialStateType {
  id: string;
  identifier: string;
  label: string;
  /**
   * Composition object uid this state type references via Process.xml's
   * `MaterialStateType.Composition` ReferenceProperty (lower=1, upper=1).
   */
  compositionRef?: string;
  /**
   * Per-component fractions, resolved by pairing the Composition Object's
   * Values vector (positional) with the relevant MaterialTemplate's
   * ListOfComponents (also positional). The template is found by walking
   * the state→template map built from Stream references. `value` is the
   * fraction value as a string (preserving the schema's QualifiedValue
   * Values shape); `basis` is `"Mole"` or `"Mass"`.
   */
  fractions: { componentRef: string; value: string; basis: 'Mole' | 'Mass' }[];
  attributes: AttributeMap;
}

export interface DexpiGraphData {
  processSteps: ProcessStepNode[];
  ports: Map<string, PortInfo>;
  streams: StreamConnection[];
  materialTemplates: MaterialTemplate[];
  materialComponents: MaterialComponent[];
  materialStates: MaterialState[];
  materialStateTypes: MaterialStateType[];
  /** Core/QualifiedValue uid → owning step/stream + variable name. */
  qualifiedValueOwners: Map<string, QualifiedValueOwner>;
}

type FlowType = StreamConnection['flowType'];

/**
 * Flow type mapping based on port naming conventions (matches Python FLOW_TYPE_MAPPING)
 */
const FLOW_TYPE_MAPPING: Record<string, 'MaterialStream' | 'ElectricalEnergyFlow' | 'ThermalEnergyFlow' | 'MechanicalEnergyFlow' | 'InformationFlow'> = {
  'MI': 'MaterialStream',
  'MO': 'MaterialStream',
  'EEI': 'ElectricalEnergyFlow',
  'EEO': 'ElectricalEnergyFlow',
  'TEI': 'ThermalEnergyFlow',
  'TEO': 'ThermalEnergyFlow',
  'MEI': 'MechanicalEnergyFlow',
  'MEO': 'MechanicalEnergyFlow',
  'IOI': 'InformationFlow',
  'IOO': 'InformationFlow',
  'II': 'InformationFlow',
  'IO': 'InformationFlow'
};

/**
 * Determine flow type from port label (matches Python implementation)
 */
function determineFlowType(portLabel: string): 'MaterialStream' | 'ElectricalEnergyFlow' | 'ThermalEnergyFlow' | 'MechanicalEnergyFlow' | 'InformationFlow' {
  if (!portLabel) return 'MaterialStream';
  
  const normalizedLabel = portLabel.toUpperCase().trim();
  
  // Extract port type prefix (MI, MO, EEI, etc.)
  const portPattern = /^(MI|MO|EEI|EEO|TEI|TEO|MEI|MEO|IOI|IOO|II|IO)\d*/;
  const match = normalizedLabel.match(portPattern);
  
  if (match && match[1]) {
    return FLOW_TYPE_MAPPING[match[1]] || 'MaterialStream';
  }
  
  // Check for full type names in label
  if (normalizedLabel.includes('ELECTRICAL') || normalizedLabel.includes('POWER')) {
    return 'ElectricalEnergyFlow';
  }
  if (normalizedLabel.includes('THERMAL') || normalizedLabel.includes('HEAT')) {
    return 'ThermalEnergyFlow';
  }
  if (normalizedLabel.includes('MECHANICAL')) {
    return 'MechanicalEnergyFlow';
  }
  if (normalizedLabel.includes('INFORMATION') || normalizedLabel.includes('SIGNAL')) {
    return 'InformationFlow';
  }
  
  return 'MaterialStream';
}

/**
 * Connection-class → relationship type. The ProcessConnection Object's own
 * DEXPI class is authoritative (Process.xml: Stream, ThermalEnergyFlow,
 * ElectricalEnergyFlow, MechanicalEnergyFlow, InformationFlow). Ports carry
 * no Label in Process.xml, so the exporter writes Identifier only and the
 * Semantum export writes neither — the label regex above is kept only as a
 * fallback for connection classes the registry does not know.
 */
const CONNECTION_CLASS_FLOW_TYPE: Record<string, FlowType> = {
  Stream: 'MaterialStream',
  ThermalEnergyFlow: 'ThermalEnergyFlow',
  ElectricalEnergyFlow: 'ElectricalEnergyFlow',
  MechanicalEnergyFlow: 'MechanicalEnergyFlow',
  InformationFlow: 'InformationFlow',
};

function determineFlowTypeFromConnection(
  connectionType: string,
  sourcePortLabel: string,
  targetPortLabel: string,
): FlowType {
  const bareName = (connectionType.split('.').pop() || '').trim();
  const direct = CONNECTION_CLASS_FLOW_TYPE[bareName];
  if (direct) return direct;
  // Profile subclasses (e.g. a project-specific Stream subtype) resolve via
  // the class hierarchy in Process.xml.
  if (NEO4J_REGISTRY.size > 0 && bareName) {
    for (const [cls, flowType] of Object.entries(CONNECTION_CLASS_FLOW_TYPE)) {
      if (NEO4J_REGISTRY.hasAncestor(bareName, cls)) return flowType;
    }
  }
  // Legacy fallback: infer from a port label (MI1 / TEO1 / ...). An empty
  // label falls through to MaterialStream.
  return determineFlowType(sourcePortLabel || targetPortLabel);
}

/**
 * Check if a process step should be treated as a navigational event.
 * Navigational events are the boundary proxies the BPMN→DEXPI transformer
 * writes for a subprocess: nested Source/Sink steps whose port carries a
 * `SuperReference` to the port of the enclosing subprocess. They are not
 * real external sources/sinks — the material enters or leaves through the
 * parent's port. (A port with a `SubReference` marks the subprocess side
 * of that link, which `isSubProcess` already records.)
 */
function isNavigationalEvent(_elementType: string, ports: PortInfo[]): boolean {
  if (!ports || ports.length === 0) return false;
  return ports.some(port => !!port.superReference);
}

/** Direct child element lookup helpers (no descendant leakage). */
function childData(parent: Element, property: string): Element | undefined {
  return Array.from(parent.children).find(c =>
    c.tagName === 'Data' && c.getAttribute('property') === property) as Element | undefined;
}

function firstPrimitiveChild(el: Element | undefined): Element | undefined {
  if (!el) return undefined;
  return Array.from(el.children).find(c =>
    ['String', 'Double', 'Integer', 'Boolean', 'Number'].includes(c.tagName)) as Element | undefined;
}

/** `Core/…SomeUnit.Token` → `Token`; `…QuantityProvenance.Observed` → `Observed`. */
function enumToken(el: Element | undefined): string | undefined {
  if (!el) return undefined;
  const ref = Array.from(el.children).find(c => c.tagName === 'DataReference');
  const path = ref?.getAttribute('data') ?? ref?.getAttribute('type') ?? '';
  if (path) return path.split('.').pop() || path;
  const text = firstPrimitiveChild(el)?.textContent?.trim();
  return text || undefined;
}

/**
 * Text of a `<Data property="…">`: plain primitive, or the canonical
 * Core/DataTypes.MultiLanguageString aggregate (Description on most Process
 * classes), whose FIRST `<String>` is the Language — read
 * SingleLanguageStrings → Value instead. Mirrors
 * DexpiToBpmnTransformer.getDataString.
 */
function readDataText(dataEl: Element): string {
  const primitive = firstPrimitiveChild(dataEl);
  if (primitive) return primitive.textContent?.trim() || '';
  const aggregated = Array.from(dataEl.children).find(c =>
    c.tagName === 'AggregatedDataValue' &&
    (c.getAttribute('type') || '').endsWith('DataTypes.MultiLanguageString')) as Element | undefined;
  if (!aggregated) return '';
  const strings = childData(aggregated, 'SingleLanguageStrings');
  const single = strings && Array.from(strings.children).find(c => c.tagName === 'AggregatedDataValue');
  const value = single && childData(single as Element, 'Value');
  return firstPrimitiveChild(value)?.textContent?.trim() || '';
}

export interface QualifiedValueReading {
  /** Numeric value when the Double/Integer parses, else undefined. */
  value?: number;
  /** Raw value text (kept when non-numeric, e.g. a String-typed quantity). */
  valueText?: string;
  unit?: string;
  displayText?: string;
  provenance?: string;
  range?: string;
  /** True when Value wraps a PhysicalQuantityVector (fraction carriers). */
  isVector: boolean;
}

/**
 * Read a Core/QualifiedValue Object in the canonical emitted shape
 *   <Data property="Value">
 *     <AggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity">
 *       <Data property="Unit"><DataReference data="…Unit.Token"/></Data>
 *       <Data property="Value"><Double>…</Double></Data>
 *   <Data property="DisplayText"><String>…</String></Data>
 *   <Data property="Provenance"><DataReference data="…QuantityProvenance.X"/></Data>
 *   <Data property="Range"><DataReference data="…QuantityRange.X"/></Data>
 * with the flat fallback (primitive Value + Unit) for hand-authored files.
 * Port of DexpiToBpmnTransformer.readQvCanonical.
 */
function readQualifiedValue(qv: Element): QualifiedValueReading {
  const valueData = childData(qv, 'Value');
  let valueText = firstPrimitiveChild(valueData)?.textContent?.trim() || '';
  let unit = enumToken(childData(qv, 'Unit'));
  let isVector = false;
  if (valueData && !valueText) {
    const agg = Array.from(valueData.children).find(c =>
      c.tagName === 'AggregatedDataValue' || c.tagName === 'Object') as Element | undefined;
    if (agg) {
      isVector = (agg.getAttribute('type') || '').endsWith('PhysicalQuantityVector');
      valueText = firstPrimitiveChild(childData(agg, 'Value'))?.textContent?.trim() || '';
      unit = enumToken(childData(agg, 'Unit')) ?? unit;
    }
  }
  const displayText = firstPrimitiveChild(childData(qv, 'DisplayText'))?.textContent?.trim() || undefined;
  const numeric = valueText !== '' && Number.isFinite(Number(valueText)) ? Number(valueText) : undefined;
  return {
    value: numeric,
    valueText: valueText || undefined,
    unit,
    displayText,
    provenance: enumToken(childData(qv, 'Provenance')),
    range: enumToken(childData(qv, 'Range')),
    isVector,
  };
}

/**
 * The QualifiedValue Objects carried by `<Components property="X">` children
 * of `element` (X = Temperature, MassFlow, MoleFlow, Duty, …). Returns one
 * entry per carrier that holds at least one QualifiedValue.
 */
function qualifiedValueCarriers(element: Element): Array<{ property: string; qv: Element }> {
  const out: Array<{ property: string; qv: Element }> = [];
  for (const comp of Array.from(element.children)) {
    if (comp.tagName !== 'Components') continue;
    const property = comp.getAttribute('property');
    if (!property) continue;
    const qv = Array.from(comp.children).find(c =>
      c.tagName === 'Object' && (c.getAttribute('type') || '').endsWith('QualifiedValue')) as Element | undefined;
    if (qv) out.push({ property, qv });
  }
  return out;
}

/**
 * Generic attribute extractor — direct `<Data>` children plus the
 * physical quantities carried as `<Components property="X">` QualifiedValue
 * Objects, flattened to `X_value` / `X_unit` / `X_displayText` /
 * `X_provenance` / `X_range`. Vector carriers (composition fractions) are
 * left to the Composition pass.
 */
function extractAllAttributes(element: Element): AttributeMap {
  const attrs: AttributeMap = {};

  for (const dataEl of Array.from(element.children)) {
    if (dataEl.tagName !== 'Data') continue;
    const property = dataEl.getAttribute('property');
    if (!property || property === 'Identifier' || property === 'Label') continue;

    const primitive = firstPrimitiveChild(dataEl);
    if (primitive) {
      const text = primitive.textContent?.trim() ?? '';
      if (text === '') continue;
      if (primitive.tagName === 'Boolean') {
        attrs[property] = text.toLowerCase() === 'true';
      } else if (primitive.tagName === 'Double' || primitive.tagName === 'Integer' || primitive.tagName === 'Number') {
        const n = Number(text);
        attrs[property] = Number.isFinite(n) ? n : text;
      } else {
        attrs[property] = text;
      }
      continue;
    }
    const text = readDataText(dataEl);
    if (text) { attrs[property] = text; continue; }
    const token = enumToken(dataEl);
    if (token) attrs[property] = token;
  }

  for (const { property, qv } of qualifiedValueCarriers(element)) {
    const r = readQualifiedValue(qv);
    if (r.isVector) continue;
    if (r.value !== undefined) attrs[`${property}_value`] = r.value;
    else if (r.valueText) attrs[`${property}_value`] = r.valueText;
    if (r.unit) attrs[`${property}_unit`] = r.unit;
    if (r.displayText) attrs[`${property}_displayText`] = r.displayText;
    if (r.provenance) attrs[`${property}_provenance`] = r.provenance;
    if (r.range) attrs[`${property}_range`] = r.range;
  }

  return attrs;
}

/**
 * Get text content from a Data element (direct child of `element`).
 */
function getDataValue(element: Element, property: string): string {
  const dataEl = childData(element, property);
  return dataEl ? readDataText(dataEl) : '';
}

/**
 * Read all target uids from a canonical `<References property="X" objects="#a #b #c"/>`
 * child of `parent`. The DEXPI XSD's `objects` attribute is whitespace-
 * separated for multi-target references (e.g. `ListOfMaterialComponents.Component`
 * for an N-component template); single-target references use the same
 * encoding with one entry. Returns an empty array if no matching child
 * exists or the attribute is empty.
 */
function readRefTargetUids(parent: Element, propertyName: string): string[] {
  const refEl = parent.querySelector(`References[property="${propertyName}"]`);
  if (!refEl) return [];
  const objects = refEl.getAttribute('objects');
  if (objects) {
    return objects.trim().split(/\s+/).map(s => s.replace(/^#/, '')).filter(Boolean);
  }
  // Legacy / verbose encoding: child <ObjectReference object="#X"/> entries.
  const childRefs = Array.from(refEl.querySelectorAll('ObjectReference'));
  return childRefs
    .map(c => c.getAttribute('objects')?.replace(/^#/, '')
           ?? c.getAttribute('object')?.replace(/^#/, '')
           ?? c.getAttribute('ref')
           ?? '')
    .filter(Boolean);
}

/**
 * Single-target convenience over `readRefTargetUids`. Returns the first
 * uid if any, else undefined. Use for ReferenceProperty entries declared
 * with `upper=1` (e.g. MaterialState.State, Stream.MaterialTemplateReference).
 */
function readRefTargetUid(parent: Element, propertyName: string): string | undefined {
  return readRefTargetUids(parent, propertyName)[0];
}

/**
 * Parse DEXPI XML and extract graph data
 */
export function parseDexpiXml(xmlString: string): DexpiGraphData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  
  const processSteps: ProcessStepNode[] = [];
  const ports = new Map<string, PortInfo>();
  const streams: StreamConnection[] = [];
  const materialTemplates: MaterialTemplate[] = [];
  const materialComponents: MaterialComponent[] = [];
  const materialStates: MaterialState[] = [];
  const materialStateTypes: MaterialStateType[] = [];
  
  const processModel = doc.querySelector('Object[type="Process/ProcessModel"]');
  if (!processModel) {
    throw new Error('No ProcessModel found in DEXPI XML');
  }

  // QualifiedValue uid → owner. Instrumentation activities point their
  // MeasuredVariableReference at the id of a `<Object type="Core/QualifiedValue">`
  // carried by a step (or one of its ports) or a stream; the Components
  // property that carries it names the measured variable.
  const qualifiedValueOwners = new Map<string, QualifiedValueOwner>();
  function registerQualifiedValueOwners(owner: Element, ownerId: string, ownerKind: QualifiedValueOwner['ownerKind']) {
    const register = (carrierParent: Element) => {
      for (const { property, qv } of qualifiedValueCarriers(carrierParent)) {
        const qvId = qv.getAttribute('id');
        if (qvId && !qualifiedValueOwners.has(qvId)) {
          qualifiedValueOwners.set(qvId, { ownerId, ownerKind, property });
        }
      }
    };
    register(owner);
    // Quantities carried by a port belong to the port's step.
    const portsContainer = Array.from(owner.children).find(c =>
      c.tagName === 'Components' && c.getAttribute('property') === 'Ports');
    if (portsContainer) {
      for (const portObj of Array.from(portsContainer.children)) {
        if (portObj.tagName === 'Object') register(portObj);
      }
    }
  }
  
  // Parse Process Steps recursively
  function parseProcessSteps(parent: Element, parentId: string | undefined, level: number) {
    // Look for both ProcessSteps (top-level) and SubProcessSteps (nested)
    const processStepsContainers = Array.from(parent.querySelectorAll(':scope > Components[property="ProcessSteps"], :scope > Components[property="SubProcessSteps"]'));
    
    for (const container of processStepsContainers) {
      const stepObjects = container.querySelectorAll(':scope > Object');
      
      for (const stepObj of Array.from(stepObjects)) {
        const id = stepObj.getAttribute('id') || '';
        const type = stepObj.getAttribute('type') || '';
        const identifier = getDataValue(stepObj, 'Identifier');
        const label = getDataValue(stepObj, 'Label');
        
        const inputPorts: string[] = [];
        const outputPorts: string[] = [];
        
        // Parse ports
        const portsContainer = stepObj.querySelector(':scope > Components[property="Ports"]');
        if (portsContainer) {
          const portObjects = portsContainer.querySelectorAll(':scope > Object');
          for (const portObj of Array.from(portObjects)) {
            const portId = portObj.getAttribute('id') || '';
            const portType = portObj.getAttribute('type') || '';
            const portLabel = getDataValue(portObj, 'Label') || getDataValue(portObj, 'Identifier');
            
            const dirData = portObj.querySelector('Data[property="NominalDirection"] DataReference');
            const dirValue = dirData?.getAttribute('data') || '';
            const isInput = dirValue.toLowerCase().includes('in');
            
            // SubReference (parent port -> child port). Process.xml declares
            // Port.SubReference as a CompositionProperty, so the export
            // writes `<Components property="SubReference"><ObjectReference
            // object="#childPort"/>`. `ref` / `objects` are legacy spellings.
            let subReference: string | undefined;
            const subRefContainer = Array.from(portObj.children).find(c =>
              c.tagName === 'Components' && c.getAttribute('property') === 'SubReference');
            if (subRefContainer) {
              const objRef = Array.from(subRefContainer.children).find(c => c.tagName === 'ObjectReference');
              const raw = objRef?.getAttribute('object')
                ?? objRef?.getAttribute('ref')
                ?? objRef?.getAttribute('objects')
                ?? '';
              subReference = raw.trim().split(/\s+/)[0]?.replace(/^#/, '') || undefined;
            }
            
            // SuperReference (child port -> parent port) is a ReferenceProperty:
            // `<References property="SuperReference" objects="#parentPort"/>`.
            const superReference = readRefTargetUid(portObj, 'SuperReference');
            
            ports.set(portId, {
              id: portId,
              label: portLabel,
              type: portType,
              direction: isInput ? 'In' : 'Out',
              ownerStepId: id,
              subReference,
              superReference
            });
            
            if (isInput) {
              inputPorts.push(portLabel);
            } else {
              outputPorts.push(portLabel);
            }
          }
        }
        
        // Check for SubProcessSteps
        const subStepsContainer = stepObj.querySelector(':scope > Components[property="SubProcessSteps"]');
        const hasSubSteps = subStepsContainer && subStepsContainer.querySelectorAll(':scope > Object').length > 0;
        
        const attributes = extractAllAttributes(stepObj);
        
        // Determine node type based on DEXPI class ancestry from Process.xml.
        // hasAncestor returns true when the type itself OR any of its supertypes
        // matches — so MeasuringProcessVariable, ControllingProcessVariable,
        // ConveyingSignal, CalculatingProcessVariable etc. all correctly resolve
        // to 'InstrumentationActivity'. Fallback to substring match only if the
        // registry didn't load (e.g. Process.xml ?raw import failed).
        let nodeType: 'ProcessStep' | 'Source' | 'Sink' | 'InstrumentationActivity' = 'ProcessStep';
        const bareName = (type.split('.').pop() || '').trim();

        if (NEO4J_REGISTRY.size > 0) {
          if (NEO4J_REGISTRY.hasAncestor(bareName, 'Source')) {
            nodeType = 'Source';
          } else if (NEO4J_REGISTRY.hasAncestor(bareName, 'Sink')) {
            nodeType = 'Sink';
          } else if (NEO4J_REGISTRY.hasAncestor(bareName, 'InstrumentationActivity')) {
            nodeType = 'InstrumentationActivity';
          }
        } else {
          const normalizedType = type.toLowerCase();
          if (normalizedType.includes('source')) nodeType = 'Source';
          else if (normalizedType.includes('sink')) nodeType = 'Sink';
          else if (normalizedType.includes('instrument')) nodeType = 'InstrumentationActivity';
        }
        
        // Check if this is a navigational event
        const allPorts: PortInfo[] = [];
        if (portsContainer) {
          const portObjects = portsContainer.querySelectorAll(':scope > Object');
          for (const portObj of Array.from(portObjects)) {
            const portId = portObj.getAttribute('id');
            if (!portId) continue;
            const p = ports.get(portId);
            if (p) allPorts.push(p);
          }
        }
        const isNavigational = isNavigationalEvent(type, allPorts);

        // Legacy files may nest instrumentation under SubProcessSteps; read
        // the same references the InstrumentationSystemActivities pass reads.
        const processStepRef = nodeType === 'InstrumentationActivity'
          ? readRefTargetUid(stepObj, 'ProcessStepReference') : undefined;
        const measuredVariableRef = nodeType === 'InstrumentationActivity'
          ? readRefTargetUid(stepObj, 'MeasuredVariableReference') : undefined;

        registerQualifiedValueOwners(stepObj, id, 'step');
        
        processSteps.push({
          id,
          identifier,
          label,
          type: type.replace('Process/Process.', '').replace('Process/', ''),
          nodeType,
          parent: parentId,
          hierarchy_level: level,
          isSubProcess: hasSubSteps || false,
          isNavigational,
          inputPorts,
          outputPorts,
          attributes,
          processStepRef,
          measuredVariableRef,
        });
        
        // Recursively parse sub-process steps
        if (hasSubSteps) {
          parseProcessSteps(stepObj, id, level + 1);
        }
      }
    }
  }
  
  parseProcessSteps(processModel, undefined, 0);

  // Parse instrumentation. Since the issue-#87 fix the exporter writes
  // instrumentation activities under
  //   ProcessModel.InstrumentationSystemActivities
  //     → InstrumentationSystemActivity.InstrumentationActivities
  //       → MeasuringProcessVariable / ControllingProcessVariable / …
  // each carrying `References ProcessStepReference` (the observed step) and
  // `References MeasuredVariableReference` (a QualifiedValue id). They are
  // emitted as InstrumentationActivity nodes contained in the referenced
  // step; OBSERVES / MEASURES edges are generated from the references.
  const stepLevelById = new Map(processSteps.map(s => [s.id, s.hierarchy_level] as const));
  const systemsContainer = Array.from(processModel.children).find(c =>
    c.tagName === 'Components' && c.getAttribute('property') === 'InstrumentationSystemActivities');
  if (systemsContainer) {
    for (const systemObj of Array.from(systemsContainer.children)) {
      if (systemObj.tagName !== 'Object') continue;
      const systemId = systemObj.getAttribute('id') || '';
      const activitiesContainer = Array.from(systemObj.children).find(c =>
        c.tagName === 'Components' && c.getAttribute('property') === 'InstrumentationActivities');
      if (!activitiesContainer) continue;
      for (const actObj of Array.from(activitiesContainer.children)) {
        if (actObj.tagName !== 'Object') continue;
        const id = actObj.getAttribute('id') || '';
        const type = actObj.getAttribute('type') || '';
        const processStepRef = readRefTargetUid(actObj, 'ProcessStepReference');
        const measuredVariableRef = readRefTargetUid(actObj, 'MeasuredVariableReference');
        const parentLevel = processStepRef !== undefined ? stepLevelById.get(processStepRef) : undefined;
        const attributes = extractAllAttributes(actObj);
        if (systemId) attributes.instrumentationSystem = systemId;
        registerQualifiedValueOwners(actObj, id, 'step');
        processSteps.push({
          id,
          identifier: getDataValue(actObj, 'Identifier'),
          label: getDataValue(actObj, 'Label'),
          type: type.replace('Process/Process.', '').replace('Process/', ''),
          nodeType: 'InstrumentationActivity',
          parent: processStepRef !== undefined && stepLevelById.has(processStepRef) ? processStepRef : undefined,
          hierarchy_level: parentLevel !== undefined ? parentLevel + 1 : 0,
          isSubProcess: false,
          isNavigational: false,
          inputPorts: [],
          outputPorts: [],
          attributes,
          processStepRef,
          measuredVariableRef,
        });
      }
    }
  }
  
  // Parse Process Connections (Streams)
  const connectionsContainer = processModel.querySelector('Components[property="ProcessConnections"]');
  if (connectionsContainer) {
    const streamObjects = connectionsContainer.querySelectorAll(':scope > Object');
    
    for (const streamObj of Array.from(streamObjects)) {
      const id = streamObj.getAttribute('id') || '';
      const connectionType = streamObj.getAttribute('type') || '';
      const identifier = getDataValue(streamObj, 'Identifier');
      const label = getDataValue(streamObj, 'Label');
      
      // objects= is a whitespace-separated list of `#uid` refs in the
      // canonical multi-target form. Source/Target are upper=1 single-
      // target on Stream, so the realistic parse is "first id stripped
      // of its leading #". replace('#', '') would only strip the leading
      // marker of the first id and keep the rest of the string verbatim
      // (including any additional ' #uid' tokens), silently mis-routing
      // any future multi-target authoring through ports.get(undefined).
      const firstUid = (raw: string | null | undefined): string =>
        (raw ?? '').trim().split(/\s+/)[0]?.replace(/^#/, '') || '';
      const sourceRef = streamObj.querySelector('References[property="Source"]');
      const sourcePortId = firstUid(sourceRef?.getAttribute('objects'));

      const targetRef = streamObj.querySelector('References[property="Target"]');
      const targetPortId = firstUid(targetRef?.getAttribute('objects'));
      
      const sourcePortInfo = ports.get(sourcePortId);
      const targetPortInfo = ports.get(targetPortId);
      
      if (!sourcePortInfo || !targetPortInfo) continue;
      
      // Relationship type from the connection Object's own DEXPI class
      // (Stream / ThermalEnergyFlow / …); port labels only as a fallback.
      const flowType = determineFlowTypeFromConnection(connectionType, sourcePortInfo.label, targetPortInfo.label);
      registerQualifiedValueOwners(streamObj, id, 'stream');
      
      // Process.xml declares both references on Stream
      // (lower=0, upper=1 each). Read via the canonical attribute form
      // the transformer emits (`<References objects="#X"/>`); falls back
      // to the older child-ObjectReference encoding for compatibility.
      const materialStateRef = readRefTargetUid(streamObj, 'MaterialStateReference');
      const materialTemplateRef = readRefTargetUid(streamObj, 'MaterialTemplateReference');

      const attributes = extractAllAttributes(streamObj);
      
      streams.push({
        id,
        identifier,
        label,
        flowType,
        sourcePortId,
        targetPortId,
        sourceStepId: sourcePortInfo.ownerStepId,
        targetStepId: targetPortInfo.ownerStepId,
        attributes,
        materialStateRef,
        materialTemplateRef,
      });
    }
  }
  
  // Parse ListOfMaterialComponents — a separate Object class that holds
  // the actual per-template list of component uids. Process.xml declares
  // MaterialTemplate.ListOfComponents as a ReferenceProperty pointing at
  // a ListOfMaterialComponents Object (so each MaterialTemplate has the
  // list one indirection away). The ListOfMaterialComponents object
  // itself has a multi-target Component reference whose `objects`
  // attribute is space-separated component uids.
  const listOfComponentsByUid = new Map<string, string[]>();
  const lomcsContainer = processModel.querySelector('Components[property="ListsOfMaterialComponents"]');
  if (lomcsContainer) {
    for (const lomcObj of Array.from(lomcsContainer.querySelectorAll(':scope > Object'))) {
      const id = lomcObj.getAttribute('id') || '';
      const componentUids = readRefTargetUids(lomcObj, 'Component');
      listOfComponentsByUid.set(id, componentUids);
    }
  }

  // Parse Material Templates. Follow the ListOfComponents reference to
  // resolve the per-template component uids list.
  const templatesContainer = processModel.querySelector('Components[property="MaterialTemplates"]');
  if (templatesContainer) {
    for (const templateObj of Array.from(templatesContainer.querySelectorAll(':scope > Object'))) {
      const id = templateObj.getAttribute('id') || '';
      const identifier = getDataValue(templateObj, 'Identifier');
      const label = getDataValue(templateObj, 'Label');
      const lomcUid = readRefTargetUid(templateObj, 'ListOfComponents');
      const components = lomcUid ? (listOfComponentsByUid.get(lomcUid) ?? []) : [];

      materialTemplates.push({ id, identifier, label, components, attributes: extractAllAttributes(templateObj) });
    }
  }
  
  // Parse Material Components
  const componentsContainer = processModel.querySelector('Components[property="MaterialComponents"]');
  if (componentsContainer) {
    for (const compObj of Array.from(componentsContainer.querySelectorAll(':scope > Object'))) {
      const id = compObj.getAttribute('id') || '';
      const identifier = getDataValue(compObj, 'Identifier');
      const label = getDataValue(compObj, 'Label');
      const casNumber = getDataValue(compObj, 'CASNumber');
      
      materialComponents.push({ 
        id, identifier, label, 
        casNumber: casNumber || undefined,
        attributes: extractAllAttributes(compObj)
      });
    }
  }
  
  // Parse Compositions — the per-stateType fraction vector lives here.
  // Each Composition Object holds Display + a single QualifiedValue
  // Components carrier whose property name encodes the basis
  // (MoleFractiona — sic per Process.xml, with the accepted corrected
  // spelling MoleFractions also read — or MassFractions) and whose
  // Data property="Values" entries are the positional per-component
  // fraction values. Build a uid → {basis, values} map for the
  // MaterialStateType pass below to consult.
  type CompositionData = { basis: 'Mole' | 'Mass'; values: string[] };
  const compositionDataByUid = new Map<string, CompositionData>();
  // Composition also carries scalar QualifiedValues — MoleFlow moved here
  // from MaterialStateType in Process.xml, and Display is a plain Data —
  // which are flattened onto the referencing MaterialStateType node.
  const compositionAttrsByUid = new Map<string, AttributeMap>();
  const compositionsContainer = processModel.querySelector('Components[property="Compositions"]');
  if (compositionsContainer) {
    for (const compObj of Array.from(compositionsContainer.querySelectorAll(':scope > Object'))) {
      const compId = compObj.getAttribute('id') || '';
      compositionAttrsByUid.set(compId, extractAllAttributes(compObj));
      // Identify the fractions carrier by canonical property name.
      const moleCarrier = compObj.querySelector(':scope > Components[property="MoleFractiona"]')
        ?? compObj.querySelector(':scope > Components[property="MoleFractions"]');
      const massCarrier = compObj.querySelector(':scope > Components[property="MassFractions"]');
      const carrier = moleCarrier ?? massCarrier;
      if (!carrier) continue;
      const basis: 'Mole' | 'Mass' = moleCarrier ? 'Mole' : 'Mass';
      const qvObject = carrier.querySelector(':scope > Object[type="Core/QualifiedValue"]');
      if (!qvObject) continue;
      // The fraction values live inside the canonical
      // <Data property="Value"><AggregatedDataValue type="…PhysicalQuantityVector">
      // <Data property="Values"><Double>…</Double></Data>…</AggregatedDataValue>.
      // bpmn2dexpi writes one <Data property="Values"> per component; the
      // Semantum export packs all <Double> children into a single Values
      // Data. Read every Double / String under each Values element.
      const valueEls = Array.from(qvObject.querySelectorAll('Data[property="Values"]'));
      const values: string[] = [];
      for (const v of valueEls) {
        const prims = Array.from(v.children).filter(c => c.tagName === 'Double' || c.tagName === 'String');
        if (prims.length > 0) {
          for (const prim of prims) values.push((prim.textContent ?? '').trim());
        } else {
          values.push((v.textContent ?? '').trim());
        }
      }
      if (values.length > 0) compositionDataByUid.set(compId, { basis, values });
    }
  }

  // Parse Material State Types
  const stateTypesContainer = processModel.querySelector('Components[property="MaterialStateTypes"]');
  if (stateTypesContainer) {
    for (const typeObj of Array.from(stateTypesContainer.querySelectorAll(':scope > Object'))) {
      const id = typeObj.getAttribute('id') || '';
      const identifier = getDataValue(typeObj, 'Identifier');
      const label = getDataValue(typeObj, 'Label');
      // Resolve the Composition reference (Process.xml MaterialStateType.Composition,
      // lower=1, upper=1, target /Process.Composition). The fraction values
      // and basis are pulled from the Composition map; the componentRef
      // pairing happens later, once the state→template map is available.
      const compositionRef = readRefTargetUid(typeObj, 'Composition');

      // Fractions are populated in a post-pass below so we can pair
      // values with template.componentRefs by walking the streams.
      // Composition-carried scalars (MoleFlow_value / MoleFlow_unit, Display)
      // land on the MaterialStateType node; the state type's own Data wins
      // on a name clash.
      const compositionAttrs = compositionRef ? compositionAttrsByUid.get(compositionRef) : undefined;
      materialStateTypes.push({
        id, identifier, label,
        compositionRef,
        fractions: [],
        attributes: { ...(compositionAttrs ?? {}), ...extractAllAttributes(typeObj) },
      });
    }
  }

  // Parse Material States. Process.xml's MaterialState declares a State
  // reference to MaterialStateType (lower=1, upper=1). It does NOT
  // declare a MaterialTemplateReference — that lives on Stream.
  const statesContainer = processModel.querySelector('Components[property="MaterialStates"]');
  if (statesContainer) {
    for (const stateObj of Array.from(statesContainer.querySelectorAll(':scope > Object'))) {
      const id = stateObj.getAttribute('id') || '';
      const identifier = getDataValue(stateObj, 'Identifier');
      const label = getDataValue(stateObj, 'Label');
      const typeRef = readRefTargetUid(stateObj, 'State');
      // templateRef is filled in by the post-pass below, sourced from the
      // Stream that carries this state.
      materialStates.push({
        id, identifier, label,
        typeRef,
        templateRef: undefined,
        attributes: extractAllAttributes(stateObj),
      });
    }
  }

  // Post-pass: resolve state → template via the streams. Walk every
  // Stream that has both a MaterialStateReference AND a
  // MaterialTemplateReference; record the pairing. If two streams point
  // the same state at different templates the model is internally
  // inconsistent — take the first pairing and move on (downstream
  // queries can detect the divergence if it matters).
  const stateToTemplate = new Map<string, string>();
  for (const stream of streams) {
    if (!stream.materialStateRef || !stream.materialTemplateRef) continue;
    if (!stateToTemplate.has(stream.materialStateRef)) {
      stateToTemplate.set(stream.materialStateRef, stream.materialTemplateRef);
    }
  }
  for (const state of materialStates) {
    state.templateRef = stateToTemplate.get(state.id);
  }

  // Resolve per-stateType fractions. For each MaterialStateType, find a
  // MaterialState that references it; from there look up the linked
  // MaterialTemplate (via the streams pass) and pair fractions[i] with
  // template.componentRefs[i] positionally. If no template is reachable
  // (orphan stateType — happens when no stream carries the state) we
  // leave fractions empty rather than emit half-resolved (state, value)
  // pairs without a component identity.
  const templateById = new Map(materialTemplates.map(t => [t.id, t] as const));
  for (const stateType of materialStateTypes) {
    if (!stateType.compositionRef) continue;
    const comp = compositionDataByUid.get(stateType.compositionRef);
    if (!comp) continue;
    // Find any state that uses this stateType, then the template that
    // state is associated with via the streams.
    const linkedState = materialStates.find(s => s.typeRef === stateType.id);
    const templateUid = linkedState ? stateToTemplate.get(linkedState.id) : undefined;
    const template = templateUid ? templateById.get(templateUid) : undefined;
    if (!template) continue;
    const n = Math.min(comp.values.length, template.components.length);
    for (let i = 0; i < n; i++) {
      stateType.fractions.push({
        componentRef: template.components[i],
        value: comp.values[i],
        basis: comp.basis,
      });
    }
  }

  return { processSteps, ports, streams, materialTemplates, materialComponents, materialStates, materialStateTypes, qualifiedValueOwners };
}

/**
 * Analyze subprocess flow connections to create entry/exit relationships
 * Matches Python's analyze_subprocess_flow_connections() function
 */
function analyzeSubprocessFlows(
  processSteps: ProcessStepNode[],
  streams: StreamConnection[]
): Array<{
  source: string;
  target: string;
  flowType: string;
  relationshipType: 'enters_subprocess' | 'exits_subprocess' | 'subprocess_internal_entry' | 'subprocess_internal_exit';
  name: string;
  originalFlowId: string;
  subprocessLevel: number;
}> {
  const subprocessFlows: Array<{
    source: string;
    target: string;
    flowType: string;
    relationshipType: 'enters_subprocess' | 'exits_subprocess' | 'subprocess_internal_entry' | 'subprocess_internal_exit';
    name: string;
    originalFlowId: string;
    subprocessLevel: number;
  }> = [];

  // Build hierarchy map
  const hierarchy = new Map<string, string[]>(); // parent -> children
  for (const step of processSteps) {
    if (step.parent) {
      if (!hierarchy.has(step.parent)) {
        hierarchy.set(step.parent, []);
      }
      hierarchy.get(step.parent)!.push(step.id);
    }
  }

  // Get all descendants recursively
  function getAllDescendants(parentId: string): Set<string> {
    const descendants = new Set<string>();
    const children = hierarchy.get(parentId) || [];
    for (const childId of children) {
      descendants.add(childId);
      const childDescendants = getAllDescendants(childId);
      childDescendants.forEach(d => descendants.add(d));
    }
    return descendants;
  }

  // Get subprocess level (nesting depth)
  function getSubprocessLevel(stepId: string): number {
    let level = 0;
    const currentId = stepId;
    const step = processSteps.find(s => s.id === currentId);
    if (!step) return 0;
    
    let currentParent = step.parent;
    while (currentParent) {
      level++;
      const parentStep = processSteps.find(s => s.id === currentParent);
      if (!parentStep) break;
      currentParent = parentStep.parent;
    }
    return level;
  }

  // Analyze each subprocess
  const subprocesses = processSteps.filter(s => s.isSubProcess);
  
  for (const subprocess of subprocesses) {
    const subprocessId = subprocess.id;
    const descendants = getAllDescendants(subprocessId);
    const level = getSubprocessLevel(subprocessId);

    // Find entry points (flows from outside to inside)
    for (const stream of streams) {
      const sourceId = stream.sourceStepId;
      const targetId = stream.targetStepId;

      // Entry: source outside, target inside (but not the subprocess itself)
      if (!descendants.has(sourceId) && sourceId !== subprocessId && 
          descendants.has(targetId)) {
        
        // Determine if this is a direct entry or internal nested entry
        const targetStep = processSteps.find(s => s.id === targetId);
        const isDirectChild = targetStep?.parent === subprocessId;
        
        const relType = isDirectChild ? 'enters_subprocess' : 'subprocess_internal_entry';
        
        subprocessFlows.push({
          source: subprocessId,
          target: targetId,
          flowType: stream.flowType,
          relationshipType: relType,
          name: `${subprocess.label} entry to ${targetStep?.label || targetId}`,
          originalFlowId: stream.id,
          subprocessLevel: level
        });
      }

      // Exit: source inside, target outside (but not the subprocess itself)
      if (descendants.has(sourceId) && 
          !descendants.has(targetId) && targetId !== subprocessId) {
        
        const sourceStep = processSteps.find(s => s.id === sourceId);
        const isDirectChild = sourceStep?.parent === subprocessId;
        
        const relType = isDirectChild ? 'exits_subprocess' : 'subprocess_internal_exit';
        
        subprocessFlows.push({
          source: sourceId,
          target: subprocessId,
          flowType: stream.flowType,
          relationshipType: relType,
          name: `${sourceStep?.label || sourceId} exit from ${subprocess.label}`,
          originalFlowId: stream.id,
          subprocessLevel: level
        });
      }
    }
  }

  return subprocessFlows;
}

export interface GenerateCypherOptions {
  /**
   * When `true` (default) prepend `MATCH (n) DETACH DELETE n` so the
   * export wipes the database first. Set to `false` for additive
   * runs that append onto an existing graph.
   */
  clearDatabase?: boolean;
}

/**
 * Generate Cypher queries for Neo4j import
 */
export function generateCypherQueries(data: DexpiGraphData, options: GenerateCypherOptions = {}): string[] {
  const { clearDatabase = true } = options;
  const queries: string[] = [];

  if (clearDatabase) {
    queries.push('MATCH (n) DETACH DELETE n');
  }
  
  // Create Material Components
  for (const comp of data.materialComponents) {
    const props = buildPropsString({
      id: comp.id, identifier: comp.identifier, label: comp.label,
      casNumber: comp.casNumber || '', ...comp.attributes
    });
    queries.push(`CREATE (:MaterialComponent {${props}})`);
  }
  
  // Create Material Templates
  for (const template of data.materialTemplates) {
    const props = buildPropsString({
      id: template.id, identifier: template.identifier, label: template.label,
      components: template.components, ...template.attributes
    });
    queries.push(`CREATE (:MaterialTemplate {${props}})`);
  }
  
  // Link Templates to Components
  for (const template of data.materialTemplates) {
    for (const compRef of template.components) {
      if (compRef) {
        queries.push(`
MATCH (mt:MaterialTemplate {id: '${escapeString(template.id)}'})
MATCH (mc:MaterialComponent {id: '${escapeString(compRef)}'})
CREATE (mt)-[:HAS_COMPONENT]->(mc)`);
      }
    }
  }
  
  // Create Material State Types
  for (const stateType of data.materialStateTypes) {
    const props = buildPropsString({
      id: stateType.id, identifier: stateType.identifier, label: stateType.label,
      ...stateType.attributes
    });
    queries.push(`CREATE (:MaterialStateType {${props}})`);

    // No (MaterialStateType)-[:USES_TEMPLATE]->(MaterialTemplate) edge:
    // Process.xml puts MaterialTemplateReference on Stream (not on
    // MaterialStateType). The state→template linkage is emitted below
    // via (MaterialState)-[:USES_TEMPLATE], sourced from the streams.

    for (const frac of stateType.fractions) {
      if (frac.componentRef) {
        // Single value-per-component edge tagged with the basis
        // (Mole or Mass) — matches the Process.xml shape where one
        // Composition carries one fractions vector under a single basis
        // (MoleFractiona xor MassFractions).
        const fracProps: string[] = [
          `value: ${frac.value}`,
          `basis: '${frac.basis}'`,
        ];
        queries.push(`
MATCH (mst:MaterialStateType {id: '${escapeString(stateType.id)}'})
MATCH (mc:MaterialComponent {id: '${escapeString(frac.componentRef)}'})
CREATE (mst)-[:HAS_FRACTION {${fracProps.join(', ')}}]->(mc)`);
      }
    }
  }
  
  // Create Material States
  for (const state of data.materialStates) {
    const props = buildPropsString({
      id: state.id, identifier: state.identifier, label: state.label,
      ...state.attributes
    });
    queries.push(`CREATE (:MaterialState {${props}})`);
    
    if (state.templateRef) {
      queries.push(`
MATCH (ms:MaterialState {id: '${escapeString(state.id)}'})
MATCH (mt:MaterialTemplate {id: '${escapeString(state.templateRef)}'})
CREATE (ms)-[:USES_TEMPLATE]->(mt)`);
    }
    if (state.typeRef) {
      queries.push(`
MATCH (ms:MaterialState {id: '${escapeString(state.id)}'})
MATCH (mst:MaterialStateType {id: '${escapeString(state.typeRef)}'})
CREATE (ms)-[:HAS_TYPE]->(mst)`);
    }
  }
  
  // Create Process Steps with ports as properties.
  // Node types: ProcessStep, Source, Sink, InstrumentationActivity.
  // `name` is set to the DEXPI class so Neo4j Browser / Bloom show
  // the class instead of the (often free-text) BPMN caption as the
  // node's default display label.
  for (const step of data.processSteps) {
    const props = buildPropsString({
      id: step.id, identifier: step.identifier, label: step.label, type: step.type,
      name: step.type,
      hierarchy_level: step.hierarchy_level, isSubProcess: step.isSubProcess,
      isNavigational: step.isNavigational,
      inputPorts: step.inputPorts, outputPorts: step.outputPorts,
      input_ports_count: step.inputPorts.length,
      output_ports_count: step.outputPorts.length,
      is_instrumentation_activity: step.nodeType === 'InstrumentationActivity',
      ...step.attributes
    });
    const typeLabel = escapeLabel(step.type);
    const nodeTypeLabel = step.nodeType;
    queries.push(`CREATE (:${nodeTypeLabel}:${typeLabel} {${props}})`);
  }
  
  // Create CONTAINS relationships for subprocess hierarchy
  for (const step of data.processSteps) {
    if (step.parent) {
      queries.push(`
MATCH (parent {id: '${escapeString(step.parent)}'})
MATCH (child {id: '${escapeString(step.id)}'})
CREATE (parent)-[:CONTAINS]->(child)`);
    }
  }
  
  // Instrumentation: OBSERVES (activity → referenced step) and
  // MEASURES {variable} (activity → step owning the referenced QualifiedValue).
  // A variable carried by a stream has no node to point at; the edge then
  // targets the observed step and records the stream id.
  const stepIds = new Set(data.processSteps.map(s => s.id));
  for (const step of data.processSteps) {
    if (step.nodeType !== 'InstrumentationActivity') continue;
    if (step.processStepRef && stepIds.has(step.processStepRef)) {
      queries.push(`
MATCH (ia {id: '${escapeString(step.id)}'})
MATCH (ps {id: '${escapeString(step.processStepRef)}'})
CREATE (ia)-[:OBSERVES]->(ps)`);
    }
    if (step.measuredVariableRef) {
      const owner = data.qualifiedValueOwners.get(step.measuredVariableRef);
      if (!owner) continue;
      let targetId: string | undefined;
      const relProps: Record<string, string> = {
        variable: owner.property,
        qualifiedValueId: step.measuredVariableRef,
      };
      if (owner.ownerKind === 'step' && stepIds.has(owner.ownerId)) {
        targetId = owner.ownerId;
      } else if (owner.ownerKind === 'stream' && step.processStepRef && stepIds.has(step.processStepRef)) {
        targetId = step.processStepRef;
        relProps.streamId = owner.ownerId;
      }
      if (!targetId) continue;
      queries.push(`
MATCH (ia {id: '${escapeString(step.id)}'})
MATCH (target {id: '${escapeString(targetId)}'})
CREATE (ia)-[:MEASURES {${buildPropsString(relProps)}}]->(target)`);
    }
  }

  // Create Flow relationships (MaterialStream, ElectricalEnergyFlow, etc.)
  for (const stream of data.streams) {
    const sourcePort = data.ports.get(stream.sourcePortId);
    const targetPort = data.ports.get(stream.targetPortId);
    
    if (!sourcePort || !targetPort) {
      continue;
    }
    
    const sourceStepId = sourcePort.ownerStepId;
    const targetStepId = targetPort.ownerStepId;
    
    // Get source and target steps
    const sourceStep = data.processSteps.find(s => s.id === sourceStepId);
    const targetStep = data.processSteps.find(s => s.id === targetStepId);
    
    if (!sourceStep || !targetStep) {
      continue;
    }
    
    const relProps = buildPropsString({
      id: stream.id, identifier: stream.identifier, label: stream.label,
      sourcePort: sourcePort.label, targetPort: targetPort.label,
      materialStateRef: stream.materialStateRef,
      ...stream.attributes
    });
    
    const flowLabel = escapeLabel(stream.flowType);
    
    // Create the main flow relationship between steps
    queries.push(`
MATCH (source {id: '${escapeString(sourceStepId)}'})
MATCH (target {id: '${escapeString(targetStepId)}'})
CREATE (source)-[:${flowLabel} {${relProps}}]->(target)`);
    
  }

  // Cross-level port links. A subprocess port carries `SubReference` to the
  // port of the nested boundary proxy (Source/Sink) that stands in for it
  // inside the subprocess; the proxy's port carries `SuperReference` back.
  // One edge per link, oriented by the parent port's NominalDirection:
  //   Inlet  → (subprocess)-[:SUB_PROCESS_ENTRY {port}]->(proxy)
  //   Outlet → (proxy)-[:SUB_PROCESS_EXIT {port}]->(subprocess)
  // flowType comes from the stream attached to the parent port, falling
  // back to the port class.
  const flowTypeByPortId = new Map<string, string>();
  for (const stream of data.streams) {
    flowTypeByPortId.set(stream.sourcePortId, stream.flowType);
    flowTypeByPortId.set(stream.targetPortId, stream.flowType);
  }
  const portFlowType = (port: PortInfo): string => {
    const fromStream = flowTypeByPortId.get(port.id);
    if (fromStream) return fromStream;
    const bare = (port.type.split('.').pop() || '').replace(/Port$/, '');
    if (bare === 'ThermalEnergy' || bare === 'ElectricalEnergy' || bare === 'MechanicalEnergy') return `${bare}Flow`;
    if (bare === 'Information') return 'InformationFlow';
    return 'MaterialStream';
  };
  const emittedLinks = new Set<string>();
  const emitPortLink = (parentPort: PortInfo, childPort: PortInfo) => {
    const key = `${parentPort.id}→${childPort.id}`;
    if (emittedLinks.has(key)) return;
    emittedLinks.add(key);
    const parentStep = data.processSteps.find(s => s.id === parentPort.ownerStepId);
    const childStep = data.processSteps.find(s => s.id === childPort.ownerStepId);
    if (!parentStep || !childStep) return;
    const props = buildPropsString({
      flowType: portFlowType(parentPort),
      port: parentPort.label || parentPort.id,
      parentPortId: parentPort.id,
      childPortId: childPort.id,
    });
    if (parentPort.direction === 'In') {
      queries.push(`
MATCH (parent {id: '${escapeString(parentStep.id)}'})
MATCH (child {id: '${escapeString(childStep.id)}'})
MERGE (parent)-[:SUB_PROCESS_ENTRY {${props}}]->(child)`);
    } else {
      queries.push(`
MATCH (child {id: '${escapeString(childStep.id)}'})
MATCH (parent {id: '${escapeString(parentStep.id)}'})
MERGE (child)-[:SUB_PROCESS_EXIT {${props}}]->(parent)`);
    }
  };
  for (const port of data.ports.values()) {
    if (port.subReference) {
      const childPort = data.ports.get(port.subReference);
      if (childPort) emitPortLink(port, childPort);
    }
    if (port.superReference) {
      const parentPort = data.ports.get(port.superReference);
      if (parentPort) emitPortLink(parentPort, port);
    }
  }
  
  // Analyze and create subprocess entry/exit relationships
  // This matches Python's analyze_subprocess_flow_connections() approach
  const subprocessFlows = analyzeSubprocessFlows(data.processSteps, data.streams);
  for (const subFlow of subprocessFlows) {
    const relType = escapeLabel(subFlow.relationshipType);
    queries.push(`
MATCH (source {id: '${escapeString(subFlow.source)}'})
MATCH (target {id: '${escapeString(subFlow.target)}'})
MERGE (source)-[:${relType} {
  flowType: '${escapeString(subFlow.flowType)}',
  name: '${escapeString(subFlow.name)}',
  originalFlowId: '${escapeString(subFlow.originalFlowId)}',
  subprocessLevel: ${subFlow.subprocessLevel}
}]->(target)`);
  }
  
  return queries;
}

/**
 * Build properties string for Cypher query
 */
function buildPropsString(props: Record<string, any>): string {
  const parts: string[] = [];
  
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === '') continue;
    
    const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
    
    if (typeof value === 'string') {
      parts.push(`${safeKey}: '${escapeString(value)}'`);
    } else if (typeof value === 'number') {
      parts.push(`${safeKey}: ${value}`);
    } else if (typeof value === 'boolean') {
      parts.push(`${safeKey}: ${value}`);
    } else if (Array.isArray(value)) {
      const arrayStr = value.map(v => `'${escapeString(String(v))}'`).join(', ');
      parts.push(`${safeKey}: [${arrayStr}]`);
    }
  }
  
  return parts.join(', ');
}

/**
 * Escape string for Cypher
 */
function escapeString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

/**
 * Escape label for Cypher (remove special characters)
 */
function escapeLabel(str: string): string {
  return str.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Execute Cypher queries against Neo4j (browser-compatible using HTTP API)
 */
export async function executeNeo4jQueries(
  config: Neo4jConfig,
  queries: string[],
  onProgress?: (current: number, total: number) => void
): Promise<{ success: boolean; message: string; stats?: ExportStats }> {
  // URL + auth translation lives in one place. Handles Aura's
  // neo4j+s:// / bolt+s:// URIs (HTTPS port 7473) and UTF-8 passwords
  // — the inline btoa form throws InvalidCharacterError on any
  // non-Latin1 character (umlauts, Greek letters, etc.).
  const { neo4jHttpDetails } = await import('./neo4jHttpShared');
  const { endpoint, authHeader } = neo4jHttpDetails(config);
  
  let successCount = 0;
  let errorCount = 0;
  const errors: string[] = [];
  
  const batchSize = 50;
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          statements: batch.map(q => ({ statement: q }))
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      
      const result = await response.json();
      
      if (result.errors && result.errors.length > 0) {
        for (const err of result.errors) {
          errors.push(err.message);
          errorCount++;
        }
      } else {
        successCount += batch.length;
      }
      
      if (onProgress) {
        onProgress(Math.min(i + batchSize, queries.length), queries.length);
      }
      
    } catch (error: unknown) {
      errorCount += batch.length;
      errors.push(error instanceof Error ? (error instanceof Error ? error.message : String(error)) : 'Unknown error');
    }
  }
  
  if (errorCount > 0) {
    return {
      success: false,
      message: `Completed with ${errorCount} errors. First error: ${errors[0]}`,
      stats: { successCount, errorCount }
    };
  }
  
  return {
    success: true,
    message: `Successfully executed ${successCount} queries`,
    stats: { successCount, errorCount: 0 }
  };
}

/**
 * Main export function
 */
export async function exportToNeo4j(
  dexpiXml: string,
  config: Neo4jConfig,
  onProgress?: (current: number, total: number) => void
): Promise<{ success: boolean; message: string }> {
  try {
    const data = parseDexpiXml(dexpiXml);
    const queries = generateCypherQueries(data);
    const result = await executeNeo4jQueries(config, queries, onProgress);
    return result;
  } catch (error: unknown) {
    return {
      success: false,
      message: `Export failed: ${(error instanceof Error ? error.message : String(error))}`
    };
  }
}
