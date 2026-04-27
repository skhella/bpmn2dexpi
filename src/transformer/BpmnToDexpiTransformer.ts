import type { DexpiElement, DexpiPort, DexpiStream } from '../dexpi/moddle';
import type {
  InternalProcessStep,
  InternalPort,
  InternalStream,
  InternalMaterialTemplate,
  InternalMaterialComponent,
  InternalMaterialState,
  InternalMaterialStateType,
  StreamAttribute,
  TransformOptions,
  StepTypingResult,
} from './types';
import { TransformerLogger } from './TransformerLogger';
import { DexpiProcessClassRegistry } from './DexpiProcessClassRegistry';

export type { TransformOptions } from './types';
export { validateDexpiOutput } from './DexpiOutputValidator';

export class BpmnToDexpiTransformer {
  private processSteps: Map<string, InternalProcessStep> = new Map();
  private streams: Map<string, InternalStream> = new Map();
  private informationFlows: Map<string, InternalStream> = new Map();
  private ports: Map<string, InternalPort> = new Map();
  private doc: Document | null = null;
  private materialTemplates: Map<string, InternalMaterialTemplate> = new Map();
  private materialComponents: Map<string, InternalMaterialComponent> = new Map();
  private materialStates: Map<string, InternalMaterialState> = new Map();
  private materialStateTypes: Map<string, InternalMaterialStateType> = new Map();

  /** Warnings and errors collected during the last call to transform(). */
  readonly logger = new TransformerLogger();

  async transform(bpmnXml: string, options: TransformOptions = {}): Promise<string> {
    
    // Clear state and log from previous transformations
    this.logger.reset();

    // Load DEXPI class registry from Process.xml (fast — cached after first call)
    // In browser: caller passes options.processXml. In Node: reads from disk.
    this.registry = await DexpiProcessClassRegistry.load(options.processXml);
    if (this.registry.size === 0) {
      this.logger.warn(
        'Could not load dexpi-schema-files/Process.xml — class validation disabled. ' +
        'All dexpiType annotations will be accepted without validation.'
      );
    }
    this.processSteps.clear();
    this.streams.clear();
    this.informationFlows.clear();
    this.ports.clear();
    this.materialTemplates.clear();
    this.materialComponents.clear();
    this.materialStates.clear();
    this.materialStateTypes.clear();
    
    // Parse BPMN XML
    const bpmnModel = this.parseBpmn(bpmnXml);
    this.doc = bpmnModel;
    
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
    // Strip bpmn: / bpmn2: namespace prefixes from element tags so that
    // querySelector('process'), querySelectorAll('startEvent'), etc. work
    // identically across jsdom, happy-dom, and other DOM implementations.
    // Only element-name prefixes are stripped; attribute content is preserved.
    const normalizedXml = xml.replace(/<(\/?)bpmn2?:/gi, '<$1');
    const doc = parser.parseFromString(normalizedXml, 'text/xml');
    
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
    const startEvents = Array.from(process.querySelectorAll('startEvent, intermediateCatchEvent'));
    startEvents.forEach((event) => {
      this.extractSource(event);
    });

    // Extract end events (Sinks)
    const endEvents = Array.from(process.querySelectorAll('endEvent, intermediateThrowEvent'));
    endEvents.forEach((event) => {
      this.extractSink(event);
    });

    // Now that all ports are registered, resolve sub/superReference links.
    // Must happen after all extractSource/extractSink calls so proxy-event ports exist.
    this.processSteps.forEach((step) => {
      if (!step.subProcessSteps?.length) return;
      step.ports.forEach((parentPort: DexpiPort) => {
        const parentPortData = this.ports.get(parentPort.portId);
        if (!parentPortData || parentPortData.childPortIds?.length) return; // already resolved
        const subRef = parentPort.subReference;
        if (!subRef) return;
        const childPortData = this.ports.get(subRef);
        if (childPortData) {
          if (!parentPortData.childPortIds) parentPortData.childPortIds = [];
          parentPortData.childPortIds.push(subRef);
          childPortData.parentPortId = parentPort.portId;
        }
      });
    });

    // Extract sequence flows (MaterialFlow / EnergyFlow streams)
    const sequenceFlows = Array.from(process.querySelectorAll('sequenceFlow'));
    sequenceFlows.forEach((flow) => {
      this.extractStream(flow);
    });

    // Extract InformationFlows — two paths:
    // 1. Plain bpmn:Association elements (direct task-to-task, annotated with streamType=InformationFlow)
    const associations = Array.from(process.querySelectorAll('association'));
    associations.forEach((assoc) => {
      this.extractInformationFlow(assoc);
    });

    // 2. DataObject-mediated flows: Task --[dataOutputAssociation]--> DataObject --[dataInputAssociation]--> Task
    //    Build a graph through the DataObject and stitch into single InformationFlows
    this.extractDataObjectInformationFlows(process);

    // Extract data objects (MaterialTemplates, MaterialComponents, MaterialStates)
    const dataObjects = Array.from(process.querySelectorAll('dataObjectReference'));
    dataObjects.forEach((obj) => {
      this.extractMaterialData(obj);
    });
  }

  // Valid DEXPI 2.0 ProcessStep types (from Process.xml schema - ConcreteClass definitions)
  /**
   * DEXPI Process class registry — loaded from dexpi-schema-files/Process.xml.
   * Replaces the previous hardcoded class list. To update when DEXPI releases
   * a new version: replace Process.xml, no code changes needed.
   */
  private registry: DexpiProcessClassRegistry = DexpiProcessClassRegistry.empty();

