/**
 * Neo4j Exporter for DEXPI XML
 * Parses DEXPI XML and exports to Neo4j graph database
 * 
 * Features:
 * - ProcessSteps as nodes with ports as properties
 * - Flow relationships (MaterialFlow, EnergyFlow, InformationFlow) on ALL hierarchy levels
 * - SubProcessEntry/SubProcessExit relationships using SubReference pattern
 * - CONTAINS relationships for subprocess hierarchy
 * - Generic attribute parsing for any DEXPI property
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
}

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
 * Check if a process step should be treated as a navigational event
 * Navigational events are port connectors used for subprocess boundaries
 * They have Sub/SuperReferences but are NOT explicitly typed as Source, Sink, or specific process steps
 */
function isNavigationalEvent(elementType: string, ports: PortInfo[]): boolean {
  if (!ports || ports.length === 0) return false;
  
  // If element is explicitly typed as Source or Sink, it's NOT navigational
  const normalizedType = elementType.toLowerCase();
  if (normalizedType.includes('source') || normalizedType.includes('sink')) {
    return false;
  }
  
  // Check if any port has a SubReference or SuperReference
  // These references indicate this is a port connector linking parent/child subprocess boundaries
  for (const port of ports) {
    if (port.subReference || port.superReference) {
      return true;
    }
  }
  
  return false;
}

/**
 * Generic attribute extractor - extracts all Data and Object elements from an XML element
 */
function extractAllAttributes(element: Element): AttributeMap {
  const attrs: AttributeMap = {};
  
  // Get direct Data children
  const dataElements = element.querySelectorAll(':scope > Data');
  for (const dataEl of Array.from(dataElements)) {
    const property = dataEl.getAttribute('property');
    if (!property || property === 'Identifier' || property === 'Label') continue;
    
    const stringEl = dataEl.querySelector('String');
    const numberEl = dataEl.querySelector('Number');
    const boolEl = dataEl.querySelector('Boolean');
    const dataRef = dataEl.querySelector('DataReference');
    
    if (stringEl?.textContent) {
      attrs[property] = stringEl.textContent;
    } else if (numberEl?.textContent) {
      attrs[property] = parseFloat(numberEl.textContent);
    } else if (boolEl?.textContent) {
      attrs[property] = boolEl.textContent.toLowerCase() === 'true';
    } else if (dataRef) {
      const refValue = dataRef.getAttribute('data') || '';
      const parts = refValue.split('.');
      attrs[property] = parts[parts.length - 1] || refValue;
    }
  }
  
  // Get Object children that represent qualified values (MassFlow, Temperature, etc.)
  const objectElements = element.querySelectorAll(':scope > Object[property]');
  for (const objEl of Array.from(objectElements)) {
    const property = objEl.getAttribute('property');
    if (!property) continue;
    
    // Try PhysicalQuantity format
    const physQty = objEl.querySelector('PhysicalQuantity');
    if (physQty) {
      const valueEl = physQty.querySelector('Data[property="Value"] Number');
      const unitEl = physQty.querySelector('Data[property="Unit"] String');
      if (valueEl?.textContent) attrs[`${property}_value`] = parseFloat(valueEl.textContent);
      if (unitEl?.textContent) attrs[`${property}_unit`] = unitEl.textContent;
    } else {
      // Try QualifiedValue format
      const valueData = objEl.querySelector('Data[property="Value"]');
      if (valueData) {
        const physQtyInner = valueData.querySelector('PhysicalQuantity');
        if (physQtyInner) {
          const valueEl = physQtyInner.querySelector('Data[property="Value"] Number');
          const unitEl = physQtyInner.querySelector('Data[property="Unit"] String');
          if (valueEl?.textContent) attrs[`${property}_value`] = parseFloat(valueEl.textContent);
          if (unitEl?.textContent) attrs[`${property}_unit`] = unitEl.textContent;
        }
      }
      
      const provenanceEl = objEl.querySelector('Data[property="Provenance"] String');
      const rangeEl = objEl.querySelector('Data[property="Range"] String');
      if (provenanceEl?.textContent) attrs[`${property}_provenance`] = provenanceEl.textContent;
      if (rangeEl?.textContent) attrs[`${property}_range`] = rangeEl.textContent;
    }
  }
  
  return attrs;
}

/**
 * Get text content from a Data element
 */
