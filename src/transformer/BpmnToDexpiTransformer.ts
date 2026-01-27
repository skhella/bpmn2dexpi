import type { DexpiElement, DexpiPort, DexpiStream } from '../dexpi/moddle';

interface TransformOptions {
  projectName?: string;
  projectDescription?: string;
  author?: string;
}

export class BpmnToDexpiTransformer {
  private processSteps: Map<string, any> = new Map();
  private streams: Map<string, any> = new Map();
  private ports: Map<string, any> = new Map();
  private materialTemplates: Map<string, any> = new Map();
  private materialComponents: Map<string, any> = new Map();
  private materialStates: Map<string, any> = new Map();
  private materialStateTypes: Map<string, any> = new Map();

  async transform(bpmnXml: string, options: TransformOptions = {}): Promise<string> {
    
    // Clear state from previous transformations
    this.processSteps.clear();
    this.streams.clear();
    this.ports.clear();
    this.materialTemplates.clear();
    this.materialComponents.clear();
    this.materialStates.clear();
    this.materialStateTypes.clear();
    
    // Parse BPMN XML
    const bpmnModel = this.parseBpmn(bpmnXml);
    
    // Extract DEXPI elements
    this.extractElements(bpmnModel);
    
    // Build DEXPI XML structure
    const dexpiModel = this.buildDexpiModel(options);
    
    // Generate XML
    const xml = this.generateXml(dexpiModel);
    
    return xml;
  }

  private parseBpmn(xml: string): Document {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    
    // Check for parse errors
    const parserError = doc.querySelector('parsererror');
    if (parserError) {
      throw new Error('Failed to parse BPMN XML: ' + parserError.textContent);
    }
    
    return doc;
  }

  private extractElements(doc: Document): void {
    const process = doc.querySelector('process');
    if (!process) return;

    // Extract tasks (ProcessSteps) - only direct children to maintain hierarchy
    // Use > selector to get only direct children, not nested ones
    const topLevelElements = Array.from(process.children).filter(child => {
      const tagName = child.localName || child.tagName.split(':').pop() || '';
      return ['task', 'subprocess', 'servicetask', 'usertask', 'scripttask', 
              'manualtask', 'businessruletask', 'sendtask', 'receivetask', 'callactivity'].includes(tagName.toLowerCase());
    });
    
    topLevelElements.forEach((task) => {
      this.extractProcessStep(task as Element, null);
    });

    // Extract start events (Sources)
    // Proxy events (those matching parent subprocess ports) will be filtered out in extractSource
    const startEvents = Array.from(process.querySelectorAll('startEvent, intermediateCatchEvent'));
    startEvents.forEach((event) => {
      this.extractSource(event);
    });

    // Extract end events (Sinks)
    // Proxy events (those matching parent subprocess ports) will be filtered out in extractSink
    const endEvents = Array.from(process.querySelectorAll('endEvent, intermediateThrowEvent'));
    endEvents.forEach((event) => {
      this.extractSink(event);
    });

    // Extract sequence flows (Streams)
    const sequenceFlows = Array.from(process.querySelectorAll('sequenceFlow'));
    sequenceFlows.forEach((flow) => {
      this.extractStream(flow);
    });

    // Extract data objects (MaterialTemplates, MaterialComponents, MaterialStates)
    const dataObjects = Array.from(process.querySelectorAll('dataObjectReference'));
    dataObjects.forEach((obj) => {
      this.extractMaterialData(obj);
    });
  }

  // Valid DEXPI 2.0 ProcessStep types (from Process.xml schema - ConcreteClass definitions)
  private static readonly VALID_PROCESS_STEP_TYPES = [
    // Base
    'ProcessStep',
    // Reacting
    'ReactingChemicals',
    // Separating (and subtypes)
    'Separating',
    'SeparatingByCentrifugalForce',
    'SeparatingByContact',
    'SeparatingByCyclonicMotion',
    'SeparatingByElectromagneticForce',
    'SeparatingByElectrostaticForce',
    'SeparatingByFlash',
    'SeparatingByGravity',
    'SeparatingByIonExchange',
    'SeparatingByMagneticForce',
    'SeparatingByPhaseSeparation',
    'SeparatingByPhysicalProcess',
    'SeparatingBySurfaceTension',
    'SeparatingByThermalProcess',
    'SeparatingMechanically',
    'Absorbing',
    'Adsorbing',
    'Distilling',
    'StrippingDistilling',
    'StabilizingDistilling',
    'VacuumDistilling',
    'Drying',
    'Evaporating',
    'Filtering',
    'Crystallizing',
    'Sieving',
    'Skimming',
    // Thermal Energy
    'ExchangingThermalEnergy',
    'RemovingThermalEnergy',
    'Cooling',
    'SupplyingThermalEnergy',
    'Boiling',
    'GeneratingSteam',
    'HeatingElectrical',
    'HeatingInFurnace',
    // Mechanical Energy
    'SupplyingMechanicalEnergy',
    'DrivingByEngine',
    'DrivingByMotor',
    'DrivingByTurbine',
    // Electrical Energy
    'SupplyingElectricalEnergy',
    'GeneratingACPower',
    'GeneratingDCPower',
    'GeneratingInFuelCell',
    'TransportingElectricalEnergy',
    // Flow Generation
    'GeneratingFlow',
    'Compressing',
    'Pumping',
    // Steering Flow
    'SteeringFlow',
    'BlowingDown',
    'Draining',
    'FeedingMaterial',
    'LimitingFlow',
    'PreventingBackflow',
    'RegulatingFlow',
    'RelievingOverpressure',
    'RelievingVacuum',
    'RelievingVacuumAndOverpressure',
    'ShuttingOffFlow',
    // Mixing
    'Mixing',
    'MixingSimple',
    'Humidifying',
    'Kneading',
    'RotaryMixing',
    'StaticMixing',
    // Splitting
    'Splitting',
    'SplittingEnergy',
    'SplittingMaterial',
    // Storing
    'StoringEnergy',
    'StoringElectricalEnergy',
    'StoringInBattery',
    'StoringThermalEnergy',
    'StoringMaterial',
    'StoringFluids',
    'StoringInPressureVessel',
    'StoringInTank',
    'StoringSolids',
    'StoringInSilo',
    // Transporting
    'TransportingFluids',
    'TransportingFluidsInChannel',
    'TransportingFluidsInHose',
    'TransportingFluidsInPipe',
    'TransportingSolids',
    'TransportingSolidsContinuously',
    'TransportingSolidsDiscontinuously',
    // Supplying
    'SupplyingFluids',
    'SupplyingSolids',
    // Particle Size
    'IncreasingParticleSize',
    'Agglomerating',
    'Coalescing',
    'Flocculating',
    'ReducingParticleSize',
    'Crushing',
    'Cutting',
    'Grinding',
    'Milling',
    // Forming Solid
    'FormingSolidMaterial',
    'Extruding',
    'Pelletizing',
    // Other Process Steps
    'Emitting',
    'Flaring',
    'Packaging',
    // Source and Sink
    'Source',
    'Sink',
    // Instrumentation Activities
    'InstrumentationActivity',
    'CalculatingProcessVariable',
    'CalculatingRatio',
    'CalculatingSplitRange',
    'TransformingProcessVariable',
    'ControllingProcessVariable',
    'ConveyingSignal',
    'MeasuringProcessVariable'
  ];

  // Common aliases that map to actual DEXPI types
  private static readonly TYPE_ALIASES: Record<string, string> = {
    'measuring': 'MeasuringProcessVariable',
    'controlling': 'ControllingProcessVariable',
    'calculating': 'CalculatingProcessVariable',
    'heating': 'SupplyingThermalEnergy',
    'steeringflow': 'SteeringFlow',
    'feeding': 'FeedingMaterial',
    'storing': 'StoringMaterial',
    'transporting': 'TransportingFluids',
  };

