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
  parent?: string;
  hierarchyLevel: number;
  isSubProcess: boolean;
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
  flowType: 'MaterialFlow' | 'EnergyFlow' | 'InformationFlow';
  sourcePortId: string;
  targetPortId: string;
  attributes: AttributeMap;
  materialStateRef?: string;
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
  templateRef?: string;
  typeRef?: string;
  attributes: AttributeMap;
}

export interface MaterialStateType {
  id: string;
  identifier: string;
  label: string;
  templateRef?: string;
  fractions: { componentRef: string; massFraction?: string; moleFraction?: string }[];
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
 * Determine flow type from port type string
 */
function determineFlowType(portType: string, portLabel: string): 'MaterialFlow' | 'EnergyFlow' | 'InformationFlow' {
  const normalizedType = portType.toLowerCase();
  const normalizedLabel = portLabel.toUpperCase();
  
  // Check port type first
  if (normalizedType.includes('information')) return 'InformationFlow';
  if (normalizedType.includes('energy') || normalizedType.includes('thermal') || 
      normalizedType.includes('electrical') || normalizedType.includes('mechanical')) return 'EnergyFlow';
  
  // Check label pattern
  if (normalizedLabel.match(/^(IPI|IPO|IOI|IOO|II|IO)/i)) return 'InformationFlow';
  if (normalizedLabel.match(/^(TEI|TEO|EEI|EEO|MEI|MEO)/i)) return 'EnergyFlow';
  
  return 'MaterialFlow';
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
    const processStepsContainer = Array.from(parent.querySelectorAll(':scope > Components[property="ProcessSteps"]'));
    
    for (const container of processStepsContainer) {
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
        
        processSteps.push({
          id,
          identifier,
          label,
          type: type.replace('Process/Process.', '').replace('Process/', ''),
          parent: parentId,
          hierarchyLevel: level,
          isSubProcess: hasSubSteps || false,
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
      
      const sourceRef = streamObj.querySelector('References[property="Source"]');
      const sourcePortId = sourceRef?.getAttribute('objects')?.replace('#', '') || '';
      
      const targetRef = streamObj.querySelector('References[property="Target"]');
      const targetPortId = targetRef?.getAttribute('objects')?.replace('#', '') || '';
      
      const sourcePortInfo = ports.get(sourcePortId);
      const targetPortInfo = ports.get(targetPortId);
      
      if (!sourcePortInfo || !targetPortInfo) continue;
      
      const flowType = determineFlowType(sourcePortInfo.type, sourcePortInfo.label);
      
      let materialStateRef: string | undefined;
      const matStateRefEl = streamObj.querySelector('References[property="MaterialStateReference"] ObjectReference');
      if (matStateRefEl) {
        materialStateRef = matStateRefEl.getAttribute('ref') || undefined;
      }
      
      const attributes = extractAllAttributes(streamObj);
      
      streams.push({
        id,
        identifier,
        label,
        flowType,
        sourcePortId,
        targetPortId,
        attributes,
        materialStateRef
      });
    }
  }
  
  // Parse Material Templates
  const templatesContainer = processModel.querySelector('Components[property="MaterialTemplates"]');
  if (templatesContainer) {
    for (const templateObj of Array.from(templatesContainer.querySelectorAll(':scope > Object'))) {
      const id = templateObj.getAttribute('id') || '';
      const identifier = getDataValue(templateObj, 'Identifier');
      const label = getDataValue(templateObj, 'Label');
      
      const components: string[] = [];
      const componentsContainer = templateObj.querySelector('Components[property="Components"]');
      if (componentsContainer) {
        for (const compRef of Array.from(componentsContainer.querySelectorAll('ObjectReference'))) {
          components.push(compRef.getAttribute('ref') || '');
        }
      }
      
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
  
  // Parse Material State Types
  const stateTypesContainer = processModel.querySelector('Components[property="MaterialStateTypes"]');
  if (stateTypesContainer) {
    for (const typeObj of Array.from(stateTypesContainer.querySelectorAll(':scope > Object'))) {
      const id = typeObj.getAttribute('id') || '';
      const identifier = getDataValue(typeObj, 'Identifier');
      const label = getDataValue(typeObj, 'Label');
      
      let templateRef: string | undefined;
      const templateRefEl = typeObj.querySelector('References[property="TemplateReference"] ObjectReference');
      if (templateRefEl) templateRef = templateRefEl.getAttribute('ref') || undefined;
      
      const fractions: { componentRef: string; massFraction?: string; moleFraction?: string }[] = [];
      const fractionsContainer = typeObj.querySelector('Components[property="Fractions"]');
      if (fractionsContainer) {
        for (const fracObj of Array.from(fractionsContainer.querySelectorAll(':scope > Object'))) {
          const compRefEl = fracObj.querySelector('References[property="ComponentReference"] ObjectReference');
          const compRef = compRefEl?.getAttribute('ref') || '';
          const massValueEl = fracObj.querySelector('Object[property="MassFraction"] Data[property="NumericalValue"] String');
          const moleValueEl = fracObj.querySelector('Object[property="MoleFraction"] Data[property="NumericalValue"] String');
          
          fractions.push({
            componentRef: compRef,
            massFraction: massValueEl?.textContent || undefined,
            moleFraction: moleValueEl?.textContent || undefined
          });
        }
      }
      
      materialStateTypes.push({ id, identifier, label, templateRef, fractions, attributes: extractAllAttributes(typeObj) });
    }
  }
  
  // Parse Material States
  const statesContainer = processModel.querySelector('Components[property="MaterialStates"]');
  if (statesContainer) {
    for (const stateObj of Array.from(statesContainer.querySelectorAll(':scope > Object'))) {
      const id = stateObj.getAttribute('id') || '';
      const identifier = getDataValue(stateObj, 'Identifier');
      const label = getDataValue(stateObj, 'Label');
      
      let templateRef: string | undefined;
      const templateRefEl = stateObj.querySelector('References[property="TemplateReference"] ObjectReference');
      if (templateRefEl) templateRef = templateRefEl.getAttribute('ref') || undefined;
      
      let typeRef: string | undefined;
      const typeRefEl = stateObj.querySelector('References[property="TypeReference"] ObjectReference');
      if (typeRefEl) typeRef = typeRefEl.getAttribute('ref') || undefined;
      
      materialStates.push({ id, identifier, label, templateRef, typeRef, attributes: extractAllAttributes(stateObj) });
    }
  }
  
  return { processSteps, ports, streams, materialTemplates, materialComponents, materialStates, materialStateTypes };
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
    
    if (stateType.templateRef) {
      queries.push(`
MATCH (mst:MaterialStateType {id: '${escapeString(stateType.id)}'})
MATCH (mt:MaterialTemplate {id: '${escapeString(stateType.templateRef)}'})
CREATE (mst)-[:USES_TEMPLATE]->(mt)`);
    }
    
    for (const frac of stateType.fractions) {
      if (frac.componentRef) {
        const fracProps: string[] = [];
        if (frac.massFraction) fracProps.push(`massFraction: ${frac.massFraction}`);
        if (frac.moleFraction) fracProps.push(`moleFraction: ${frac.moleFraction}`);
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
  for (const step of data.processSteps) {
    const props = buildPropsString({
      id: step.id, identifier: step.identifier, label: step.label, type: step.type,
      hierarchyLevel: step.hierarchyLevel, isSubProcess: step.isSubProcess,
      inputPorts: step.inputPorts, outputPorts: step.outputPorts,
      ...step.attributes
    });
    const typeLabel = escapeLabel(step.type);
    queries.push(`CREATE (:ProcessStep:${typeLabel} {${props}})`);
  }
  
  // Create CONTAINS relationships for subprocess hierarchy
  for (const step of data.processSteps) {
    if (step.parent) {
      queries.push(`
MATCH (parent:ProcessStep {id: '${escapeString(step.parent)}'})
MATCH (child:ProcessStep {id: '${escapeString(step.id)}'})
CREATE (parent)-[:CONTAINS]->(child)`);
    }
  }
  
  // Create Flow relationships (MaterialFlow, EnergyFlow, InformationFlow)
  // and SubProcessEntry/SubProcessExit relationships
  for (const stream of data.streams) {
    const sourcePort = data.ports.get(stream.sourcePortId);
    const targetPort = data.ports.get(stream.targetPortId);
    
    if (!sourcePort || !targetPort) continue;
    
    const sourceStepId = sourcePort.ownerStepId;
    const targetStepId = targetPort.ownerStepId;
    
    const relProps = buildPropsString({
      id: stream.id, identifier: stream.identifier, label: stream.label,
      sourcePort: sourcePort.label, targetPort: targetPort.label,
      materialStateRef: stream.materialStateRef,
      ...stream.attributes
    });
    
    const flowLabel = escapeLabel(stream.flowType);
    
    // Create the main flow relationship between tasks
    queries.push(`
MATCH (source:ProcessStep {id: '${escapeString(sourceStepId)}'})
MATCH (target:ProcessStep {id: '${escapeString(targetStepId)}'})
CREATE (source)-[:${flowLabel} {${relProps}}]->(target)`);
    
    // Check for SubProcessEntry: if source port has SubReference, the flow enters a subprocess
    // The parent port points to the child port - create entry from parent subprocess to first internal task
    if (sourcePort.subReference) {
      const childPort = data.ports.get(sourcePort.subReference);
      if (childPort) {
        // Parent subprocess (owner of source port) -> Child task (owner of child port)
        queries.push(`
MATCH (parent:ProcessStep {id: '${escapeString(sourceStepId)}'})
MATCH (child:ProcessStep {id: '${escapeString(childPort.ownerStepId)}'})
MERGE (parent)-[:SUB_PROCESS_ENTRY {flowType: '${stream.flowType}', port: '${escapeString(sourcePort.label)}'}]->(child)`);
      }
    }
    
    // Check for SubProcessExit: if target port has SubReference, the flow exits a subprocess
    if (targetPort.subReference) {
      const childPort = data.ports.get(targetPort.subReference);
      if (childPort) {
        // Child task (owner of child port) -> Parent subprocess (owner of target port)
        queries.push(`
MATCH (child:ProcessStep {id: '${escapeString(childPort.ownerStepId)}'})
MATCH (parent:ProcessStep {id: '${escapeString(targetStepId)}'})
MERGE (child)-[:SUB_PROCESS_EXIT {flowType: '${stream.flowType}', port: '${escapeString(targetPort.label)}'}]->(parent)`);
      }
    }
    
    // Also check SuperReference (child pointing to parent) for additional entry/exit detection
    if (sourcePort.superReference) {
      const parentPort = data.ports.get(sourcePort.superReference);
      if (parentPort) {
        queries.push(`
MATCH (parent:ProcessStep {id: '${escapeString(parentPort.ownerStepId)}'})
MATCH (child:ProcessStep {id: '${escapeString(sourceStepId)}'})
MERGE (parent)-[:SUB_PROCESS_ENTRY {flowType: '${stream.flowType}', port: '${escapeString(parentPort.label)}'}]->(child)`);
      }
    }
    
    if (targetPort.superReference) {
      const parentPort = data.ports.get(targetPort.superReference);
      if (parentPort) {
        queries.push(`
MATCH (child:ProcessStep {id: '${escapeString(targetStepId)}'})
MATCH (parent:ProcessStep {id: '${escapeString(parentPort.ownerStepId)}'})
MERGE (child)-[:SUB_PROCESS_EXIT {flowType: '${stream.flowType}', port: '${escapeString(parentPort.label)}'}]->(parent)`);
      }
    }
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
): Promise<{ success: boolean; message: string; stats?: any }> {
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
      
    } catch (error: any) {
      errorCount += batch.length;
      errors.push(error.message || 'Unknown error');
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
  } catch (error: any) {
    return {
      success: false,
      message: `Export failed: ${error.message}`
    };
  }
}