  /**
   * Resolve the DEXPI type for a process step — three-mode system:
   *
   * Resolve the DEXPI type for a process step — two-mode system:
   *
   * Mode 1 'dexpi-validated':
   *   dexpiType annotation present AND class is in the official Process.xml registry.
   *   Clean output, no warning.
   *
   * Mode 2 'unvalidated':
   *   Either no dexpiType annotation, OR annotation not found in the registry.
   *   Both cases export as generic 'ProcessStep'. customUri stored if provided.
   *   A "did you mean?" hint is emitted when the annotation is a near-miss.
   */
  private resolveStepType(
    annotatedType: string | undefined,
    customUri: string | undefined,
    taskName: string,
    taskId: string
  ): StepTypingResult {

    // ── Mode 1: explicit annotation, validated against registry ──────────────
    if (annotatedType) {
      if (this.registry.size === 0 || this.registry.isValidClass(annotatedType)) {
        return { dexpiClass: annotatedType, mode: 'dexpi-validated' };
      }
    }

    // ── Mode 2: unvalidated — no annotation OR unrecognised type ─────────────
    // Both cases are treated identically: generic ProcessStep output.
    const suggestion = annotatedType ? this.findClosestDexpiClass(annotatedType) : undefined;

    if (annotatedType) {
      this.logger.warn(
        `Task "${taskName}" (id=${taskId}): dexpiType="${annotatedType}" is not a recognised ` +
        `DEXPI 2.0 Process class — exporting as generic ProcessStep.` +
        (suggestion ? ` Did you mean "${suggestion}"?` : '')
      );
    } else {
      this.logger.warn(
        `Task "${taskName}" (id=${taskId}) has no dexpiType annotation. ` +
        `Exporting as generic ProcessStep. ` +
        `Add a dexpiType in extensionElements to assign a specific DEXPI class.`
      );
    }

    return {
      dexpiClass: 'ProcessStep',
      mode: 'unvalidated',
      customUri,
      suggestedDexpiClass: suggestion,
    };
  }
  /** Find the closest known DEXPI class for a non-registry type (for suggestions). */
  private findClosestDexpiClass(unknown: string): string | undefined {
    if (this.registry.size === 0) return undefined;
    const lower = unknown.toLowerCase();
    // Simple prefix/substring match for suggestion
    return this.registry.concreteClasses().find(c =>
      c.toLowerCase().startsWith(lower.slice(0, 4)) ||
      lower.includes(c.toLowerCase().slice(0, 5))
    );
  }