  private inferDexpiTypeFromName(name: string): string {
    // Check if the name directly matches a valid DEXPI type (case-insensitive)
    const normalized = name.trim();
    const normalizedLower = normalized.toLowerCase();
    
    // First check aliases
    if (BpmnToDexpiTransformer.TYPE_ALIASES[normalizedLower]) {
      return BpmnToDexpiTransformer.TYPE_ALIASES[normalizedLower];
    }
    
    // Then check exact match against valid types
    const match = BpmnToDexpiTransformer.VALID_PROCESS_STEP_TYPES.find(
      type => type.toLowerCase() === normalizedLower
    );
    if (match) {
      return match;
    }
    
    // Check if name contains a valid type (for names like "Pump 1" -> "Pumping")
    // This handles partial matches - sort by length descending to match longest first
    const sortedTypes = [...BpmnToDexpiTransformer.VALID_PROCESS_STEP_TYPES]
      .sort((a, b) => b.length - a.length);
    for (const type of sortedTypes) {
      if (normalizedLower.includes(type.toLowerCase())) {
        return type;
      }
    }
    
    // Default to ProcessStep if no match found
    return 'ProcessStep';
  }

  private extractProcessStep(task: Element, parentId: string | null): void {
    const id = task.getAttribute('id') || '';
    const name = task.getAttribute('name') || id;
    const tagName = task.localName || task.tagName.split(':').pop() || '';
    const isSubProcess = tagName.toLowerCase() === 'subprocess';
    
    // Extract DEXPI extension elements
    const dexpiData = this.extractDexpiExtension(task);
    
    // Determine the DEXPI process step type:
    // 1. Use dexpiType from extension if available
    // 2. Fall back to the element name (e.g., "ReactingChemicals", "Separating")
    // 3. Default to "ProcessStep" if neither is a valid DEXPI type
    const dexpiType = dexpiData?.dexpiType || this.inferDexpiTypeFromName(name);
    
    const processStep: any = {
      id,
      name,
      type: dexpiType,
      identifier: dexpiData?.identifier || id,
      uid: dexpiData?.uid || this.generateUid(),
      hierarchyLevel: dexpiData?.hierarchyLevel,
      ports: dexpiData?.ports || [],
      attributes: dexpiData?.attributes || [],
      parentId: parentId,
      subProcessSteps: []
    };


    // Make port IDs unique by prefixing with step ID
    processStep.ports = processStep.ports.map((port: DexpiPort) => ({
      ...port,
      portId: `${id}_${port.portId}`
    }));

    this.processSteps.set(id, processStep);
    
    // If this is a subprocess, recursively extract its child process steps
    if (isSubProcess) {
      const childElements = Array.from(task.children).filter(child => {
        const childTagName = child.localName || child.tagName.split(':').pop() || '';
        return ['task', 'subprocess', 'servicetask', 'usertask', 'scripttask', 
                'manualtask', 'businessruletask', 'sendtask', 'receivetask', 'callactivity'].includes(childTagName.toLowerCase());
      });
      
      childElements.forEach(childTask => {
        this.extractProcessStep(childTask as Element, id);
        processStep.subProcessSteps.push(childTask.getAttribute('id'));
      });
    }
    
    // Register ports
    processStep.ports.forEach((port: DexpiPort) => {
      this.ports.set(port.portId, {
        ...port,
        stepId: id,
        parentPortId: undefined,
        childPortIds: []
      });
    });
    
    // If this is a subprocess, map parent ports to child ports with same name/direction
    // Only map to the FIRST matching child port (not all children with same name)
    if (isSubProcess && processStep.subProcessSteps.length > 0) {
      processStep.ports.forEach((parentPort: DexpiPort) => {
        let foundMatch = false;
        // Find the first matching port in child process steps
        for (const childId of processStep.subProcessSteps) {
          if (foundMatch) break;
          const childStep = this.processSteps.get(childId);
          if (childStep) {
            for (const childPort of childStep.ports) {
              // Match by port name and direction - only first match
              if (childPort.name === parentPort.name && 
                  childPort.direction === parentPort.direction) {
                // Create parent-child port relationship
                const parentPortData = this.ports.get(parentPort.portId);
                const childPortData = this.ports.get(childPort.portId);
                
                if (parentPortData && childPortData) {
                  if (!parentPortData.childPortIds) parentPortData.childPortIds = [];
                  parentPortData.childPortIds.push(childPort.portId);
                  childPortData.parentPortId = parentPort.portId;
                  foundMatch = true;
                  break;
                }
              }
            }
          }
        }
      });
    }
  }

  private extractSource(event: Element): void {
    const id = event.getAttribute('id') || '';
    const name = event.getAttribute('name') || id;
    
    const dexpiData = this.extractDexpiExtension(event);
    
    // Skip proxy events - those that represent ports on parent subprocesses
    if (this.isProxyEvent(event)) {
      return;
    }
    
    // For new format with dexpi:element, check if dexpiType is explicitly set to 'Source'
    // If dexpiType exists but is not 'Source', skip this event (it's a proxy port)
    if (dexpiData?.dexpiType && dexpiData.dexpiType !== 'Source') {
      return;
    }
    
    const source = {
      id,
      name,
      type: 'Source',
      identifier: dexpiData?.identifier || id,
      uid: dexpiData?.uid || this.generateUid(),
      ports: dexpiData?.ports || []
    };

    // Make port IDs unique by prefixing with element ID (same as ProcessSteps)
    source.ports = source.ports.map((port: DexpiPort) => ({
      ...port,
      portId: `${id}_${port.portId}`
    }));

    this.processSteps.set(id, source);
    
    source.ports.forEach((port: DexpiPort) => {
      this.ports.set(port.portId, {
        ...port,
        stepId: id
      });
    });
  }

  private extractSink(event: Element): void {
    const id = event.getAttribute('id') || '';
    const name = event.getAttribute('name') || id;
    
    const dexpiData = this.extractDexpiExtension(event);
    
    // Skip proxy events - those that represent ports on parent subprocesses
    if (this.isProxyEvent(event)) {
      return;
    }
    
    // For new format with dexpi:element, check if dexpiType is explicitly set to 'Sink'
    // If dexpiType exists but is not 'Sink', skip this event (it's a proxy port)
    if (dexpiData?.dexpiType && dexpiData.dexpiType !== 'Sink') {
      return;
    }
    
    const sink = {
      id,
      name,
      type: 'Sink',
      identifier: dexpiData?.identifier || id,
      uid: dexpiData?.uid || this.generateUid(),
      ports: dexpiData?.ports || []
    };

    // Make port IDs unique by prefixing with element ID (same as ProcessSteps)
    sink.ports = sink.ports.map((port: DexpiPort) => ({
      ...port,
      portId: `${id}_${port.portId}`
    }));

    this.processSteps.set(id, sink);
    
    sink.ports.forEach((port: DexpiPort) => {
      this.ports.set(port.portId, {
        ...port,
        stepId: id
      });
    });
  }