function getDataValue(element: Element, property: string): string {
  const dataEl = Array.from(element.querySelectorAll(':scope > Data'))
    .find(d => d.getAttribute('property') === property);
  if (dataEl) {
    const stringEl = dataEl.querySelector('String');
    const numberEl = dataEl.querySelector('Number');
    return stringEl?.textContent || numberEl?.textContent || '';
  }
  return '';
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
            
            // Get SubReference (parent port -> child port)
            let subReference: string | undefined;
            const subRefContainer = portObj.querySelector('Components[property="SubReference"]');
            if (subRefContainer) {
              const objRef = subRefContainer.querySelector('ObjectReference');
              subReference = objRef?.getAttribute('ref') || undefined;
            }
            
            // Get SuperReference (child port -> parent port)
            let superReference: string | undefined;
            const superRefEl = portObj.querySelector('References[property="SuperReference"] ObjectReference');
            if (superRefEl) {
              superReference = superRefEl.getAttribute('ref') || undefined;
            }
            
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
          attributes
        });
        
        // Recursively parse sub-process steps
        if (hasSubSteps) {
          parseProcessSteps(stepObj, id, level + 1);
        }
      }
    }
  }
  
  parseProcessSteps(processModel, undefined, 0);
  
  // Parse Process Connections (Streams)
  const connectionsContainer = processModel.querySelector('Components[property="ProcessConnections"]');
  if (connectionsContainer) {
    const streamObjects = connectionsContainer.querySelectorAll(':scope > Object');
    
    for (const streamObj of Array.from(streamObjects)) {
      const id = streamObj.getAttribute('id') || '';
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
      
      // Use the new flow type determination based on port labels
      const flowType = determineFlowType(sourcePortInfo.label);
      
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
  // (MoleFractiona — sic per Process.xml — or MassFractions) and whose
  // Data property="Values" entries are the positional per-component
  // fraction values. Build a uid → {basis, values} map for the
  // MaterialStateType pass below to consult.
  type CompositionData = { basis: 'Mole' | 'Mass'; values: string[] };
  const compositionDataByUid = new Map<string, CompositionData>();
  const compositionsContainer = processModel.querySelector('Components[property="Compositions"]');
  if (compositionsContainer) {
    for (const compObj of Array.from(compositionsContainer.querySelectorAll(':scope > Object'))) {
      const compId = compObj.getAttribute('id') || '';
      // Identify the fractions carrier by canonical property name.
      const moleCarrier = compObj.querySelector(':scope > Components[property="MoleFractiona"]');
      const massCarrier = compObj.querySelector(':scope > Components[property="MassFractions"]');
      const carrier = moleCarrier ?? massCarrier;
      if (!carrier) continue;
      const basis: 'Mole' | 'Mass' = moleCarrier ? 'Mole' : 'Mass';
      const qvObject = carrier.querySelector(':scope > Object[type="Core/QualifiedValue"]');
      if (!qvObject) continue;
      const valueEls = Array.from(qvObject.querySelectorAll(':scope > Data[property="Values"]'));
      const values: string[] = [];
      for (const v of valueEls) {
        const txt = v.querySelector('String')?.textContent ?? v.textContent ?? '';
        values.push(txt.trim());
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
      materialStateTypes.push({
        id, identifier, label,
        compositionRef,
        fractions: [],
        attributes: extractAllAttributes(typeObj),
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

  return { processSteps, ports, streams, materialTemplates, materialComponents, materialStates, materialStateTypes };
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

/**
 * Generate Cypher queries for Neo4j import
 */
export function generateCypherQueries(data: DexpiGraphData): string[] {
  const queries: string[] = [];
  
  // Clear existing data
  queries.push('MATCH (n) DETACH DELETE n');
  
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
  
  // Create Process Steps with ports as properties
  // Use proper node types: ProcessStep, Source, Sink, InstrumentationActivity
  for (const step of data.processSteps) {
    const props = buildPropsString({
      id: step.id, identifier: step.identifier, label: step.label, type: step.type,
      hierarchy_level: step.hierarchy_level, isSubProcess: step.isSubProcess,
      isNavigational: step.isNavigational,
      inputPorts: step.inputPorts, outputPorts: step.outputPorts,
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
    
    // Check for SubProcessEntry: if source port has SubReference, the flow enters a subprocess
    // The parent port points to the child port - create entry from parent subprocess to first internal task
    if (sourcePort.subReference) {
      const childPort = data.ports.get(sourcePort.subReference);
      if (childPort) {
        // Parent subprocess (owner of source port) -> Child task (owner of child port)
        queries.push(`
MATCH (parent {id: '${escapeString(sourceStepId)}'})
MATCH (child {id: '${escapeString(childPort.ownerStepId)}'})
MERGE (parent)-[:SUB_PROCESS_ENTRY {flowType: '${stream.flowType}', port: '${escapeString(sourcePort.label)}'}]->(child)`);
      }
    }
    
    // Check for SubProcessExit: if target port has SubReference, the flow exits a subprocess
    if (targetPort.subReference) {
      const childPort = data.ports.get(targetPort.subReference);
      if (childPort) {
        // Child task (owner of child port) -> Parent subprocess (owner of target port)
        queries.push(`
MATCH (child {id: '${escapeString(childPort.ownerStepId)}'})
MATCH (parent {id: '${escapeString(targetStepId)}'})
MERGE (child)-[:SUB_PROCESS_EXIT {flowType: '${stream.flowType}', port: '${escapeString(targetPort.label)}'}]->(parent)`);
      }
    }
    
    // Also check SuperReference (child pointing to parent) for additional entry/exit detection
    if (sourcePort.superReference) {
      const parentPort = data.ports.get(sourcePort.superReference);
      if (parentPort) {
        queries.push(`
MATCH (parent {id: '${escapeString(parentPort.ownerStepId)}'})
MATCH (child {id: '${escapeString(sourceStepId)}'})
MERGE (parent)-[:SUB_PROCESS_ENTRY {flowType: '${stream.flowType}', port: '${escapeString(parentPort.label)}'}]->(child)`);
      }
    }
    
    if (targetPort.superReference) {
      const parentPort = data.ports.get(targetPort.superReference);
      if (parentPort) {
        queries.push(`
MATCH (child {id: '${escapeString(targetStepId)}'})
MATCH (parent {id: '${escapeString(parentPort.ownerStepId)}'})
MERGE (child)-[:SUB_PROCESS_EXIT {flowType: '${stream.flowType}', port: '${escapeString(parentPort.label)}'}]->(parent)`);
      }
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
  const { uri, user, password, database = 'neo4j' } = config;
  
  let httpUri = uri;
  if (uri.startsWith('bolt://')) {
    httpUri = uri.replace('bolt://', 'http://').replace(':7687', ':7474');
  } else if (uri.startsWith('neo4j://')) {
    httpUri = uri.replace('neo4j://', 'http://').replace(':7687', ':7474');
  }
  
  const endpoint = `${httpUri}/db/${database}/tx/commit`;
  const auth = btoa(`${user}:${password}`);
  
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
          'Authorization': `Basic ${auth}`,
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