  private extractProcessStep(task: Element, parentId: string | null): void {
    const id = task.getAttribute('id') || '';
    const name = task.getAttribute('name') || id;
    const tagName = task.localName || task.tagName.split(':').pop() || '';
    const isSubProcess = tagName.toLowerCase() === 'subprocess';
    
    // Extract DEXPI extension elements
    const dexpiData = this.extractDexpiExtension(task);
    
    // Resolve DEXPI type — three-mode system (see resolveStepType)
    const typing = this.resolveStepType(
      dexpiData?.dexpiType,
      dexpiData?.customUri,
      name,
      id
    );
    
    const processStep: InternalProcessStep = {
      id,
      name,
      type: typing.dexpiClass,
      typingMode: typing.mode,
      customUri: typing.customUri,
      suggestedDexpiClass: typing.suggestedDexpiClass,
      identifier: dexpiData?.identifier || id,
      uid: dexpiData?.uid || this.generateUid(),
      hierarchyLevel: dexpiData?.hierarchyLevel,
      ports: dexpiData?.ports || [],
      attributes: dexpiData?.attributes || [],
      parentId: parentId,
      subProcessSteps: []
    };


    // Make port IDs globally unique by prefixing with step ID.
    // Skip if the port ID already contains the step ID as a prefix
    // (happens when port IDs were pre-normalized to include the task prefix).
    processStep.ports = processStep.ports.map((port: DexpiPort) => ({
      ...port,
      portId: port.portId.startsWith(`${id}_`) ? port.portId : `${id}_${port.portId}`
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
        processStep.subProcessSteps.push(childTask.getAttribute('id') ?? '');
      });
    }
    
    // Register ports — detect and warn on duplicate name+direction within this step (R1-C4)
    const seenPortKeys = new Set<string>();
    processStep.ports.forEach((port: DexpiPort) => {
      const key = `${port.name}::${port.direction}`;
      if (seenPortKeys.has(key)) {
        this.logger.warn(
          `Duplicate port detected in step "${name}" (id=${id}): ` +
          `name="${port.name}", direction="${port.direction}". ` +
          `DEXPI Process requires unique port name+direction combinations per element. ` +
          `Add a subReference attribute to the dexpi:port element to explicitly link it.`
        );
      }
      seenPortKeys.add(key);
      this.ports.set(port.portId, {
        ...port,
        stepId: id,
        parentPortId: undefined,
        childPortIds: []
      });
    });
    
    // If this is a subprocess, map parent ports to child ports using explicit
    // subReference annotations only. Resolved in post-extraction pass in
    // extractElements after all ports are registered. No name-based heuristics.
    // Warn only when a child step has a port of the same type as the parent
    // boundary port — meaning the hierarchy IS refineable at that port type
    // and a subReference annotation is missing. If no child has a matching
    // port type, the abstraction levels differ and no warning is needed.
    if (isSubProcess && processStep.subProcessSteps.length > 0) {
      // Collect all port types present in child steps
      const childPortTypes = new Set<string>();
      for (const childId of processStep.subProcessSteps) {
        const childStep = this.processSteps.get(childId);
        if (childStep) {
          childStep.ports.forEach((p: DexpiPort) => childPortTypes.add(p.portType));
        }
      }

      processStep.ports.forEach((parentPort: DexpiPort) => {
        if (parentPort.subReference) return; // resolved in post-pass
        // Only warn for MaterialPorts — material streams are the primary
        // hierarchically refineable connections in DEXPI Process. Energy and
        // information ports at subprocess boundaries represent different
        // abstraction levels and don't require SubReference to a child counterpart.
        if (parentPort.portType === 'MaterialPort' && childPortTypes.has('MaterialPort')) {
          this.logger.warn(
            `Subprocess "${name}" (id=${id}): boundary port "${parentPort.name}" ` +
            `(${parentPort.portType}) has no subReference annotation — SubReference ` +
            `omitted from DEXPI output. Add a subReference attribute to the dexpi:port ` +
            `element to formally link this port to its child-level counterpart.`
          );
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
    
    const source: InternalProcessStep = {
      id,
      name,
      type: 'Source',
      identifier: dexpiData?.identifier || id,
      uid: dexpiData?.uid || this.generateUid(),
      ports: (dexpiData?.ports || []).map((port: DexpiPort) => ({
        ...port,
        portId: port.portId.startsWith(`${id}_`) ? port.portId : `${id}_${port.portId}`
      })),
      attributes: [],
      parentId: null,
      subProcessSteps: [],
    };

    this.processSteps.set(id, source);

    source.ports.forEach((port: DexpiPort) => {
      this.ports.set(port.portId, { ...port, stepId: id });
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
    
    const sink: InternalProcessStep = {
      id,
      name,
      type: 'Sink',
      identifier: dexpiData?.identifier || id,
      uid: dexpiData?.uid || this.generateUid(),
      ports: (dexpiData?.ports || []).map((port: DexpiPort) => ({
        ...port,
        portId: port.portId.startsWith(`${id}_`) ? port.portId : `${id}_${port.portId}`
      })),
      attributes: [],
      parentId: null,
      subProcessSteps: [],
    };

    this.processSteps.set(id, sink);

    sink.ports.forEach((port: DexpiPort) => {
      this.ports.set(port.portId, { ...port, stepId: id });
    });
  }

  private extractStream(flow: Element): void {
    const id = flow.getAttribute('id') || '';
    const name = flow.getAttribute('name') || id;
    const sourceRef = flow.getAttribute('sourceRef') || '';
    const targetRef = flow.getAttribute('targetRef') || '';
    
    const dexpiData = this.extractDexpiStreamExtension(flow);
    
    const stream: InternalStream = {
      id,
      name,
      identifier: dexpiData?.identifier || id,
      uid: this.generateUid(),
      sourceRef,
      targetRef,
      sourcePortRef: dexpiData?.sourcePortRef,
      targetPortRef: dexpiData?.targetPortRef,
      streamType: (dexpiData?.streamType ?? 'MaterialFlow') as InternalStream['streamType'],
      templateReference: dexpiData?.templateReference,
      materialStateReference: dexpiData?.materialStateReference,
      provenance: dexpiData?.provenance ?? 'Calculated',
      range: dexpiData?.range ?? 'Design',
      attributes: (dexpiData?.attributes ?? []) as StreamAttribute[],
    };

    this.streams.set(id, stream);
  }

  /**
   * Extract a BPMN Association as a DEXPI InformationFlow.
   * Per the representation methodology, Associations model non-sequential
   * information connections (e.g. InstrumentationActivity ↔ measured variable).
   * The BPMN association carries a dexpi:Stream extensionElement with
   * streamType='InformationFlow'.
   */
  private extractInformationFlow(assoc: Element): void {
    const id = assoc.getAttribute('id') || '';
    const name = assoc.getAttribute('name') || id;
    const sourceRef = assoc.getAttribute('sourceRef') || '';
    const targetRef = assoc.getAttribute('targetRef') || '';

    if (!sourceRef || !targetRef) return;

    // Only extract if explicitly annotated as InformationFlow
    // (plain BPMN associations without annotation are ignored)
    const dexpiData = this.extractDexpiStreamExtension(assoc);
    if (!dexpiData || (dexpiData.streamType as string) !== 'InformationFlow') return;

    const flow: InternalStream = {
      id,
      name,
      identifier: dexpiData.identifier || id,
      uid: this.generateUid(),
      sourceRef,
      targetRef,
      sourcePortRef: dexpiData.sourcePortRef,
      targetPortRef: dexpiData.targetPortRef,
      streamType: 'InformationFlow',
      provenance: dexpiData.provenance ?? 'Calculated',
      range: dexpiData.range ?? 'Design',
      attributes: (dexpiData.attributes ?? []) as StreamAttribute[],
    };

    this.informationFlows.set(id, flow);
  }

  /**
   * Extract InformationFlows that pass through DataObject intermediaries.
   * Pattern: Task --[dataOutputAssociation]--> DataObject --[dataInputAssociation]--> Task
   *
   * The DataObject is a BPMN visual anchor representing the measured/controlled variable.
   * In DEXPI output: skip the DataObject, connect the two task InformationPorts directly,
   * and encode the variable name as an InformationVariant on the InformationFlow.
   *
   * Also handles one-sided connections (InstrumentationActivity → DataObject only).
   */
  private extractDataObjectInformationFlows(process: Element): void {
    // Build DataObject graph:
    // dataOutputAssociation is a CHILD of the source task → DataObject
    // dataInputAssociation  is a CHILD of the target task ← DataObject

    // Map: DataObjectRef ID → { name, sourceTaskIds[], targetTaskIds[] }
    interface DataObjNode { name: string; sourceTaskIds: string[]; targetTaskIds: string[] }
    const graph = new Map<string, DataObjNode>();

    const allTasks = Array.from(process.querySelectorAll(
      'task, subProcess, serviceTask, userTask, callActivity'
    ));

    allTasks.forEach(task => {
      const taskId = task.getAttribute('id') || '';

      // dataOutputAssociation: this task → DataObject
      // Use only DIRECT children — querySelectorAll would also find associations
      // inside nested subProcess children, incorrectly attributing them to the parent.
      const outputs = Array.from(task.children).filter(
        c => (c.localName || c.tagName.split(':').pop()) === 'dataOutputAssociation'
      );
      outputs.forEach(doa => {
        const targetRef = doa.querySelector('targetRef');
        const dataObjId = targetRef?.textContent?.trim() || '';
        if (!dataObjId) return;
        if (!graph.has(dataObjId)) {
          const dataObjEl = process.querySelector(`[id="${dataObjId}"]`) ||
                            process.ownerDocument?.querySelector(`[id="${dataObjId}"]`);
          const name = dataObjEl?.getAttribute('name') || dataObjId;
          graph.set(dataObjId, { name, sourceTaskIds: [], targetTaskIds: [] });
        }
        graph.get(dataObjId)!.sourceTaskIds.push(taskId);
      });

      // dataInputAssociation: DataObject → this task
      const inputs = Array.from(task.children).filter(
        c => (c.localName || c.tagName.split(':').pop()) === 'dataInputAssociation'
      );
      inputs.forEach(dia => {
        const sourceRef = dia.querySelector('sourceRef');
        const dataObjId = sourceRef?.textContent?.trim() || '';
        if (!dataObjId) return;
        if (!graph.has(dataObjId)) {
          const dataObjEl = process.querySelector(`[id="${dataObjId}"]`) ||
                            process.ownerDocument?.querySelector(`[id="${dataObjId}"]`);
          const name = dataObjEl?.getAttribute('name') || dataObjId;
          graph.set(dataObjId, { name, sourceTaskIds: [], targetTaskIds: [] });
        }
        graph.get(dataObjId)!.targetTaskIds.push(taskId);
      });
    });

    // Create InformationFlows from the graph
    graph.forEach((node, dataObjId) => {
      const { name, sourceTaskIds, targetTaskIds } = node;

      // Pair sources with targets (cross-product for multiple connections)
      const pairs: Array<{source: string, target: string | null}> = [];
      if (sourceTaskIds.length > 0 && targetTaskIds.length > 0) {
        sourceTaskIds.forEach(src => {
          targetTaskIds.forEach(tgt => {
            if (src !== tgt) pairs.push({ source: src, target: tgt });
          });
        });
      } else if (sourceTaskIds.length > 0) {
        // One-sided: InstrumentationActivity → DataObject only
        sourceTaskIds.forEach(src => pairs.push({ source: src, target: null }));
      }

      pairs.forEach(({ source, target }) => {
        const flowId = `IF_${dataObjId}_${source}_${target || 'solo'}`;
        const flow: InternalStream = {
          id: flowId,
          name,
          identifier: flowId,
          uid: this.generateUid(),
          sourceRef: source,
          targetRef: target || source,
          streamType: 'InformationFlow',
          provenance: 'Calculated',
          range: 'Design',
          attributes: [],
          informationVariantLabel: name,  // DataObject name → InformationVariant
        };
        this.informationFlows.set(flowId, flow);
      });
    });
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
      const listOfComponents = Array.from(template.children).find((c: Element) => 
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
      const listOfPhases = Array.from(template.children).find((c: Element) => 
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
        const flowElement = Array.from(state.children).find((c: Element) => c.tagName === 'Flow' || c.localName === 'Flow');
        let flow: import('./types').FlowData | null = null;
        
        if (flowElement) {
          const moleFlowElement = Array.from(flowElement.children).find((c: Element) => c.tagName === 'MoleFlow' || c.localName === 'MoleFlow');
          const compositionElement = Array.from(flowElement.children).find((c: Element) => c.tagName === 'Composition' || c.localName === 'Composition');
          
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
    const child = Array.from(parent.children).find((c: Element) => 
      c.tagName === childName || c.localName === childName
    );
    return child?.textContent || '';
  }

  private getChildValue(parent: Element, childName: string, attrName: string): string {
    const child = Array.from(parent.children).find((c: Element) => 
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
      // Ports may be inline children of <dexpi:element> OR in a sibling <ports> container.
      // The sibling format is used when dexpi:element is a self-closing annotation alongside
      // an existing <ports> block (e.g. the TEP example file after annotation).
      let ports = this.extractPortsFromElement(dexpiElement);
      if (ports.length === 0) {
        ports = this.extractPortsFromExtensionElements(extensionElements);
      }
      const attributes = this.extractAttributesFromElement(dexpiElement);
      return {
        dexpiType: dexpiElement.getAttribute('dexpiType') || undefined,
        // customUri: optional URI referencing an external RDL (e.g. ISO 15926, OntoCAPE).
        // Used when dexpiType is not a standard DEXPI class (mode 2 typing).
        // Example: <dexpi:element dexpiType="MyStep" customUri="https://my-rdl.org/MyStep"/>
        customUri: dexpiElement.getAttribute('customUri') || undefined,
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
    const attributes: StreamAttribute[] = [];
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
      streamType: (dexpiStream.getAttribute('streamType') ?? 'MaterialFlow') as InternalStream['streamType'],
      sourcePortRef: dexpiStream.getAttribute('sourcePortRef') || undefined,
      targetPortRef: dexpiStream.getAttribute('targetPortRef') || undefined,
      templateReference: dexpiStream.getAttribute('templateReference') || templateRef,
      materialStateReference: materialStateRef,
      provenance: (dexpiStream.getAttribute('provenance') ?? undefined) as 'Measured' | 'Calculated' | 'Specified' | 'Estimated' | undefined,
      range: (dexpiStream.getAttribute('range') ?? undefined) as 'Design' | 'Normal' | 'Maximum' | 'Minimum' | undefined,
      attributes
    };
  }

  private extractAttributesFromElement(dexpiElement: Element): StreamAttribute[] {
    const attributes: StreamAttribute[] = [];
    
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
    
    // Collect port elements — they may be direct children OR inside a <dexpi:ports> wrapper
    const portElements: Element[] = [];
    for (let i = 0; i < dexpiElement.children.length; i++) {
      const child = dexpiElement.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      if (localName.toLowerCase() === 'port') {
        portElements.push(child);
      } else if (localName.toLowerCase() === 'ports') {
        // Ports wrapper — collect its port children
        for (let j = 0; j < child.children.length; j++) {
          const grandchild = child.children[j];
          const gln = grandchild.localName || grandchild.tagName.split(':').pop() || '';
          if (gln.toLowerCase() === 'port') portElements.push(grandchild);
        }
      }
    }
    
    for (const child of portElements) {
      ports.push({
        portId: child.getAttribute('portId') || child.getAttribute('id') || this.generateUid(),
        name: child.getAttribute('name') || child.getAttribute('label') || 'Port',
        label: child.getAttribute('label') || undefined,
        portType: (child.getAttribute('portType') || child.getAttribute('type') || 'MaterialPort') as DexpiPort['portType'],
        direction: (child.getAttribute('direction') || 'Inlet') as DexpiPort['direction'],
        anchorSide: (child.getAttribute('anchorSide') || undefined) as DexpiPort['anchorSide'],
        anchorOffset: child.getAttribute('anchorOffset') ? parseFloat(child.getAttribute('anchorOffset')!) : undefined,
        anchorX: child.getAttribute('anchorX') ? parseFloat(child.getAttribute('anchorX')!) : undefined,
        anchorY: child.getAttribute('anchorY') ? parseFloat(child.getAttribute('anchorY')!) : undefined,
        subReference: child.getAttribute('subReference') || undefined,
        superReference: child.getAttribute('superReference') || undefined,
      });
    }
    
    return ports;
  }

  private extractPortsFromExtensionElements(extensionElements: Element): DexpiPort[] {
    // Find by local name so both <ports> and <dexpi:ports> are matched.
    let portsContainer: Element | null = null;
    for (let i = 0; i < extensionElements.children.length; i++) {
      const child = extensionElements.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      if (localName === 'ports') { portsContainer = child; break; }
    }
    if (!portsContainer) return [];

    // Collect <port> / <dexpi:port> children by local name.
    const ports: Element[] = [];
    for (let i = 0; i < portsContainer.children.length; i++) {
      const child = portsContainer.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      if (localName === 'port') ports.push(child);
    }
    if (ports.length === 0) return [];
    
    return ports.map((port) => ({
      portId: port.getAttribute('id') || port.getAttribute('portId') || this.generateUid(),
      name: port.getAttribute('name') || port.getAttribute('label') || 'Port',
      label: port.getAttribute('label') || undefined,
      portType: (port.getAttribute('type') || port.getAttribute('portType') || 'MaterialPort') as DexpiPort['portType'],
      direction: (port.getAttribute('direction') || 'Inlet') as DexpiPort['direction'],
      anchorSide: (port.getAttribute('anchorSide') || undefined) as DexpiPort['anchorSide'],
      anchorOffset: port.getAttribute('anchorOffset') ? parseFloat(port.getAttribute('anchorOffset')!) : undefined,
      anchorX: port.getAttribute('anchorX') ? parseFloat(port.getAttribute('anchorX')!) : undefined,
      anchorY: port.getAttribute('anchorY') ? parseFloat(port.getAttribute('anchorY')!) : undefined,
      subReference: port.getAttribute('subReference') || undefined,
      superReference: port.getAttribute('superReference') || undefined,
    }));
  }

  private buildDexpiModel(_options: TransformOptions): Record<string, unknown> {
    const modelUid = this.generateUid();
    
    // Build ProcessModel object
    const processModelObject: Record<string, unknown> = {
      '$': {
        'id': this.sanitizeId(modelUid),
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

    // Add ProcessConnections (Streams + InformationFlows) collection if there are any
    if (this.streams.size > 0 || this.informationFlows.size > 0) {
      if (!processModelObject.Components) {
        processModelObject.Components = [];
      }
      const allConnections = [
        ...this.buildStreams(),
        ...this.buildInformationFlows(),
      ];
      const streamsComponent = {
        '$': {
          'property': 'ProcessConnections'
        },
        'Object': allConnections
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
    const model: Record<string, unknown> = {
      'Model': {
        '$': {
          'name': 'process_model',
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

  private buildProcessSteps(): Record<string, unknown>[] {
    const steps: Record<string, unknown>[] = [];

    // Only build top-level process steps (those without parents)
    this.processSteps.forEach((step) => {
      if (step.parentId) return; // Skip child process steps, they'll be added as SubProcessSteps
      
      steps.push(this.buildProcessStepObject(step));
    });

    return steps;
  }

  private buildProcessStepObject(step: InternalProcessStep): Record<string, unknown> {
      // Build the correct DEXPI type - use Process/Process.{Type} format
      // If step.type is already "Process.X", use it; otherwise wrap it
      const dexpiType = step.type.startsWith('Process.') 
        ? `Process/${step.type}` 
        : `Process/Process.${step.type}`;
      
      const dexpiStep: Record<string, unknown> = {
        '$': {
          'id': this.sanitizeId(step.uid),
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
          (dexpiStep.Data as Record<string, unknown>[]).push({
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

      // Add ReferenceUri if this is a custom-type step (mode 2)
      // The type is always ProcessStep; the URI points to the user's RDL class.
      // Future DEXPI customization work will define a formal mechanism for custom
      // classes; this conservative approach avoids polluting the type namespace.
      if (step.customUri) {
        if (!Array.isArray(dexpiStep.Data)) {
          dexpiStep.Data = [dexpiStep.Data as Record<string, unknown>];
        }
        (dexpiStep.Data as Record<string, unknown>[]).push({
          '$': { 'property': 'ReferenceUri' },
          'String': step.customUri
        });
        if (step.suggestedDexpiClass) {
          (dexpiStep.Data as Record<string, unknown>[]).push({
            '$': { 'property': 'SuggestedDexpiClass' },
            'String': step.suggestedDexpiClass
          });
        }
      }

      // Add ports as composition properties
      if (step.ports && step.ports.length > 0) {
        const portObjects: Record<string, unknown>[] = [];
        
        step.ports.forEach((port: DexpiPort) => {
          // Sanitize portId for DEXPI XSD compliance (no spaces, hyphens, must start with letter)
          const safePortId = this.sanitizeId(port.portId);
          const portObject: Record<string, unknown> = {
            '$': {
              'id': safePortId,
              'type': `Process/Process.${port.portType}`
            },
            'Data': [
              {
                '$': {
                  'property': 'Identifier'
                },
                'String': safePortId
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
            (portObject.Data as Record<string, unknown>[]).push({
              '$': {
                'property': 'Label'
              },
              'String': port.name
            });
          }

          portObjects.push(portObject);
        });

        // Second pass: add port hierarchy references after all ports are created
        portObjects.forEach((portObject: Record<string, unknown>) => {
          const portId = (portObject.$ as Record<string, string>).id;
          const portData = this.ports.get(portId);
          
          // Add SuperReference if this port has a parent port
          // Per DEXPI XSD: References element uses 'objects' attr (space-sep IDREFs), no child elements
          if (portData?.parentPortId) {
            if (!portObject.References) portObject.References = [];
            (portObject.References as Record<string, unknown>[]).push({
              '$': {
                'property': 'SuperReference',
                'objects': `#${this.sanitizeId(portData.parentPortId)}`
              }
            });
          }
          
          // Add SubReference if this port has child ports
          if (portData?.childPortIds && portData.childPortIds.length > 0) {
            if (!portObject.References) portObject.References = [];
            const childRefs = portData.childPortIds
              .map((childId: string) => `#${this.sanitizeId(childId)}`)
              .join(' ');
            (portObject.References as Record<string, unknown>[]).push({
              '$': {
                'property': 'SubReference',
                'objects': childRefs
              }
            });
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
        const subProcessObjects: Record<string, unknown>[] = [];
        
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
        step.attributes.forEach((attr) => {
          if (!attr.name || !attr.value) return;
          
          // If unit is provided, this is a physical quantity - add as QualifiedValue Object
          if (attr.unit) {
            if (!dexpiStep.Object) {
              dexpiStep.Object = [];
            }

            const qualifiedValueObject: Record<string, unknown> = {
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
                        'Double': !isNaN(parseFloat(attr.value)) ? parseFloat(attr.value) : undefined, 'String': isNaN(parseFloat(attr.value)) ? attr.value : undefined
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

            // unitUri — links unit to standard unit ontology (e.g. QUDT)
            if (attr.unitUri) {
              (qualifiedValueObject['Data'] as Record<string, unknown>[]).push({
                '$': { 'property': 'UnitReference' }, 'String': attr.unitUri
              });
            }

            // nameUri — links attribute name to quantity kind (e.g. QUDT, ISO 15926)
            if (attr.nameUri) {
              qualifiedValueObject['References'] = [{
                '$': { 'property': 'QuantityKindReference', 'objects': attr.nameUri }
              }];
            }

            // Add Provenance at QualifiedValue level
            if (attr.provenance) {
              (qualifiedValueObject.Data as Record<string, unknown>[]).push({
                '$': { 'property': 'Provenance' },
                'String': attr.provenance
              });
            }

            // Add Range at QualifiedValue level
            if (attr.range) {
              (qualifiedValueObject.Data as Record<string, unknown>[]).push({
                '$': { 'property': 'Range' },
                'String': attr.range
              });
            }

            // Scope is available in DEXPI 2.0 but not typically used on QualifiedValue

            (dexpiStep.Object as Record<string, unknown>[]).push(qualifiedValueObject);
          } else {
            // Simple string value - add to Data
            (dexpiStep.Data as Record<string, unknown>[]).push({
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
        (dexpiStep.Data as Record<string, unknown>[]).push({
          '$': {
            'property': 'HierarchyLevel'
          },
          'String': step.hierarchyLevel
        });
      }

      return dexpiStep;
  }

  private buildStreams(): Record<string, unknown>[] {
    const streamElements: Record<string, unknown>[] = [];

    this.streams.forEach((stream) => {
      // Warn if source or target isn't a registered process step at all.
      // Exception: gateways are valid BPMN but intentionally have no DEXPI
      // equivalent — flows through them are silently skipped, not warned.
      if (!this.processSteps.has(stream.sourceRef) && !this.isGateway(stream.sourceRef)) {
        this.logger.warn(
          `Stream "${stream.name}" (id=${stream.id}): source "${stream.sourceRef}" is not a recognised process step — stream skipped.`
        );
        return;
      }
      if (!this.processSteps.has(stream.targetRef) && !this.isGateway(stream.targetRef)) {
        this.logger.warn(
          `Stream "${stream.name}" (id=${stream.id}): target "${stream.targetRef}" is not a recognised process step — stream skipped.`
        );
        return;
      }
      if (!this.processSteps.has(stream.sourceRef) || !this.processSteps.has(stream.targetRef)) {
        // Gateway case — silently skip
        return;
      }

      const sourcePort = this.findPortForConnection(stream.sourceRef, stream.sourcePortRef, 'Outlet');
      const targetPort = this.findPortForConnection(stream.targetRef, stream.targetPortRef, 'Inlet');

      if (!sourcePort || !targetPort) {
        // Skip streams without proper port references (e.g., connections to gateways)
        return;
      }

      // Resolve final stream type — infer from connected port type when unannotated
      const resolvedStreamType = this.resolveStreamType(stream, sourcePort);
      const dexpiTypeName = this.streamTypeToDexpiClass(resolvedStreamType);

      const dexpiStream: Record<string, unknown> = {
        '$': {
          'id': this.sanitizeId(stream.uid),
          'type': `Process/Process.${dexpiTypeName}`
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
              'objects': `#${this.sanitizeId(sourcePort)}`,
              'property': 'Source'
            }
          },
          {
            '$': {
              'objects': `#${this.sanitizeId(targetPort)}`,
              'property': 'Target'
            }
          }
        ]
      };

      // Add MaterialStateReference if present
      if (stream.materialStateReference) {
        (dexpiStream.References as Record<string, unknown>[]).push({
          '$': {
            'property': 'MaterialStateReference',
            'objects': `#${this.sanitizeId(stream.materialStateReference)}`
          }
        });
      }

      // Add Label if present
      if (stream.name) {
        (dexpiStream.Data as Record<string, unknown>[]).push({
          '$': {
            'property': 'Label'
          },
          'String': stream.name
        });
      }

      // Add all stream attributes as QualifiedValue Objects per DEXPI 2.0 schema
      // Per XSD: Object has no 'property' attr — use Components property="attrName" containing the Object
      if (stream.attributes && stream.attributes.length > 0) {
        stream.attributes.forEach((attr) => {
          if (!attr.name || !attr.value) return;
          
          // If unit is provided, this is a physical quantity - add as QualifiedValue inside Components
          if (attr.unit) {
            if (!dexpiStream.Components) {
              dexpiStream.Components = [];
            }

            const qualifiedValueData: Record<string, unknown>[] = [
              {
                '$': { 'property': 'Value' },
                'Double': !isNaN(parseFloat(attr.value)) ? parseFloat(attr.value) : undefined,
                'String': isNaN(parseFloat(attr.value)) ? attr.value : undefined
              },
              {
                '$': { 'property': 'Unit' },
                'String': attr.unit
              }
            ];

            // unitUri — links the unit string to a standard unit ontology (e.g. QUDT)
            if (attr.unitUri) {
              qualifiedValueData.push({ '$': { 'property': 'UnitReference' }, 'String': attr.unitUri });
            }

            if (attr.provenance) {
              qualifiedValueData.push({ '$': { 'property': 'Provenance' }, 'String': attr.provenance });
            }
            if (attr.range) {
              qualifiedValueData.push({ '$': { 'property': 'Range' }, 'String': attr.range });
            }

            const componentEntry: Record<string, unknown> = {
              '$': { 'property': attr.name },
              'Object': [{
                '$': { 'type': 'Core/QualifiedValue' },
                'Data': qualifiedValueData
              }]
            };

            // nameUri — links the attribute name to a standard quantity kind (e.g. QUDT, ISO 15926)
            if (attr.nameUri) {
              (componentEntry['Object'] as Record<string, unknown>[])[0]['References'] = [{
                '$': { 'property': 'QuantityKindReference', 'objects': attr.nameUri }
              }];
            }

            (dexpiStream.Components as Record<string, unknown>[]).push(componentEntry);
          } else {
            // Simple string value - add to Data
            const dataEntry: Record<string, unknown> = {
              '$': { 'property': attr.name },
              'String': attr.value
            };
            // nameUri still applicable for non-unit attributes
            if (attr.nameUri) {
              dataEntry['nameUri'] = attr.nameUri;
            }
            (dexpiStream.Data as Record<string, unknown>[]).push(dataEntry);
          }
        });
      }

      streamElements.push(dexpiStream);
    });

    return streamElements;
  }

  /**
   * Resolve the final stream type — uses explicit annotation if present,
   * otherwise infers from the connected port's portType.
   * This allows TEP and other files without streamType annotations to export
   * the correct DEXPI subtype based on their port type attributes.
   */
  private resolveStreamType(stream: InternalStream, sourcePortId: string): InternalStream['streamType'] {
    // If explicitly annotated (not the default), trust it
    if (stream.streamType !== 'MaterialFlow') return stream.streamType;

    // Infer from source port type
    const port = this.ports.get(sourcePortId);
    if (!port) return 'MaterialFlow';

    switch (port.portType) {
      case 'ThermalEnergyPort':    return 'ThermalEnergyFlow';
      case 'MechanicalEnergyPort': return 'MechanicalEnergyFlow';
      case 'ElectricalEnergyPort': return 'ElectricalEnergyFlow';
      case 'InformationPort':      return 'InformationFlow';
      default:                     return 'MaterialFlow';
    }
  }

  /** Map internal stream type to DEXPI Process class name. */
  private streamTypeToDexpiClass(streamType: InternalStream['streamType']): string {
    switch (streamType) {
      case 'MaterialFlow':         return 'Stream';
      case 'ThermalEnergyFlow':    return 'ThermalEnergyFlow';
      case 'MechanicalEnergyFlow': return 'MechanicalEnergyFlow';
      case 'ElectricalEnergyFlow': return 'ElectricalEnergyFlow';
      case 'EnergyFlow':           return 'EnergyFlow';  // generic fallback
      default:                     return 'Stream';
    }
  }

  /**
   * Build DEXPI InformationFlow objects from BPMN associations.
   * InformationFlow connects InformationPorts between process elements —
   * typically an InstrumentationActivity port to a measured/controlled element's port.
   */
  private buildInformationFlows(): Record<string, unknown>[] {
    const flowElements: Record<string, unknown>[] = [];

    this.informationFlows.forEach((flow) => {
      // Match ports by the variable identity (DataObject name carried in flow.name).
      // Element with port labelled "Temperature" wins for a Temperature flow.
      const sourcePort = this.findPortForConnection(
        flow.sourceRef, flow.sourcePortRef, 'Outlet', 'InformationPort', flow.name
      );
      const targetPort = this.findPortForConnection(
        flow.targetRef, flow.targetPortRef, 'Inlet', 'InformationPort', flow.name
      );

      if (!sourcePort || !targetPort) {
        this.logger.warn(
          `InformationFlow "${flow.name}" (id=${flow.id}): no matching InformationPorts found ` +
          `on source "${flow.sourceRef}" or target "${flow.targetRef}". ` +
          `Add InformationPort entries to both elements to produce DEXPI output.`
        );
        return;
      }

      const dexpiFlow: Record<string, unknown> = {
        '$': {
          'id': this.sanitizeId(flow.uid),
          'type': 'Process/Process.InformationFlow'
        },
        'Data': [
          { '$': { 'property': 'Identifier' }, 'String': flow.identifier }
        ],
        'References': [
          { '$': { 'objects': `#${this.sanitizeId(sourcePort)}`, 'property': 'Source' } },
          { '$': { 'objects': `#${this.sanitizeId(targetPort)}`, 'property': 'Target' } },
        ]
      };

      if (flow.name) {
        (dexpiFlow.Data as Record<string, unknown>[]).push({
          '$': { 'property': 'Label' },
          'String': flow.name
        });
      }

      // Add InformationVariant if this flow was stitched through a DataObject
      // (DataObject name = the measured/controlled variable)
      if (flow.informationVariantLabel) {
        dexpiFlow.Components = [{
          '$': { 'property': 'InformationValue' },
          'Object': {
            '$': { 'type': 'Process/Process.InformationVariant' },
            'Data': [{
              '$': { 'property': 'Label' },
              'String': flow.informationVariantLabel
            }]
          }
        }];
      }

      flowElements.push(dexpiFlow);
    });

    return flowElements;
  }

  private buildMaterialTemplates(): Record<string, unknown>[] {
    const templates: Record<string, unknown>[] = [];

    this.materialTemplates.forEach((template) => {
      const dexpiTemplate: Record<string, unknown> = {
        '$': {
          'id': this.sanitizeId(template.uid),
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
        (dexpiTemplate.Data as Record<string, unknown>[]).push({
          '$': {
            'property': 'Label'
          },
          'String': template.label
        });
      }

      // Add Description if present
      if (template.description) {
        (dexpiTemplate.Data as Record<string, unknown>[]).push({
          '$': {
            'property': 'Description'
          },
          'String': template.description
        });
      }

      // Add NumberOfMaterialComponents if present
      if (template.numberOfComponents) {
        (dexpiTemplate.Data as Record<string, unknown>[]).push({
          '$': {
            'property': 'NumberOfMaterialComponents'
          },
          'Integer': template.numberOfComponents
        });
      }

      // Add NumberOfPhases if present
      if (template.numberOfPhases) {
        (dexpiTemplate.Data as Record<string, unknown>[]).push({
          '$': {
            'property': 'NumberOfPhases'
          },
          'Integer': template.numberOfPhases
        });
      }

      // Add ListOfMaterialComponents if present
      if (template.componentRefs && template.componentRefs.length > 0) {
        if (!dexpiTemplate.References) {
          dexpiTemplate.References = [];
        }
        (dexpiTemplate.References as Record<string, unknown>[]).push({
          '$': {
            'property': 'ListOfMaterialComponents',
            'objects': template.componentRefs.map((ref: string) => `#${this.sanitizeId(ref)}`).join(' ')
          }
        });
      }

      // Add ListOfPhases if present
      if (template.phases && template.phases.length > 0) {
        (dexpiTemplate.Data as Record<string, unknown>[]).push({
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

  private buildMaterialComponents(): Record<string, unknown>[] {
    const components: Record<string, unknown>[] = [];

    this.materialComponents.forEach((component) => {
      const dexpiComponent: Record<string, unknown> = {
        '$': {
          'id': this.sanitizeId(component.uid),
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
        (dexpiComponent.Data as Record<string, unknown>[]).push({
          '$': {
            'property': 'Label'
          },
          'String': component.label
        });
      }

      // Add Description if present
      if (component.description) {
        (dexpiComponent.Data as Record<string, unknown>[]).push({
          '$': {
            'property': 'Description'
          },
          'String': component.description
        });
      }

      // Add ChEBI_identifier if present
      if (component.chebiId) {
        (dexpiComponent.Data as Record<string, unknown>[]).push({
          '$': {
            'property': 'ChEBI_identifier'
          },
          'String': component.chebiId
        });
      }

      // Add IUPAC_identifier if present
      if (component.iupacId) {
        (dexpiComponent.Data as Record<string, unknown>[]).push({
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

  private buildMaterialStates(): Record<string, unknown>[] {
    const states: Record<string, unknown>[] = [];

    this.materialStates.forEach((state) => {
      const dexpiState: Record<string, unknown> = {
        '$': {
          'id': this.sanitizeId(state.uid),
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
        (dexpiState.Data as Record<string, unknown>[]).push({
          '$': {
            'property': 'Label'
          },
          'String': state.label
        });
      }

      // Add Description if present
      if (state.description) {
        (dexpiState.Data as Record<string, unknown>[]).push({
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
        (dexpiState.References as Record<string, unknown>[]).push({
          '$': {
            'property': 'State',
            'objects': `#${this.sanitizeId(state.stateTypeRef)}`
          }
        });
      }

      states.push(dexpiState);
    });

    return states;
  }

  private buildMaterialStateTypes(): Record<string, unknown>[] {
    const stateTypes: Record<string, unknown>[] = [];

    this.materialStateTypes.forEach((stateType) => {
      const dexpiStateType: Record<string, unknown> = {
        '$': {
          'id': this.sanitizeId(stateType.uid),
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
        (dexpiStateType.Data as Record<string, unknown>[]).push({
          '$': {
            'property': 'Label'
          },
          'String': stateType.label
        });
      }

      // Add Description if present
      if (stateType.description) {
        (dexpiStateType.Data as Record<string, unknown>[]).push({
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
        (dexpiStateType.References as Record<string, unknown>[]).push({
          '$': {
            'property': 'MaterialTemplateReference',
            'objects': `#${this.sanitizeId(stateType.templateRef)}`
          }
        });
      }

      // Add MoleFlow as QualifiedValue — wrapped in Components per XSD (Object has no property attr)
      if (stateType.flow?.moleFlow) {
        if (!dexpiStateType.Components) {
          dexpiStateType.Components = [];
        }
        (dexpiStateType.Components as Record<string, unknown>[]).push({
          '$': { 'property': 'MoleFlow' },
          'Object': [{
            '$': { 'type': 'Core/QualifiedValue' },
            'Data': [
              {
                '$': { 'property': 'Value' },
                'Double': parseFloat(stateType.flow.moleFlow.value) || 0
              },
              {
                '$': { 'property': 'Unit' },
                'String': stateType.flow.moleFlow.unit
              }
            ]
          }]
        });
      }

      // Add Composition — wrapped in Components per XSD
      if (stateType.flow?.composition) {
        const composition = stateType.flow.composition;
        if (!dexpiStateType.Components) {
          dexpiStateType.Components = [];
        }

        const compositionData: Record<string, unknown>[] = [];
        if (composition.basis) {
          compositionData.push({ '$': { 'property': 'Basis' }, 'String': composition.basis });
        }
        if (composition.display) {
          compositionData.push({ '$': { 'property': 'Display' }, 'String': composition.display });
        }

        (dexpiStateType.Components as Record<string, unknown>[]).push({
          '$': { 'property': 'Composition' },
          'Object': [{
            '$': { 'type': 'Process/Process.Composition' },
            'Data': compositionData
          }]
        });
      }

      stateTypes.push(dexpiStateType);
    });

    return stateTypes;
  }

  private findPortForConnection(
    elementRef: string,
    portRef: string | undefined,
    defaultDirection: string,
    portType?: string,
    /**
     * Variable name from the connecting object (e.g. DataObject.name for an
     * InformationFlow, SequenceFlow.name for a MaterialPort connection).
     * Matched against port.label (or port.name as a fallback) to disambiguate
     * when an element has multiple ports of the same direction & portType.
     */
    variableName?: string
  ): string | null {
    const element = this.processSteps.get(elementRef);
    if (!element) return null;

    // If specific port is referenced, find it
    if (portRef) {
      const prefixedPortRef = `${elementRef}_${portRef}`;
      if (this.ports.has(prefixedPortRef)) return prefixedPortRef;
      if (this.ports.has(portRef)) return portRef;
      const matchingPort = element.ports.find((p: DexpiPort) =>
        p.name === portRef || p.portId === portRef || p.portId.endsWith(`_${portRef}`)
      );
      return matchingPort ? matchingPort.portId : null;
    }

    const sameSlot = (p: DexpiPort) =>
      p.direction === defaultDirection && (!portType || p.portType === portType);

    // Match by variable name against port.label (preferred) or port.name.
    // The label carries the semantic identity the connecting object refers to,
    // so a "Temperature" DataObject finds the port labeled "Temperature".
    if (variableName) {
      const labeled = element.ports.find((p: DexpiPort) => {
        if (!sameSlot(p)) return false;
        return p.label === variableName || p.name === variableName;
      });
      if (labeled) return labeled.portId;

      // No labelled match: if the element has exactly one port in this slot,
      // it's unambiguous. Otherwise return null — better to skip the flow than
      // pick the wrong port silently.
      const sameSlotPorts = element.ports.filter(sameSlot);
      if (sameSlotPorts.length === 1) return sameSlotPorts[0].portId;
      return null;
    }

    // No variableName provided (e.g. material flow with implicit single port):
    // fall back to first matching port. Used by paths that don't carry semantic
    // disambiguation context.
    const matchingPort = element.ports.find(sameSlot);
    return matchingPort ? matchingPort.portId : null;
  }

  private generateXml(model: Record<string, unknown>): string {
    try {
      return this.buildXmlString(model);
    } catch (error) {
      console.error('XML generation error:', error);
      throw new Error(`Failed to generate XML: ${(error as Error).message}`);
    }
  }

  private buildXmlString(obj: unknown, indent: string = ''): string {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += this.objectToXml(obj, indent);
    return xml;
  }

  private objectToXml(obj: unknown, indent: string = ''): string {
    let xml = '';
    
    const objRec = obj as Record<string, unknown>;
    for (const key in objRec) {
      const value = objRec[key];
      
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

  private elementToXml(tagName: string, value: unknown, indent: string): string {
    const nextIndent = indent + '  ';
    
    if (value === null || value === undefined) {
      return '';
    }
    
    let xml = `${indent}<${tagName}`;
    
    // Add attributes
    const valRec = value as Record<string, unknown>;
    if (valRec.$ && typeof valRec.$ === 'object') {
      for (const attrName in valRec.$) {
        const attrValue = (valRec.$ as Record<string, unknown>)[attrName];
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
  /**
   * Returns true if the element ID refers to a BPMN gateway element.
   * Gateways are intentionally not mapped to DEXPI process steps; flows
   * through them are silently skipped without warning.
   */
  private isGateway(elementId: string): boolean {
    if (!this.doc) return false;
    const el = this.doc.querySelector(`[id="${elementId}"]`);
    if (!el) return false;
    const tag = (el.localName || el.tagName.split(':').pop() || '').toLowerCase();
    return tag.includes('gateway');
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
    // DEXPI XSD ID pattern: [A-Za-z_][A-Za-z_0-9]* — no hyphens allowed
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substr(2, 8).replace(/[^a-zA-Z0-9]/g, 'X');
    return `u_${ts}_${rand}`;
  }

  /** Sanitize an arbitrary string for use as a DEXPI XML ID.
   *  Replaces any character not in [A-Za-z0-9_] with '_' and
   *  prepends 'u_' if the string starts with a digit. */
  private sanitizeId(raw: string): string {
    const clean = raw.replace(/[^A-Za-z0-9_]/g, '_');
    return /^[A-Za-z_]/.test(clean) ? clean : `u_${clean}`;
  }
}

export const transformer = new BpmnToDexpiTransformer();