  private extractStream(flow: Element): void {
    const id = flow.getAttribute('id') || '';
    const name = flow.getAttribute('name') || id;
    const sourceRef = flow.getAttribute('sourceRef') || '';
    const targetRef = flow.getAttribute('targetRef') || '';
    
    const dexpiData = this.extractDexpiStreamExtension(flow);
    
    const stream = {
      id,
      name,
      identifier: dexpiData?.identifier || id,
      uid: this.generateUid(),
      sourceRef,
      targetRef,
      sourcePortRef: dexpiData?.sourcePortRef,
      targetPortRef: dexpiData?.targetPortRef,
      streamType: dexpiData?.streamType || 'MaterialFlow',
      templateReference: dexpiData?.templateReference,
      materialStateReference: dexpiData?.materialStateReference,
      provenance: dexpiData?.provenance || 'Calculated',
      range: dexpiData?.range || 'Design',
      attributes: dexpiData?.attributes || []
    };

    this.streams.set(id, stream);
  }

  private extractMaterialData(dataObj: Element): void {
    const id = dataObj.getAttribute('id') || '';
    const name = dataObj.getAttribute('name') || id;
    
    const extensionElements = dataObj.querySelector('extensionElements');
    if (!extensionElements) return;

    // Extract MaterialTemplates
    const templates = Array.from(extensionElements.querySelectorAll('MaterialTemplate'));
    templates.forEach(template => {
      const uid = template.getAttribute('uid') || this.generateUid();
      const identifier = this.getChildText(template, 'Identifier');
      const label = this.getChildText(template, 'Label');
      const description = this.getChildText(template, 'Description');
      const numberOfComponents = this.getChildText(template, 'NumberOfMaterialComponents');
      const numberOfPhases = this.getChildText(template, 'NumberOfPhases');

      // Extract component references from ListOfMaterialComponents
      const listOfComponents = Array.from(template.children).find((c: any) => 
        c.tagName === 'ListOfMaterialComponents' || c.localName === 'ListOfMaterialComponents'
      );
      const componentRefs: string[] = [];
      if (listOfComponents) {
        const identifiers = Array.from(listOfComponents.querySelectorAll('MaterialComponentIdentifier'));
        identifiers.forEach((id: Element) => {
          const uidRef = id.getAttribute('uidRef');
          if (uidRef) componentRefs.push(uidRef);
        });
      }

      // Extract phases from ListOfPhases
      const listOfPhases = Array.from(template.children).find((c: any) => 
        c.tagName === 'ListOfPhases' || c.localName === 'ListOfPhases'
      );
      const phases: string[] = [];
      if (listOfPhases) {
        const phaseIdentifiers = Array.from(listOfPhases.querySelectorAll('PhaseIdentifier'));
        phaseIdentifiers.forEach((p: Element) => {
          const identifier = p.getAttribute('Identifier') || this.getChildText(p, 'Identifier');
          if (identifier) phases.push(identifier);
        });
      }

      this.materialTemplates.set(uid, {
        uid,
        identifier,
        label,
        description,
        numberOfComponents,
        numberOfPhases,
        componentRefs,
        phases
      });
    });

    // Extract MaterialComponents
    const components = Array.from(extensionElements.querySelectorAll('MaterialComponent'));
    components.forEach(component => {
      const uid = component.getAttribute('uid') || this.generateUid();
      const identifier = this.getChildText(component, 'Identifier');
      const label = this.getChildText(component, 'Label');
      const description = this.getChildText(component, 'Description');
      const chebiId = this.getChildText(component, 'ChEBI_identifier');
      const iupacId = this.getChildText(component, 'IUPAC_identifier');
      const xsiType = component.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type') || 
                      component.getAttribute('xsi:type') || 'CustomMaterialComponent';

      this.materialComponents.set(uid, {
        uid,
        identifier,
        label,
        description,
        chebiId,
        iupacId,
        xsiType
      });
    });

    // Extract MaterialStates from Case elements (new structure) or direct children (legacy)
    const cases = Array.from(extensionElements.querySelectorAll('Case'));
    const hasNewStructure = cases.length > 0;
    
    if (hasNewStructure) {
      // NEW STRUCTURE: MaterialStates inside Case elements
      cases.forEach(caseElement => {
        // Extract case name
        let caseName: string | null = null;
        for (let i = 0; i < caseElement.children.length; i++) {
          const child = caseElement.children[i];
          const localName = child.localName || child.tagName.split(':').pop() || '';
          if (localName.toLowerCase() === 'casename') {
            caseName = child.textContent || '';
            break;
          }
        }

        // Extract MaterialStates within this Case
        const states = Array.from(caseElement.querySelectorAll('MaterialState'));
        states.forEach(state => {
          this.extractMaterialState(state, caseName || name);
        });
      });
    } else {
      // LEGACY STRUCTURE: MaterialStates directly in extensionElements
      const states = Array.from(extensionElements.querySelectorAll('MaterialState'));
      states.forEach(state => {
        this.extractMaterialState(state, name);
      });
    }
  }

  private extractMaterialState(state: Element, caseName: string): void {
    const uid = state.getAttribute('uid') || this.generateUid();
        const identifier = this.getChildText(state, 'Identifier');
        const label = this.getChildText(state, 'Label');
        const description = this.getChildText(state, 'Description');
        const templateRef = this.getChildValue(state, 'TemplateReference', 'uidRef');

        // Extract Flow data
        const flowElement = Array.from(state.children).find((c: any) => c.tagName === 'Flow' || c.localName === 'Flow');
        let flow: any = null;
        
        if (flowElement) {
          const moleFlowElement = Array.from(flowElement.children).find((c: any) => c.tagName === 'MoleFlow' || c.localName === 'MoleFlow');
          const compositionElement = Array.from(flowElement.children).find((c: any) => c.tagName === 'Composition' || c.localName === 'Composition');
          
          flow = {};
          
          if (moleFlowElement) {
            flow.moleFlow = {
              value: this.getChildText(moleFlowElement as Element, 'Value'),
              unit: this.getChildText(moleFlowElement as Element, 'Unit')
            };
          }
          
          if (compositionElement) {
            const fractions = Array.from((compositionElement as Element).querySelectorAll('Fraction'));
            flow.composition = {
              basis: this.getChildText(compositionElement as Element, 'Basis'),
              display: this.getChildText(compositionElement as Element, 'Display'),
              fractions: fractions.map(f => ({
                value: this.getChildText(f, 'Value'),
                componentRef: this.getChildText(f, 'ComponentReference')
              }))
            };
          }
        }

    // Create MaterialStateType with flow data
    const stateTypeUid = `${uid}_Type`;
    if (flow) {
      this.materialStateTypes.set(stateTypeUid, {
        uid: stateTypeUid,
        identifier: `${identifier}_Type`,
        label: `${label} - Flow Data`,
        description: `Flow data for ${label}`,
        templateRef,
        flow
      });
    }

    // Create MaterialState with metadata and reference to MaterialStateType
    this.materialStates.set(uid, {
      uid,
      identifier,
      label: caseName ? `${caseName} - ${label}` : label,
      description,
      caseName: caseName,
      stateTypeRef: flow ? stateTypeUid : undefined
    });
  }

  private getChildText(parent: Element, childName: string): string {
    const child = Array.from(parent.children).find((c: any) => 
      c.tagName === childName || c.localName === childName
    );
    return child?.textContent || '';
  }

  private getChildValue(parent: Element, childName: string, attrName: string): string {
    const child = Array.from(parent.children).find((c: any) => 
      c.tagName === childName || c.localName === childName
    );
    return child?.getAttribute(attrName) || '';
  }

  private extractDexpiExtension(element: Element): DexpiElement | null {
    const extensionElements = element.querySelector('extensionElements');
    if (!extensionElements) {
      return null;
    }

    
    // Try multiple ways to find the dexpi:element
    let dexpiElement: Element | null = null;
    
    // Method 1: Direct children search (works with namespaces)
    for (let i = 0; i < extensionElements.children.length; i++) {
      const child = extensionElements.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      if (localName.toLowerCase() === 'element') {
        dexpiElement = child;
        break;
      }
    }
    
    if (dexpiElement) {
      const ports = this.extractPortsFromElement(dexpiElement);
      const attributes = this.extractAttributesFromElement(dexpiElement);
      return {
        dexpiType: dexpiElement.getAttribute('dexpiType') || undefined,
        identifier: dexpiElement.getAttribute('identifier') || undefined,
        uid: dexpiElement.getAttribute('uid') || undefined,
        hierarchyLevel: dexpiElement.getAttribute('hierarchyLevel') || undefined,
        ports,
        attributes
      };
    }

    // Fallback: try to find ports directly in extensionElements (legacy format)
    const ports = this.extractPortsFromExtensionElements(extensionElements);
    if (ports.length > 0) {
      return {
        ports
      };
    }

    return null;
  }

  private extractDexpiStreamExtension(element: Element): DexpiStream | null {
    const extensionElements = element.querySelector('extensionElements');
    if (!extensionElements) return null;

    // Try to find stream with or without namespace
    let dexpiStream: Element | null = null;
    for (let i = 0; i < extensionElements.children.length; i++) {
      const child = extensionElements.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      if (localName.toLowerCase() === 'stream') {
        dexpiStream = child;
        break;
      }
    }
    
    if (!dexpiStream) return null;

    // Extract stream attributes and properties
    const attributes: any[] = [];
    let materialStateRef: string | undefined = undefined;
    let templateRef: string | undefined = undefined;
    
    for (let i = 0; i < dexpiStream.children.length; i++) {
      const child = dexpiStream.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      
      if (localName.toLowerCase() === 'streamattribute') {
        // Format 1: StreamAttribute elements
        attributes.push({
          name: child.getAttribute('name') || '',
          value: child.getAttribute('value') || '',
          unit: child.getAttribute('unit') || '',
          scope: child.getAttribute('scope') || 'Design',
          range: child.getAttribute('range') || 'Nominal',
          provenance: child.getAttribute('provenance') || 'Calculated',
          qualifier: child.getAttribute('qualifier') || 'Average'
        });
      } else if (localName.toLowerCase() === 'materialstatereference') {
        materialStateRef = child.getAttribute('uidRef') || undefined;
      } else if (localName.toLowerCase() === 'templatereference') {
        templateRef = child.getAttribute('uidRef') || undefined;
      } else {
        // Format 2: Direct property elements like Temperature, Pressure, MassFlow, etc.
        // These have Value/Unit child elements
        const valueElement = child.querySelector('Value');
        const unitElement = child.querySelector('Unit');
        const scopeElement = child.querySelector('Scope');
        const rangeElement = child.querySelector('Range');
        const provenanceElement = child.querySelector('Provenance');
        const qualifierElement = child.querySelector('Qualifier');
        
        if (valueElement) {
          const propertyName = localName.charAt(0).toUpperCase() + localName.slice(1);
          attributes.push({
            name: propertyName,
            value: valueElement.textContent || '',
            unit: unitElement?.textContent || '',
            scope: scopeElement?.textContent || 'Design',
            range: rangeElement?.textContent || 'Nominal',
            provenance: provenanceElement?.textContent || 'Calculated',
            qualifier: qualifierElement?.textContent || 'Average'
          });
        }
      }
    }

    return {
      identifier: dexpiStream.getAttribute('identifier') || dexpiStream.getAttribute('Identifier') || undefined,
      name: dexpiStream.getAttribute('name') || undefined,
      streamType: dexpiStream.getAttribute('streamType') as any,
      sourcePortRef: dexpiStream.getAttribute('sourcePortRef') || undefined,
      targetPortRef: dexpiStream.getAttribute('targetPortRef') || undefined,
      templateReference: dexpiStream.getAttribute('templateReference') || templateRef,
      materialStateReference: materialStateRef,
      provenance: dexpiStream.getAttribute('provenance') as any,
      range: dexpiStream.getAttribute('range') as any,
      attributes
    };
  }

  private extractAttributesFromElement(dexpiElement: Element): any[] {
    const attributes: any[] = [];
    
    // Iterate through children to find attribute elements
    for (let i = 0; i < dexpiElement.children.length; i++) {
      const child = dexpiElement.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      
      if (localName.toLowerCase() === 'attribute') {
        attributes.push({
          name: child.getAttribute('name') || '',
          value: child.getAttribute('value') || '',
          unit: child.getAttribute('unit') || '',
          scope: child.getAttribute('scope') || 'Design',
          range: child.getAttribute('range') || 'Nominal',
          provenance: child.getAttribute('provenance') || 'Calculated'
        });
      }
    }
    
    return attributes;
  }

  private extractPortsFromElement(dexpiElement: Element): DexpiPort[] {
    const ports: DexpiPort[] = [];
    
    // Iterate through children to find port elements
    for (let i = 0; i < dexpiElement.children.length; i++) {
      const child = dexpiElement.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      
      if (localName.toLowerCase() === 'port') {
        ports.push({
          portId: child.getAttribute('portId') || child.getAttribute('id') || this.generateUid(),
          name: child.getAttribute('name') || child.getAttribute('label') || 'Port',
          portType: (child.getAttribute('portType') || child.getAttribute('type') || 'MaterialPort') as any,
          direction: (child.getAttribute('direction') || 'Inlet') as any,
          anchorSide: child.getAttribute('anchorSide') as any,
          anchorOffset: child.getAttribute('anchorOffset') ? parseFloat(child.getAttribute('anchorOffset')!) : undefined,
          anchorX: child.getAttribute('anchorX') ? parseFloat(child.getAttribute('anchorX')!) : undefined,
          anchorY: child.getAttribute('anchorY') ? parseFloat(child.getAttribute('anchorY')!) : undefined
        });
      }
    }
    
    return ports;
  }

  private extractPorts(dexpiElement: Element): DexpiPort[] {
    // Try with and without namespace prefix
    let ports = Array.from(dexpiElement.querySelectorAll('port'));
    if (ports.length === 0) {
      ports = Array.from(dexpiElement.querySelectorAll('Port'));
    }
    if (ports.length === 0) return [];
    
    return ports.map((port) => ({
      portId: port.getAttribute('portId') || port.getAttribute('id') || this.generateUid(),
      name: port.getAttribute('name') || port.getAttribute('label') || 'Port',
      portType: (port.getAttribute('portType') || port.getAttribute('type') || 'MaterialPort') as any,
      direction: (port.getAttribute('direction') || 'Inlet') as any,
      anchorSide: port.getAttribute('anchorSide') as any,
      anchorOffset: port.getAttribute('anchorOffset') ? parseFloat(port.getAttribute('anchorOffset')!) : undefined,
      anchorX: port.getAttribute('anchorX') ? parseFloat(port.getAttribute('anchorX')!) : undefined,
      anchorY: port.getAttribute('anchorY') ? parseFloat(port.getAttribute('anchorY')!) : undefined
    }));
  }

  private extractPortsFromExtensionElements(extensionElements: Element): DexpiPort[] {
    const portsContainer = extensionElements.querySelector('ports');
    if (!portsContainer) return [];
    
    const ports = Array.from(portsContainer.querySelectorAll('port'));
    if (ports.length === 0) return [];
    
    return ports.map((port) => ({
      portId: port.getAttribute('id') || port.getAttribute('portId') || this.generateUid(),
      name: port.getAttribute('name') || port.getAttribute('label') || 'Port',
      portType: (port.getAttribute('type') || port.getAttribute('portType') || 'MaterialPort') as any,
      direction: (port.getAttribute('direction') || 'Inlet') as any,
      anchorSide: port.getAttribute('anchorSide') as any,
      anchorOffset: port.getAttribute('anchorOffset') ? parseFloat(port.getAttribute('anchorOffset')!) : undefined,
      anchorX: port.getAttribute('anchorX') ? parseFloat(port.getAttribute('anchorX')!) : undefined,
      anchorY: port.getAttribute('anchorY') ? parseFloat(port.getAttribute('anchorY')!) : undefined
    }));
  }

  private buildDexpiModel(options: TransformOptions): any {
    const modelUid = this.generateUid();
    
    // Build ProcessModel object
    const processModelObject: any = {
      '$': {
        'id': modelUid,
        'type': 'Process/ProcessModel'
      }
    };

    // Add ProcessSteps collection if there are any
    if (this.processSteps.size > 0) {
      processModelObject.Components = {
        '$': {
          'property': 'ProcessSteps'
        },
        'Object': this.buildProcessSteps()
      };
    }

    // Add ProcessConnections (Streams) collection if there are any
    if (this.streams.size > 0) {
      if (!processModelObject.Components) {
        processModelObject.Components = [];
      }
      const streamsComponent = {
        '$': {
          'property': 'ProcessConnections'
        },
        'Object': this.buildStreams()
      };
      
      if (Array.isArray(processModelObject.Components)) {
        processModelObject.Components.push(streamsComponent);
      } else {
        processModelObject.Components = [processModelObject.Components, streamsComponent];
      }
    }

    // Add MaterialTemplates collection if there are any
    if (this.materialTemplates.size > 0) {
      if (!processModelObject.Components) {
        processModelObject.Components = [];
      }
      const templatesComponent = {
        '$': {
          'property': 'MaterialTemplates'
        },
        'Object': this.buildMaterialTemplates()
      };
      
      if (Array.isArray(processModelObject.Components)) {
        processModelObject.Components.push(templatesComponent);
      } else {
        processModelObject.Components = [processModelObject.Components, templatesComponent];
      }
    }

    // Add MaterialComponents collection if there are any
    if (this.materialComponents.size > 0) {
      if (!processModelObject.Components) {
        processModelObject.Components = [];
      }
      const componentsComponent = {
        '$': {
          'property': 'MaterialComponents'
        },
        'Object': this.buildMaterialComponents()
      };
      
      if (Array.isArray(processModelObject.Components)) {
        processModelObject.Components.push(componentsComponent);
      } else {
        processModelObject.Components = [processModelObject.Components, componentsComponent];
      }
    }

    // Add MaterialStateTypes collection if there are any
    if (this.materialStateTypes.size > 0) {
      if (!processModelObject.Components) {
        processModelObject.Components = [];
      }
      const stateTypesComponent = {
        '$': {
          'property': 'MaterialStateTypes'
        },
        'Object': this.buildMaterialStateTypes()
      };
      
      if (Array.isArray(processModelObject.Components)) {
        processModelObject.Components.push(stateTypesComponent);
      } else {
        processModelObject.Components = [processModelObject.Components, stateTypesComponent];
      }
    }

    // Add MaterialStates collection if there are any
    if (this.materialStates.size > 0) {
      if (!processModelObject.Components) {
        processModelObject.Components = [];
      }
      const statesComponent = {
        '$': {
          'property': 'MaterialStates'
        },
        'Object': this.buildMaterialStates()
      };
      
      if (Array.isArray(processModelObject.Components)) {
        processModelObject.Components.push(statesComponent);
      } else {
        processModelObject.Components = [processModelObject.Components, statesComponent];
      }
    }

    // Build the full Model structure following DEXPI 2.0.0 specification
    const model: any = {
      'Model': {
        '$': {
          'name': 'process-model',
          'uri': 'http://www.example.org'
        },
        'Import': [
          {
            '$': {
              'prefix': 'Core',
              'source': 'https://data.dexpi.org/models/2.0.0/Core.xml'
            }
          },
          {
            '$': {
              'prefix': 'Process',
              'source': 'https://data.dexpi.org/models/2.0.0/Process.xml'
            }
          }
        ],
        'Object': {
          '$': {
            'type': 'Core/EngineeringModel'
          },
          'Components': {
            '$': {
              'property': 'ConceptualModel'
            },
            'Object': processModelObject
          }
        }
      }
    };

    return model;
  }

  private buildProcessSteps(): any[] {
    const steps: any[] = [];

    // Only build top-level process steps (those without parents)
    this.processSteps.forEach((step) => {
      if (step.parentId) return; // Skip child process steps, they'll be added as SubProcessSteps
      
      steps.push(this.buildProcessStepObject(step));
    });

    return steps;
  }

  private buildProcessStepObject(step: any): any {
      // Build the correct DEXPI type - use Process/Process.{Type} format
      // If step.type is already "Process.X", use it; otherwise wrap it
      const dexpiType = step.type.startsWith('Process.') 
        ? `Process/${step.type}` 
        : `Process/Process.${step.type}`;
      
      const dexpiStep: any = {
        '$': {
          'id': step.uid,
          'type': dexpiType
        },
        'Data': {
          '$': {
            'property': 'Identifier'
          },
          'String': step.identifier
        }
      };

      // Add Label if present
      if (step.name) {
        if (Array.isArray(dexpiStep.Data)) {
          dexpiStep.Data.push({
            '$': {
              'property': 'Label'
            },
            'String': step.name
          });
        } else {
          dexpiStep.Data = [
            dexpiStep.Data,
            {
              '$': {
                'property': 'Label'
              },
              'String': step.name
            }
          ];
        }
      }

      // Add ports as composition properties
      if (step.ports && step.ports.length > 0) {
        const portObjects: any[] = [];
        
        step.ports.forEach((port: DexpiPort) => {
          const portObject: any = {
            '$': {
              'id': port.portId,
              'type': `Process/Process.${port.portType}`
            },
            'Data': [
              {
                '$': {
                  'property': 'Identifier'
                },
                'String': port.portId
              },
              {
                '$': {
                  'property': 'NominalDirection'
                },
                'DataReference': {
                  '$': {
                    'data': `Process/Enumerations.PortDirectionClassification.${port.direction === 'Inlet' ? 'In' : 'Out'}`
                  }
                }
              }
            ]
          };

          // Add Label if present
          if (port.name) {
            portObject.Data.push({
              '$': {
                'property': 'Label'
              },
              'String': port.name
            });
          }

          portObjects.push(portObject);
        });

        // Second pass: add port hierarchy references after all ports are created
        portObjects.forEach((portObject: any) => {
          const portId = portObject.$.id;
          const portData = this.ports.get(portId);
          
          // Add SuperReference if this port has a parent port
          if (portData?.parentPortId) {
            if (!portObject.References) portObject.References = [];
            portObject.References.push({
              '$': {
                'property': 'SuperReference'
              },
              'ObjectReference': {
                '$': {
                  'ref': portData.parentPortId
                }
              }
            });
          }
          
          // Add SubReference if this port has child ports  
          if (portData?.childPortIds && portData.childPortIds.length > 0) {
            if (!portObject.Components) portObject.Components = [];
            const subRefs = portData.childPortIds.map((childId: string) => ({
              'ObjectReference': {
                '$': {
                  'ref': childId
                }
              }
            }));
            
            if (Array.isArray(portObject.Components)) {
              portObject.Components.push({
                '$': {
                  'property': 'SubReference'
                },
                'Object': subRefs
              });
            } else {
              portObject.Components = [{
                '$': {
                  'property': 'SubReference'
                },
                'Object': subRefs
              }];
            }
          }
        });

        dexpiStep.Components = {
          '$': {
            'property': 'Ports'
          },
          'Object': portObjects
        };
        
      }

      // Add SubProcessSteps if this is a subprocess with children
      if (step.subProcessSteps && step.subProcessSteps.length > 0) {
        const subProcessObjects: any[] = [];
        
        step.subProcessSteps.forEach((childId: string) => {
          const childStep = this.processSteps.get(childId);
          if (childStep) {
            subProcessObjects.push(this.buildProcessStepObject(childStep));
          }
        });
        
        if (subProcessObjects.length > 0) {
          if (!dexpiStep.Components) {
            dexpiStep.Components = [];
          }
          if (Array.isArray(dexpiStep.Components)) {
            dexpiStep.Components.push({
              '$': {
                'property': 'SubProcessSteps'
              },
              'Object': subProcessObjects
            });
          } else {
            // If Components is already an object (has Ports), convert to array
            const existingComponents = dexpiStep.Components;
            dexpiStep.Components = [
              existingComponents,
              {
                '$': {
                  'property': 'SubProcessSteps'
                },
                'Object': subProcessObjects
              }
            ];
          }
        }
      }

      // Add ProcessStep Attributes (with Range, Provenance per DEXPI 2.0 QualifiedValue)
      // Use Object with type="Core/QualifiedValue" per DEXPI 2.0 schema
      if (step.attributes && step.attributes.length > 0) {
        step.attributes.forEach((attr: any) => {
          if (!attr.name || !attr.value) return;
          
          // If unit is provided, this is a physical quantity - add as QualifiedValue Object
          if (attr.unit) {
            if (!dexpiStep.Object) {
              dexpiStep.Object = [];
            }

            const qualifiedValueObject: any = {
              '$': {
                'property': attr.name,
                'type': 'Core/QualifiedValue'
              },
              'Data': [
                {
                  '$': { 'property': 'Value' },
                  'PhysicalQuantity': {
                    'Data': [
                      {
                        '$': { 'property': 'Value' },
                        'Number': parseFloat(attr.value) || attr.value
                      },
                      {
                        '$': { 'property': 'Unit' },
                        'String': attr.unit
                      }
                    ]
                  }
                }
              ]
            };

            // Add Provenance at QualifiedValue level
            if (attr.provenance) {
              qualifiedValueObject.Data.push({
                '$': { 'property': 'Provenance' },
                'String': attr.provenance
              });
            }

            // Add Range at QualifiedValue level
            if (attr.range) {
              qualifiedValueObject.Data.push({
                '$': { 'property': 'Range' },
                'String': attr.range
              });
            }

            // Scope is available in DEXPI 2.0 but not typically used on QualifiedValue

            dexpiStep.Object.push(qualifiedValueObject);
          } else {
            // Simple string value - add to Data
            dexpiStep.Data.push({
              '$': {
                'property': attr.name
              },
              'String': attr.value
            });
          }
        });
      }

      // Add HierarchyLevel if present
      if (step.hierarchyLevel) {
        dexpiStep.Data.push({
          '$': {
            'property': 'HierarchyLevel'
          },
          'String': step.hierarchyLevel
        });
      }

      return dexpiStep;
  }

  private buildStreams(): any[] {
    const streamElements: any[] = [];

    this.streams.forEach((stream) => {
      const sourcePort = this.findPortForConnection(stream.sourceRef, stream.sourcePortRef, 'Outlet');
      const targetPort = this.findPortForConnection(stream.targetRef, stream.targetPortRef, 'Inlet');

      if (!sourcePort || !targetPort) {
        console.warn(`Cannot create stream ${stream.id}: missing port references`);
        return;
      }

      const streamType = stream.streamType === 'MaterialFlow' ? 'Stream' : 'EnergyFlow';
      const dexpiStream: any = {
        '$': {
          'id': stream.uid,
          'type': `Process/Process.${streamType}`
        },
        'Data': [
          {
            '$': {
              'property': 'Identifier'
            },
            'String': stream.identifier
          }
        ],
        'References': [
          {
            '$': {
              'objects': `#${sourcePort}`,
              'property': 'Source'
            }
          },
          {
            '$': {
              'objects': `#${targetPort}`,
              'property': 'Target'
            }
          }
        ]
      };

      // Add MaterialStateReference if present
      if (stream.materialStateReference) {
        dexpiStream.References.push({
          '$': {
            'property': 'MaterialStateReference'
          },
          'ObjectReference': {
            '$': {
              'ref': stream.materialStateReference
            }
          }
        });
      }

      // Add Label if present
      if (stream.name) {
        dexpiStream.Data.push({
          '$': {
            'property': 'Label'
          },
          'String': stream.name
        });
      }

      // Add all stream attributes as QualifiedValue Objects per DEXPI 2.0 schema
      if (stream.attributes && stream.attributes.length > 0) {
        stream.attributes.forEach((attr: any) => {
          if (!attr.name || !attr.value) return;
          
          // If unit is provided, this is a physical quantity - add as QualifiedValue Object
          if (attr.unit) {
            if (!dexpiStream.Object) {
              dexpiStream.Object = [];
            }

            const qualifiedValueObject: any = {
              '$': {
                'property': attr.name,
                'type': 'Core/QualifiedValue'
              },
              'Data': [
                {
                  '$': { 'property': 'Value' },
                  'PhysicalQuantity': {
                    'Data': [
                      {
                        '$': { 'property': 'Value' },
                        'Number': parseFloat(attr.value) || attr.value
                      },
                      {
                        '$': { 'property': 'Unit' },
                        'String': attr.unit
                      }
                    ]
                  }
                }
              ]
            };

            // Add Provenance at QualifiedValue level
            if (attr.provenance) {
              qualifiedValueObject.Data.push({
                '$': { 'property': 'Provenance' },
                'String': attr.provenance
              });
            }

            // Add Range at QualifiedValue level
            if (attr.range) {
              qualifiedValueObject.Data.push({
                '$': { 'property': 'Range' },
                'String': attr.range
              });
            }

            // Scope is available in DEXPI 2.0 but typically not used on stream QualifiedValues

            dexpiStream.Object.push(qualifiedValueObject);
          } else {
            // Simple string value - add to Data
            dexpiStream.Data.push({
              '$': {
                'property': attr.name
              },
              'String': attr.value
            });
          }
        });
      }

      streamElements.push(dexpiStream);
    });

    return streamElements;
  }

  private buildMaterialTemplates(): any[] {
    const templates: any[] = [];

    this.materialTemplates.forEach((template) => {
      const dexpiTemplate: any = {
        '$': {
          'id': template.uid,
          'type': 'Process/Process.MaterialTemplate'
        },
        'Data': [
          {
            '$': {
              'property': 'Identifier'
            },
            'String': template.identifier
          }
        ]
      };

      // Add Label if present
      if (template.label) {
        dexpiTemplate.Data.push({
          '$': {
            'property': 'Label'
          },
          'String': template.label
        });
      }

      // Add Description if present
      if (template.description) {
        dexpiTemplate.Data.push({
          '$': {
            'property': 'Description'
          },
          'String': template.description
        });
      }

      // Add NumberOfMaterialComponents if present
      if (template.numberOfComponents) {
        dexpiTemplate.Data.push({
          '$': {
            'property': 'NumberOfMaterialComponents'
          },
          'Number': template.numberOfComponents
        });
      }

      // Add NumberOfPhases if present
      if (template.numberOfPhases) {
        dexpiTemplate.Data.push({
          '$': {
            'property': 'NumberOfPhases'
          },
          'Number': template.numberOfPhases
        });
      }

      // Add ListOfMaterialComponents if present
      if (template.componentRefs && template.componentRefs.length > 0) {
        if (!dexpiTemplate.References) {
          dexpiTemplate.References = [];
        }
        dexpiTemplate.References.push({
          '$': {
            'property': 'ListOfMaterialComponents'
          },
          'ObjectReference': template.componentRefs.map((ref: string) => ({
            '$': {
              'ref': ref
            }
          }))
        });
      }

      // Add ListOfPhases if present
      if (template.phases && template.phases.length > 0) {
        dexpiTemplate.Data.push({
          '$': {
            'property': 'ListOfPhases'
          },
          'String': template.phases.join(', ')
        });
      }

      templates.push(dexpiTemplate);
    });

    return templates;
  }

  private buildMaterialComponents(): any[] {
    const components: any[] = [];

    this.materialComponents.forEach((component) => {
      const dexpiComponent: any = {
        '$': {
          'id': component.uid,
          'type': component.xsiType === 'PureMaterialComponent' ? 'Process/Process.PureMaterialComponent' : 'Process/Process.MaterialComponent'
        },
        'Data': [
          {
            '$': {
              'property': 'Identifier'
            },
            'String': component.identifier
          }
        ]
      };

      // Add Label if present
      if (component.label) {
        dexpiComponent.Data.push({
          '$': {
            'property': 'Label'
          },
          'String': component.label
        });
      }

      // Add Description if present
      if (component.description) {
        dexpiComponent.Data.push({
          '$': {
            'property': 'Description'
          },
          'String': component.description
        });
      }

      // Add ChEBI_identifier if present
      if (component.chebiId) {
        dexpiComponent.Data.push({
          '$': {
            'property': 'ChEBI_identifier'
          },
          'String': component.chebiId
        });
      }

      // Add IUPAC_identifier if present
      if (component.iupacId) {
        dexpiComponent.Data.push({
          '$': {
            'property': 'IUPAC_identifier'
          },
          'String': component.iupacId
        });
      }

      components.push(dexpiComponent);
    });

    return components;
  }

  private buildMaterialStates(): any[] {
    const states: any[] = [];

    this.materialStates.forEach((state) => {
      const dexpiState: any = {
        '$': {
          'id': state.uid,
          'type': 'Process/Process.MaterialState'
        },
        'Data': [
          {
            '$': {
              'property': 'Identifier'
            },
            'String': state.identifier
          }
        ]
      };

      // Add Label if present
      if (state.label) {
        dexpiState.Data.push({
          '$': {
            'property': 'Label'
          },
          'String': state.label
        });
      }

      // Add Description if present
      if (state.description) {
        dexpiState.Data.push({
          '$': {
            'property': 'Description'
          },
          'String': state.description
        });
      }

      // Add State reference to MaterialStateType
      if (state.stateTypeRef) {
        if (!dexpiState.References) {
          dexpiState.References = [];
        }
        dexpiState.References.push({
          '$': {
            'property': 'State'
          },
          'ObjectReference': {
            '$': {
              'ref': state.stateTypeRef
            }
          }
        });
      }

      states.push(dexpiState);
    });

    return states;
  }

  private buildMaterialStateTypes(): any[] {
    const stateTypes: any[] = [];

    this.materialStateTypes.forEach((stateType) => {
      const dexpiStateType: any = {
        '$': {
          'id': stateType.uid,
          'type': 'Process/Process.MaterialStateType'
        },
        'Data': [
          {
            '$': {
              'property': 'Identifier'
            },
            'String': stateType.identifier
          }
        ]
      };

      // Add Label if present
      if (stateType.label) {
        dexpiStateType.Data.push({
          '$': {
            'property': 'Label'
          },
          'String': stateType.label
        });
      }

      // Add Description if present
      if (stateType.description) {
        dexpiStateType.Data.push({
          '$': {
            'property': 'Description'
          },
          'String': stateType.description
        });
      }

      // Add MaterialTemplateReference if present
      if (stateType.templateRef) {
        if (!dexpiStateType.References) {
          dexpiStateType.References = [];
        }
        dexpiStateType.References.push({
          '$': {
            'property': 'MaterialTemplateReference'
          },
          'ObjectReference': {
            '$': {
              'ref': stateType.templateRef
            }
          }
        });
      }

      // Add MoleFlow as QualifiedValue Object per DEXPI 2.0 schema
      if (stateType.flow?.moleFlow) {
        if (!dexpiStateType.Object) {
          dexpiStateType.Object = [];
        }
        dexpiStateType.Object.push({
          '$': {
            'property': 'MoleFlow',
            'type': 'Core/QualifiedValue'
          },
          'Data': [
            {
              '$': { 'property': 'Value' },
              'PhysicalQuantity': {
                'Data': [
                  {
                    '$': { 'property': 'Value' },
                    'Number': stateType.flow.moleFlow.value
                  },
                  {
                    '$': { 'property': 'Unit' },
                    'String': stateType.flow.moleFlow.unit
                  }
                ]
              }
            }
          ]
        });
      }

      // Add Composition as Object
      if (stateType.flow?.composition) {
        const composition = stateType.flow.composition;
        
        if (!dexpiStateType.Object) {
          dexpiStateType.Object = [];
        }

        const compositionObj: any = {
          '$': {
            'property': 'Composition',
            'type': 'Process/Process.Composition'
          },
          'Data': []
        };

        // Add Basis if present
        if (composition.basis) {
          compositionObj.Data.push({
            '$': {
              'property': 'Basis'
            },
            'String': composition.basis
          });
        }

        // Add Display if present
        if (composition.display) {
          compositionObj.Data.push({
            '$': {
              'property': 'Display'
            },
            'String': composition.display
          });
        }

        // Add MoleFractions as PhysicalQuantityVector Object
        if (composition.fractions && composition.fractions.length > 0) {
          const fractionValues = composition.fractions.map((fraction: any) => {
            return typeof fraction === 'string' ? fraction : fraction.value;
          });

          if (!compositionObj.Object) {
            compositionObj.Object = [];
          }

          compositionObj.Object.push({
            '$': {
              'property': 'MoleFractions',
              'type': 'Core/PhysicalQuantityVector'
            },
            'Data': [
              {
                '$': {
                  'property': 'Value'
                },
                'Array': {
                  'Number': fractionValues
                }
              }
            ]
          });
        }

        dexpiStateType.Object.push(compositionObj);
      }

      stateTypes.push(dexpiStateType);
    });

    return stateTypes;
  }

  private findPortForConnection(elementRef: string, portRef: string | undefined, defaultDirection: string): string | null {
    const element = this.processSteps.get(elementRef);
    if (!element) return null;

    // If specific port is referenced, find it
    if (portRef) {
      // Port IDs are now prefixed with elementRef, so try both formats
      const prefixedPortRef = `${elementRef}_${portRef}`;
      
      // First try the prefixed version (new format)
      if (this.ports.has(prefixedPortRef)) {
        return prefixedPortRef;
      }
      
      // Then try the original portRef (in case it's already prefixed)
      if (this.ports.has(portRef)) {
        return portRef;
      }
      
      // Finally, try to find a port on this element that matches the portRef name
      const matchingPort = element.ports.find((p: DexpiPort) => 
        p.name === portRef || p.portId === portRef || p.portId.endsWith(`_${portRef}`)
      );
      return matchingPort ? matchingPort.portId : null;
    }

    // Otherwise, find first port with matching direction
    const matchingPort = element.ports.find((p: DexpiPort) => p.direction === defaultDirection);
    return matchingPort ? matchingPort.portId : null;
  }

  private generateXml(model: any): string {
    try {
      return this.buildXmlString(model);
    } catch (error) {
      console.error('XML generation error:', error);
      throw new Error(`Failed to generate XML: ${(error as Error).message}`);
    }
  }

  private buildXmlString(obj: any, indent: string = ''): string {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += this.objectToXml(obj, indent);
    return xml;
  }

  private objectToXml(obj: any, indent: string = ''): string {
    let xml = '';
    
    for (const key in obj) {
      const value = obj[key];
      
      if (key === '$') {
        // Skip attributes, they're handled separately
        continue;
      }
      
      if (Array.isArray(value)) {
        value.forEach((item) => {
          xml += this.elementToXml(key, item, indent);
        });
      } else {
        xml += this.elementToXml(key, value, indent);
      }
    }
    
    return xml;
  }

  private elementToXml(tagName: string, value: any, indent: string): string {
    const nextIndent = indent + '  ';
    
    if (value === null || value === undefined) {
      return '';
    }
    
    let xml = `${indent}<${tagName}`;
    
    // Add attributes
    if (value.$ && typeof value.$ === 'object') {
      for (const attrName in value.$) {
        const attrValue = value.$[attrName];
        if (attrValue !== null && attrValue !== undefined) {
          xml += ` ${attrName}="${this.escapeXml(String(attrValue))}"`;
        }
      }
    }
    
    // Check if element has content or children
    const hasChildren = Object.keys(value).some(k => k !== '$');
    
    if (!hasChildren && typeof value !== 'object') {
      // Simple text content
      xml += `>${this.escapeXml(String(value))}</${tagName}>\n`;
    } else if (!hasChildren) {
      // Self-closing tag
      xml += '/>\n';
    } else if (typeof value === 'string') {
      xml += `>${this.escapeXml(value)}</${tagName}>\n`;
    } else {
      // Has children
      xml += '>\n';
      xml += this.objectToXml(value, nextIndent);
      xml += `${indent}</${tagName}>\n`;
    }
    
    return xml;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Check if an event is a proxy event (represents a port on parent subprocess)
   * Uses the same logic as DexpiRenderer.isPortProxyEvent()
   * Also checks for events without ports that connect to activities with matching port names
   */
  private isProxyEvent(event: Element): boolean {
    // Get the event's port information
    const extensionElements = event.querySelector('extensionElements');
    if (!extensionElements) {
      // Check if this is an event without ports that connects to an activity
      // (e.g., energy interface events like EEI1)
      return this.isPortlessProxyEvent(event);
    }

    // Find the ports container
    let portsContainer: Element | null = null;
    for (let i = 0; i < extensionElements.children.length; i++) {
      const child = extensionElements.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      if (localName.toLowerCase() === 'ports') {
        portsContainer = child;
        break;
      }
    }

    if (!portsContainer) {
      // No ports container found - check portless proxy pattern
      return this.isPortlessProxyEvent(event);
    }

    // Extract event's port name and direction
    let eventPortName: string | null = null;
    let eventPortDirection: string | null = null;

    const portElements = portsContainer.querySelectorAll('port');
    if (portElements.length > 0) {
      const firstPort = portElements[0];
      eventPortName = firstPort.getAttribute('name') || firstPort.getAttribute('label');
      eventPortDirection = (firstPort.getAttribute('direction') || '').toLowerCase();
    }

    if (!eventPortName) return false;

    // Find the parent element
    const parentElement = event.parentElement;
    if (!parentElement) return false;

    // Check if parent is a subprocess
    const parentTagName = (parentElement.localName || parentElement.tagName.split(':').pop() || '').toLowerCase();
    if (parentTagName !== 'subprocess' && parentTagName !== 'process') {
      return false;
    }

    // Get parent's port information
    const parentExtensions = parentElement.querySelector('extensionElements');
    if (!parentExtensions) return false;

    // Find parent's ports container
    let parentPortsContainer: Element | null = null;
    for (let i = 0; i < parentExtensions.children.length; i++) {
      const child = parentExtensions.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      if (localName.toLowerCase() === 'ports') {
        parentPortsContainer = child;
        break;
      }
    }

    if (!parentPortsContainer) return false;

    // Check if parent has a matching port
    const parentPorts = parentPortsContainer.querySelectorAll('port');
    for (const parentPort of Array.from(parentPorts)) {
      const parentPortName = parentPort.getAttribute('name') || parentPort.getAttribute('label');
      const parentPortDirection = (parentPort.getAttribute('direction') || '').toLowerCase();

      // Check if port names match
      if (parentPortName === eventPortName) {
        // Check direction compatibility:
        // Event outlet -> parent inlet (event outputs to internal tasks, parent receives input)
        // Event inlet -> parent outlet (event receives from internal tasks, parent outputs)
        if (eventPortDirection === 'outlet' && parentPortDirection === 'inlet') {
          return true;
        }
        if (eventPortDirection === 'inlet' && parentPortDirection === 'outlet') {
          return true;
        }
        // If no direction specified, match by name only
        if (!eventPortDirection || !parentPortDirection) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if an event without ports is a proxy by examining its connected activity
   * Pattern: Event (e.g., "EEI1") flows to/from an activity that has a port matching the event's name
   */
  private isPortlessProxyEvent(event: Element): boolean {
    const eventName = event.getAttribute('name');
    if (!eventName) return false;

    // Get event type to determine direction
    const eventType = (event.localName || event.tagName.split(':').pop() || '').toLowerCase();
    const isStartEvent = eventType.includes('startevent');
    const isEndEvent = eventType.includes('endevent');

    // Find the connected activity via sequence flow
    let targetActivity: Element | null = null;

    if (isStartEvent) {
      // For start events, look at outgoing flows
      const outgoing = event.querySelector('outgoing');
      if (outgoing) {
        const flowId = outgoing.textContent?.trim();
        if (flowId) {
          // Find the sequence flow element
          const sequenceFlow = event.ownerDocument.querySelector(`[id="${flowId}"]`);
          if (sequenceFlow) {
            const targetRef = sequenceFlow.getAttribute('targetRef');
            if (targetRef) {
              targetActivity = event.ownerDocument.querySelector(`[id="${targetRef}"]`);
            }
          }
        }
      }
    } else if (isEndEvent) {
      // For end events, look at incoming flows
      const incoming = event.querySelector('incoming');
      if (incoming) {
        const flowId = incoming.textContent?.trim();
        if (flowId) {
          const sequenceFlow = event.ownerDocument.querySelector(`[id="${flowId}"]`);
          if (sequenceFlow) {
            const sourceRef = sequenceFlow.getAttribute('sourceRef');
            if (sourceRef) {
              targetActivity = event.ownerDocument.querySelector(`[id="${sourceRef}"]`);
            }
          }
        }
      }
    }

    if (!targetActivity) return false;

    // Check if the connected activity has a port matching the event's name
    const activityExtensions = targetActivity.querySelector('extensionElements');
    if (!activityExtensions) return false;

    // Find ports container in activity
    let portsContainer: Element | null = null;
    for (let i = 0; i < activityExtensions.children.length; i++) {
      const child = activityExtensions.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      if (localName.toLowerCase() === 'ports') {
        portsContainer = child;
        break;
      }
    }

    if (!portsContainer) return false;

    // Check if any port name matches the event name
    const portElements = portsContainer.querySelectorAll('port');
    for (const port of Array.from(portElements)) {
      const portName = port.getAttribute('name') || port.getAttribute('label');
      if (portName === eventName) {
        // Found a matching port - this event is a proxy
        return true;
      }
    }

    return false;
  }

  private generateUid(): string {
    return `uid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

export const transformer = new BpmnToDexpiTransformer();
