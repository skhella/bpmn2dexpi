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
  ValidationResult,
} from './types';
import { TransformerLogger } from './TransformerLogger';
import { DexpiProcessClassRegistry } from './DexpiProcessClassRegistry';
import {
  validateEmittedDexpiXml as validateDexpiPropertyNamesImpl,
  failuresToValidationResult as failuresToValidationResultImpl,
} from './DexpiPropertyNameValidator';
import { validateEmittedDexpiDataTypes } from './DexpiDataTypeValidator';
import { validateEmittedDexpiReferences } from './DexpiReferenceValidator';
import { validateEmittedDexpiCardinality } from './DexpiCardinalityValidator';
import { validateEmittedDexpiClassExistence } from './DexpiClassExistenceValidator';
// Authoritative source of the OriginatingSystem* metadata for the
// EngineeringModel root. Pulling from package.json keeps "Originating system
// name = bpmn2dexpi", vendor = author, version = the npm version always in
// sync; no separate hardcoded copy that could drift.
import pkg from '../../package.json';

export type { TransformOptions } from './types';
export { validateDexpiOutput } from './DexpiOutputValidator';
export { validateEmittedDexpiXml as validateDexpiPropertyNames } from './DexpiPropertyNameValidator';
export { failuresToValidationResult, formatFailures } from './DexpiPropertyNameValidator';
export { validateEmittedDexpiDataTypes } from './DexpiDataTypeValidator';
export { validateEmittedDexpiReferences } from './DexpiReferenceValidator';
export { validateEmittedDexpiCardinality } from './DexpiCardinalityValidator';
export { validateEmittedDexpiClassExistence } from './DexpiClassExistenceValidator';

/**
 * DEXPI BPMN-extension namespace URI. Mirrors dexpi/moddle/dexpi.json's
 * `uri` and the xmlns:dexpi declaration in fixtures and tests. Used by
 * findByLocalName() to resolve <dexpi:*> elements by namespace+localName,
 * which is the explicit, prefix-independent way to walk the extensionElements
 * tree (CSS type selectors match qualified name in XML and would miss us).
 */
const DEXPI_NS = 'http://dexpi.org/schema/bpmn-extension';

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

  /**
   * Lookup populated at the start of buildDexpiModel: sanitized port id →
   * sanitized ProcessConnection (Stream / InformationFlow) Object id. Lets
   * port emission satisfy DEXPI's Port.ConnectorReference (lower=1) by
   * pointing at the connection that uses the port. Built once per transform.
   */
  private portConnectorMap: Map<string, string> = new Map();

  /** Warnings and errors collected during the last call to transform(). */
  readonly logger = new TransformerLogger();

  /**
   * Tier-2 (property-name + carrier-kind) validation result from the most
   * recent transform() call, populated only when strict mode is on.
   * Strict-mode failures never block file production (DEXPI 2.0 permissive
   * philosophy); they sit here for the caller (CLI, UI) to surface as
   * warnings.
   */
  lastPropertyNameValidation: ValidationResult | undefined;

  /**
   * Tier-3 (data-type) validation result. Populated when strict mode is on.
   * Catches typoed enum literals, non-numeric Doubles, out-of-range
   * UnsignedBytes, malformed DateTime/AnyURI strings.
   */
  lastDataTypeValidation: ValidationResult | undefined;

  /**
   * Tier-4 (reference target-class) validation result. Populated when
   * strict mode is on. Catches `<References objects="#X"/>` and
   * `<ObjectReference object="#X"/>` whose target object's class doesn't
   * match (or subclass) the declared target class.
   */
  lastReferenceValidation: ValidationResult | undefined;

  /**
   * Tier-5 (cardinality) validation result. Populated when strict mode is
   * on. Catches missing-required and exceeds-upper-bound property counts.
   */
  lastCardinalityValidation: ValidationResult | undefined;

  /**
   * Tier-6 (class existence) validation result — defense-in-depth post-condition
   * check. Populated when strict mode is on. Should never fire for clean
   * transformer runs given the resolveStepType fallback chain; if it does,
   * either a new emission path bypassed resolveStepType or a Profile that
   * declared a custom class was not loaded into the validation registry.
   */
  lastClassExistenceValidation: ValidationResult | undefined;

  async transform(bpmnXml: string, options: TransformOptions = {}): Promise<string> {

    // Clear state and log from previous transformations
    this.logger.reset();
    this.lastPropertyNameValidation = undefined;
    this.lastDataTypeValidation = undefined;
    this.lastReferenceValidation = undefined;
    this.lastCardinalityValidation = undefined;
    this.lastClassExistenceValidation = undefined;

    // Load DEXPI class registry. We always include any user-supplied
    // DEXPI Profile extensions so Profile classes (e.g. BiologicalReactor)
    // are recognized as valid dexpiType targets in both strict and
    // non-strict modes — without this, non-strict transforms would log a
    // "not a recognised DEXPI 2.0 Process class" warning for every Profile
    // class. In strict mode we additionally include Core.xml so the
    // property-name validator can walk the full supertype chain
    // (Process → Core).
    const wantProfiles = (options.profileXmls?.length ?? 0) > 0;
    if (options.strict || wantProfiles) {
      const sources: { name: string; xml: string }[] = [];
      if (options.processXml) {
        sources.push({ name: 'Process.xml', xml: options.processXml });
      }
      if (options.coreXml) {
        sources.push({ name: 'Core.xml', xml: options.coreXml });
      }
      if (sources.length > 0) {
        sources.push(...(options.profileXmls ?? []));
        this.registry = DexpiProcessClassRegistry.fromXmlSources(sources);
      } else {
        this.registry = await DexpiProcessClassRegistry.loadDefault({
          extensions: options.profileXmls,
        });
      }
    } else {
      this.registry = await DexpiProcessClassRegistry.load(options.processXml);
    }
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
    this.portConnectorMap.clear();

    // Parse BPMN XML
    const bpmnModel = this.parseBpmn(bpmnXml);
    this.doc = bpmnModel;
    
    // Extract DEXPI elements
    this.extractElements(bpmnModel);
    
    // Build DEXPI XML structure
    const dexpiModel = this.buildDexpiModel(options);
    
    // Generate XML
    const xml = this.generateXml(dexpiModel);

    // Strict-mode property-name fidelity validation runs against the
    // already-generated XML so it never delays or blocks output. Failures
    // are stored on the transformer for the caller to surface; the file
    // still gets produced — DEXPI 2.0's permissive philosophy says any
    // XSD-valid output is exchangeable, and we don't want strict mode to
    // gate users out of getting a deliverable.
    if (options.strict && this.registry.size > 0) {
      // Tier 2: property-name + carrier-kind fidelity.
      const nameFailures = validateDexpiPropertyNamesImpl(xml, 'transformer output', this.registry);
      this.lastPropertyNameValidation = failuresToValidationResultImpl(nameFailures);

      // Tier 3: data-type fidelity (Builtin primitives + Enumeration literals).
      const dataTypeFailures = validateEmittedDexpiDataTypes(xml, 'transformer output', this.registry);
      this.lastDataTypeValidation = {
        valid: dataTypeFailures.length === 0,
        errors: dataTypeFailures.map(f => `${f.className}.${f.propertyName}: ${f.context}`),
        warnings: [],
        mode: 'property-names' as ValidationResult['mode'],
      };

      // Tier 4: reference target-class compliance.
      const refFailures = validateEmittedDexpiReferences(xml, 'transformer output', this.registry);
      this.lastReferenceValidation = {
        valid: refFailures.length === 0,
        errors: refFailures.map(f => `${f.className}.${f.propertyName}: ${f.context}`),
        warnings: [],
        mode: 'property-names' as ValidationResult['mode'],
      };

      // Tier 5: cardinality (lower / upper bounds).
      const cardFailures = validateEmittedDexpiCardinality(xml, 'transformer output', this.registry);
      this.lastCardinalityValidation = {
        valid: cardFailures.length === 0,
        errors: cardFailures.map(f => `${f.className}.${f.propertyName}: ${f.context}`),
        warnings: [],
        mode: 'property-names' as ValidationResult['mode'],
      };

      // Tier 6: class existence — defense-in-depth post-condition.
      const classFailures = validateEmittedDexpiClassExistence(xml, 'transformer output', this.registry);
      this.lastClassExistenceValidation = {
        valid: classFailures.length === 0,
        errors: classFailures.map(f => `${f.typeRef}: ${f.context}`),
        warnings: [],
        mode: 'property-names' as ValidationResult['mode'],
      };

      // Surface a single aggregated warning to the logger when any tier
      // produced findings, so CLI / UI consumers see the issue without
      // having to introspect each `last*Validation` field individually.
      const totals = [
        ['property-name + kind',        nameFailures.length],
        ['data-type',                   dataTypeFailures.length],
        ['reference target-class',      refFailures.length],
        ['cardinality',                 cardFailures.length],
        ['class existence',             classFailures.length],
      ] as const;
      const nonZero = totals.filter(([, n]) => n > 0);
      if (nonZero.length > 0) {
        const summary = nonZero.map(([label, n]) => `${label}: ${n}`).join(', ');
        this.logger.warn(`Strict-mode fidelity findings — ${summary}. ` +
          `Output is still produced (DEXPI 2.0 permissive philosophy); ` +
          `inspect transformer.last{PropertyName,DataType,Reference,Cardinality,ClassExistence}Validation for details.`);
      }
    }

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
   * Resolve the DEXPI type for a process step. Three-mode resolution chain,
   * tried in priority order; each mode emits a distinct warning so the
   * caller knows which fallback was taken.
   *
   *   Mode 1 'dexpi-validated' — dexpiType is in the registry. No warning.
   *
   *   Mode 2 'custom-supertype' — dexpiType is NOT in the registry, but
   *     customSuperType IS. Emit the custom class as the type; the paired
   *     Profile (generated separately) declares it as a subclass of the
   *     chosen supertype. Warns that a Profile must accompany the export.
   *
   *   Mode 3 'unvalidated' — no annotation, or neither dexpiType nor
   *     customSuperType is recognised. Falls back to generic ProcessStep.
   *     The warning is specific about which input was missing or unknown
   *     so the user can fix the source. No fuzzy "did you mean?" hint
   *     (R1-C3: heuristic class matching is out of scope).
   */
  private resolveStepType(
    annotatedType: string | undefined,
    customUri: string | undefined,
    customSuperType: string | undefined,
    taskName: string,
    taskId: string
  ): StepTypingResult {

    const registryReady = this.registry.size > 0;

    // ── Mode 1: explicit annotation, validated against registry ──────────────
    if (annotatedType && (!registryReady || this.registry.isValidClass(annotatedType))) {
      return { dexpiClass: annotatedType, mode: 'dexpi-validated' };
    }

    // ── Mode 2: custom class with a known DEXPI supertype ───────────────────
    // Preserve the custom class name; the Profile generator will declare it
    // as a ConcreteClass with the chosen supertype. Reload-validate closes
    // the loop without losing the custom type.
    if (
      annotatedType &&
      customSuperType &&
      registryReady &&
      this.registry.isValidClass(customSuperType)
    ) {
      this.logger.warn(
        `Task "${taskName}" (id=${taskId}): dexpiType="${annotatedType}" is a custom class ` +
        `(not in the DEXPI Process registry). Emitted as-is; pair this export with a ` +
        `generated Profile that declares "${annotatedType}" as a subclass of "${customSuperType}".`
      );
      return {
        dexpiClass: annotatedType,
        mode: 'custom-supertype',
        customUri,
        customSuperType,
      };
    }

    // ── Mode 3: unvalidated — fall back to generic ProcessStep ──────────────
    if (annotatedType && customSuperType) {
      this.logger.warn(
        `Task "${taskName}" (id=${taskId}): both dexpiType="${annotatedType}" and ` +
        `customSuperType="${customSuperType}" are unknown to the DEXPI Process registry — ` +
        `exporting as generic ProcessStep. Pick a known DEXPI class as the supertype to ` +
        `preserve the custom name.`
      );
    } else if (annotatedType) {
      this.logger.warn(
        `Task "${taskName}" (id=${taskId}): dexpiType="${annotatedType}" is not in the ` +
        `DEXPI Process registry — exporting as generic ProcessStep. Set a customSuperType ` +
        `(any known DEXPI class) to preserve the custom name and emit a Profile.`
      );
    } else {
      this.logger.warn(
        `Task "${taskName}" (id=${taskId}) has no dexpiType annotation — exporting as ` +
        `generic ProcessStep. Add a dexpiType in extensionElements to assign a specific ` +
        `DEXPI class.`
      );
    }

    return {
      dexpiClass: 'ProcessStep',
      mode: 'unvalidated',
      customUri,
      customSuperType,
    };
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
      dexpiData?.customSuperType,
      name,
      id
    );

    const processStep: InternalProcessStep = {
      id,
      name,
      type: typing.dexpiClass,
      typingMode: typing.mode,
      customUri: typing.customUri,
      customSuperType: typing.customSuperType,
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

    // For new format with dexpi:element, check if dexpiType is explicitly set to 'Source'
    // If dexpiType exists but is not 'Source', skip this event (it's a proxy port)
    if (dexpiData?.dexpiType && dexpiData.dexpiType !== 'Source') {
      return;
    }

    // If the source event is nested inside a bpmn:subProcess, it belongs to
    // that subprocess's SubProcessSteps, not the root plane. Walk up the DOM
    // to find the nearest enclosing subProcess.
    const parentSubProcessId = this.findEnclosingSubProcessId(event);

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
      parentId: parentSubProcessId,
      subProcessSteps: [],
    };

    this.processSteps.set(id, source);
    if (parentSubProcessId) {
      const parent = this.processSteps.get(parentSubProcessId);
      if (parent && !parent.subProcessSteps.includes(id)) parent.subProcessSteps.push(id);
    }

    source.ports.forEach((port: DexpiPort) => {
      this.ports.set(port.portId, { ...port, stepId: id });
    });
  }

  private extractSink(event: Element): void {
    const id = event.getAttribute('id') || '';
    const name = event.getAttribute('name') || id;

    const dexpiData = this.extractDexpiExtension(event);

    // For new format with dexpi:element, check if dexpiType is explicitly set to 'Sink'
    // If dexpiType exists but is not 'Sink', skip this event (it's a proxy port)
    if (dexpiData?.dexpiType && dexpiData.dexpiType !== 'Sink') {
      return;
    }

    // If the sink event is nested inside a bpmn:subProcess, it belongs to
    // that subprocess's SubProcessSteps, not the root plane.
    const parentSubProcessId = this.findEnclosingSubProcessId(event);

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
      parentId: parentSubProcessId,
      subProcessSteps: [],
    };

    this.processSteps.set(id, sink);
    if (parentSubProcessId) {
      const parent = this.processSteps.get(parentSubProcessId);
      if (parent && !parent.subProcessSteps.includes(id)) parent.subProcessSteps.push(id);
    }

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
      sourcePortId: dexpiData?.sourcePortId,
      targetPortId: dexpiData?.targetPortId,
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
      sourcePortId: dexpiData.sourcePortId,
      targetPortId: dexpiData.targetPortId,
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

        // Schema-correct instrumentation references (DEXPI 2.0 Specification PDF
        // pp.876, 900): InstrumentationActivity has no Ports composition; its
        // connection to the process is expressed via ProcessStepReference and
        // MeasuredVariableReference. We derive these from the BPMN topology:
        // the dataObject's name carries the variable identity, and the OTHER
        // endpoint of the dataObject pattern is the related ProcessStep when
        // it is one. Populate the InstrumentationActivity record on each end
        // that is itself an InstrumentationActivity descendant.
        const sourceStep = this.processSteps.get(source);
        const targetStep = target ? this.processSteps.get(target) : undefined;
        const isInstr = (s: InternalProcessStep | undefined): boolean => {
          if (!s) return false;
          if (this.registry.size === 0) return false;
          const bare = s.type.replace(/^Process\./, '');
          return this.registry.hasAncestor(bare, 'InstrumentationActivity');
        };
        const remember = (psStep: InternalProcessStep, varName: string) => {
          if (!psStep.measuredParameters) psStep.measuredParameters = new Set<string>();
          psStep.measuredParameters.add(varName);
        };
        if (isInstr(sourceStep) && targetStep && !isInstr(targetStep)) {
          // MeasuringActivity → DataObject → ProcessStep:
          // source instrumentation references the target ProcessStep.
          sourceStep!.processStepRef = target!;
          sourceStep!.measuredVariable = name;
          remember(targetStep, name);
        }
        if (targetStep && isInstr(targetStep) && sourceStep && !isInstr(sourceStep)) {
          // ProcessStep → DataObject → ControllingActivity (or similar):
          // target instrumentation references the source ProcessStep.
          targetStep.processStepRef = source;
          targetStep.measuredVariable = name;
          remember(sourceStep, name);
        }
        // instr-to-instr: neither endpoint is a ProcessStep — no
        // ProcessStepReference to derive. Both activities still carry the
        // measuredVariable from the dataObject name; the spec captures the
        // relationship by their shared InstrumentationSystemActivity context.
        if (isInstr(sourceStep) && isInstr(targetStep)) {
          if (!sourceStep!.measuredVariable) sourceStep!.measuredVariable = name;
          if (!targetStep!.measuredVariable) targetStep!.measuredVariable = name;
        }
      });
    });
  }

  private extractMaterialData(dataObj: Element): void {
    const id = dataObj.getAttribute('id') || '';
    const name = dataObj.getAttribute('name') || id;
    
    const extensionElements = dataObj.querySelector('extensionElements');
    if (!extensionElements) return;

    // Extract MaterialTemplates
    const templates = this.findByLocalName(extensionElements, 'MaterialTemplate');
    templates.forEach(template => {
      const uid = template.getAttribute('uid') || this.generateUid();
      const identifier = this.getChildText(template, 'Identifier');
      const label = this.getChildText(template, 'Label');
      const description = this.getChildText(template, 'Description');
      const numberOfComponents = this.getChildText(template, 'NumberOfMaterialComponents');
      const numberOfPhases = this.getChildText(template, 'NumberOfPhases');

      // Extract component references. Carrier-wrapped form is preferred:
      //   <dexpi:references property="ListOfComponents" objects="#X #Y ..."/>
      // (kind=reference, recorded explicitly via the carrier element name).
      // Legacy bare-name forms are kept for back-compat with already-saved
      // BPMN files: <ListOfComponents> wrapping <Component uidRef=...> or
      // the older <ListOfMaterialComponents><MaterialComponentIdentifier>.
      const componentRefs: string[] = [];
      // Carrier form: <dexpi:references property="ListOfComponents" objects="#X #Y..."/>
      // or uidRef="X Y..." (space-separated multi-valued refs).
      for (const c of Array.from(template.children) as Element[]) {
        if ((c.localName || '').toLowerCase() === 'references' &&
            c.getAttribute('property') === 'ListOfComponents') {
          const objects = c.getAttribute('objects') || c.getAttribute('uidRef') || '';
          for (const tok of objects.split(/\s+/).filter(Boolean)) {
            componentRefs.push(tok.replace(/^#/, ''));
          }
        }
      }
      if (componentRefs.length === 0) {
        // Legacy bare-name fallback.
        const listOfComponents = Array.from(template.children).find((c: Element) =>
          c.localName === 'ListOfComponents' || c.localName === 'listOfComponents' ||
          c.localName === 'ListOfMaterialComponents' || c.localName === 'listOfMaterialComponents'
        );
        if (listOfComponents) {
          const refs = Array.from(listOfComponents.children).filter((c: Element) =>
            c.localName === 'Component' || c.localName === 'component' ||
            c.localName === 'MaterialComponentIdentifier' || c.localName === 'materialComponentIdentifier'
          );
          refs.forEach((id: Element) => {
            const uidRef = id.getAttribute('uidRef');
            if (uidRef) componentRefs.push(uidRef);
          });
        }
      }

      // Extract phase labels. Carrier-wrapped form is preferred:
      //   <dexpi:data property="PhaseLabel">Liquid</dexpi:data>  (×N siblings)
      // (kind=data, multi-valued DataProperty). Legacy bare-name fallbacks:
      //   <PhaseLabel>Liquid</PhaseLabel>  (siblings, pre-carrier canonical)
      //   <ListOfPhases><PhaseIdentifier Identifier="..."/></ListOfPhases>
      // (folk wrapper from before the PhaseLabel rename).
      const phases: string[] = [];
      Array.from(template.children).forEach((c: Element) => {
        const ll = (c.localName || '').toLowerCase();
        if (ll === 'data' && c.getAttribute('property') === 'PhaseLabel') {
          const text = c.textContent?.trim();
          if (text) phases.push(text);
        } else if (c.localName === 'PhaseLabel' || c.localName === 'phaseLabel') {
          const text = c.textContent?.trim();
          if (text) phases.push(text);
        } else if (c.localName === 'ListOfPhases' || c.localName === 'listOfPhases') {
          this.findByLocalName(c, 'PhaseIdentifier').forEach((p: Element) => {
            const identifier = p.getAttribute('Identifier') || this.getChildText(p, 'Identifier');
            if (identifier) phases.push(identifier);
          });
        }
      });

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
    const components = this.findByLocalName(extensionElements, 'MaterialComponent');
    components.forEach(component => {
      const uid = component.getAttribute('uid') || this.generateUid();
      const identifier = this.getChildText(component, 'Identifier');
      const label = this.getChildText(component, 'Label');
      const description = this.getChildText(component, 'Description');
      const chebiId = this.getChildText(component, 'ChEBI_identifier');
      const iupacId = this.getChildText(component, 'IUPAC_identifier');
      const xsiType = component.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type') ||
                      component.getAttribute('xsi:type') || 'CustomMaterialComponent';

      // Walk every child to capture project-extension data beyond the
      // canonical fields above. Without this, anything authored on a
      // MaterialComponent outside Identifier/Label/Description/ChEBI/
      // IUPAC (e.g. MolecularWeight, AntoineA, IsEffectivelyNoncondensable,
      // ProjectReference) is silently dropped on read and never reaches
      // the emitted DEXPI XML.
      const RECOGNIZED_DATA = new Set(['Identifier', 'Label', 'Description', 'ChEBI_identifier', 'IUPAC_identifier']);
      const properties: NonNullable<InternalMaterialComponent['properties']> = [];
      for (const child of Array.from(component.children) as Element[]) {
        const ll = (child.localName || '').toLowerCase();
        const propName = child.getAttribute('property') || '';
        if (ll === 'data') {
          if (RECOGNIZED_DATA.has(propName)) continue;
          const text = (child.textContent ?? '').trim();
          if (!propName || !text) continue;
          properties.push({ kind: 'data', name: propName, value: text });
        } else if (ll === 'components') {
          // Look for a Core/QualifiedValue object child and extract its
          // Value / Unit / UnitReference flat data children.
          const objs = Array.from(child.children) as Element[];
          const qv = objs.find(o => (o.localName || '').toLowerCase() === 'object' &&
                                    (o.getAttribute('type') === 'Core/QualifiedValue'));
          if (!qv || !propName) continue;
          let value = '';
          let unit: string | undefined;
          let unitReference: string | undefined;
          for (const data of Array.from(qv.children) as Element[]) {
            if ((data.localName || '').toLowerCase() !== 'data') continue;
            const dp = data.getAttribute('property');
            const dv = (data.textContent ?? '').trim();
            if (dp === 'Value') value = dv;
            else if (dp === 'Unit') unit = dv;
            else if (dp === 'UnitReference') unitReference = dv;
          }
          if (!value) continue;
          properties.push({ kind: 'composition', name: propName, value, unit, unitReference });
        }
      }

      this.materialComponents.set(uid, {
        uid,
        identifier,
        label,
        description,
        chebiId,
        iupacId,
        xsiType,
        properties: properties.length > 0 ? properties : undefined,
      });
    });

    // Extract MaterialStates from Case elements (new structure) or direct children (legacy)
    const cases = this.findByLocalName(extensionElements, 'Case');
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
        const states = this.findByLocalName(caseElement, 'MaterialState');
        states.forEach(state => {
          this.extractMaterialState(state, caseName || name);
        });
      });
    } else {
      // LEGACY STRUCTURE: MaterialStates directly in extensionElements
      const states = this.findByLocalName(extensionElements, 'MaterialState');
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

    // Restructured form (Process.xml-aligned): MaterialState references a
    // sibling MaterialStateType via <dexpi:references property="State"
    // uidRef="..."/>; the MaterialStateType holds MoleFlow + a Composition
    // reference; the Composition holds Display + MoleFractions/MassFractions.
    // Read this chain when present.
    const stateTypeRefUid = this.getChildValue(state, 'State', 'uidRef');
    let flow: import('./types').FlowData | null = null;
    let resolvedStateTypeUid: string | undefined;

    if (stateTypeRefUid) {
      // Find the sibling MaterialStateType by uid in the same extensionElements.
      const root = state.parentElement;
      let mst: Element | undefined;
      if (root) {
        mst = Array.from(root.children).find((c: Element) =>
          (c.localName === 'MaterialStateType' || c.localName === 'materialStateType') &&
          c.getAttribute('uid') === stateTypeRefUid
        ) as Element | undefined;
      }
      if (mst) {
        resolvedStateTypeUid = stateTypeRefUid;
        flow = {};
        // State-level scalar MoleFlow lives on MaterialStateType. DEXPI
        // 2.0's MaterialStateType has scalar MassFlow / VolumeFlow but no
        // scalar MoleFlow — a real vocabulary gap. We Profile-extend
        // MaterialStateType with a scalar MoleFlow (parallel to its
        // existing scalar MassFlow); the Profile generator captures this
        // as a genuine project-specific extension. Composition's MoleFlow
        // (Process.xml line 426) is a different concept: a multi-valued
        // PER-COMPONENT vector keyed to the MaterialTemplate's component
        // list, NOT a state-level scalar.
        const moleFlowQv = this.findCarrierComponentsQualifiedValue(mst, 'MoleFlow');
        if (moleFlowQv) {
          flow.moleFlow = {
            value: this.getChildText(moleFlowQv, 'Value'),
            unit: this.getChildText(moleFlowQv, 'Unit'),
          };
        }
        // Composition reference → resolve to Composition sibling block.
        const compRefUid = this.getChildValue(mst, 'Composition', 'uidRef');
        if (compRefUid) {
          const comp = Array.from(root!.children).find((c: Element) =>
            (c.localName === 'Composition' || c.localName === 'composition') &&
            c.getAttribute('uid') === compRefUid
          ) as Element | undefined;
          if (comp) {
            const display = this.getChildText(comp, 'Display');
            // Composition's fractions properties per Process.xml are
            // MoleFractiona (sic — typo for MoleFractions in the published
            // schema; faithful reproduction here, flagged upstream),
            // MassFractions, VolumeFractions. Each is a CompositionProperty
            // wrapping a QualifiedValue<PhysicalQuantityVector> whose
            // Values DataProperty is multi-valued (one <dexpi:data
            // property="Values">v</dexpi:data> per component).
            const fractionsQv =
              this.findCarrierComponentsQualifiedValue(comp, 'MoleFractiona') ??
              this.findCarrierComponentsQualifiedValue(comp, 'MassFractions') ??
              this.findCarrierComponentsQualifiedValue(comp, 'VolumeFractions');
            const basis = fractionsQv
              ? (this.findCarrierComponentsPropertyName(comp, 'MoleFractiona')
                  ? 'Mole'
                  : this.findCarrierComponentsPropertyName(comp, 'MassFractions')
                    ? 'Mass'
                    : 'Volume')
              : '';
            const values: { value: string }[] = [];
            if (fractionsQv) {
              for (const c of Array.from(fractionsQv.children) as Element[]) {
                if ((c.localName || '').toLowerCase() === 'data' &&
                    c.getAttribute('property') === 'Values') {
                  values.push({ value: (c.textContent ?? '').trim() });
                }
              }
            }
            flow.composition = {
              basis,
              display,
              fractions: values.map(v => ({ value: v.value, componentRef: '' })),
            };
          }
        }
      }
    }

    // Legacy inline-Flow fallback for fixtures saved before the
    // MaterialState→MaterialStateType→Composition restructure.
    if (!flow) {
      const flowElement = Array.from(state.children).find((c: Element) =>
        (c.localName || '').toLowerCase() === 'flow'
      );
      if (flowElement) {
        const moleFlowElement = Array.from(flowElement.children).find((c: Element) =>
          (c.localName || '').toLowerCase() === 'moleflow'
        );
        const compositionElement = Array.from(flowElement.children).find((c: Element) =>
          (c.localName || '').toLowerCase() === 'composition'
        );
        flow = {};
        if (moleFlowElement) {
          flow.moleFlow = {
            value: this.getChildText(moleFlowElement as Element, 'Value'),
            unit: this.getChildText(moleFlowElement as Element, 'Unit'),
          };
        }
        if (compositionElement) {
          const fractions = this.findByLocalName(compositionElement as Element, 'Fraction');
          flow.composition = {
            basis: this.getChildText(compositionElement as Element, 'Basis'),
            display: this.getChildText(compositionElement as Element, 'Display'),
            fractions: fractions.map(f => ({
              value: this.getChildText(f, 'Value'),
              componentRef: this.getChildText(f, 'ComponentReference'),
            })),
          };
        }
      }
    }

    // Synthesize a MaterialStateType internal record. Prefer the resolved
    // uid from the State reference; fall back to a derived uid for legacy
    // inline-Flow fixtures (the old "${uid}_Type" convention).
    const stateTypeUid = resolvedStateTypeUid ?? `${uid}_Type`;
    if (flow) {
      this.materialStateTypes.set(stateTypeUid, {
        uid: stateTypeUid,
        identifier: `${identifier}_Type`,
        label: `${label} - Flow Data`,
        description: `Flow data for ${label}`,
        templateRef,
        flow,
      });
    }

    this.materialStates.set(uid, {
      uid,
      identifier,
      label: caseName ? `${caseName} - ${label}` : label,
      description,
      caseName: caseName,
      stateTypeRef: flow ? stateTypeUid : undefined,
    });
  }

  /**
   * Find a Components carrier with property="X" inside `parent`, and return
   * its inner <dexpi:object type="Core/QualifiedValue"> element. Returns
   * undefined if not present. Used to descend through the
   * MaterialStateType → MoleFlow → QualifiedValue chain and similar paths.
   */
  /**
   * Descendant lookup by local name. parseBpmn() strips bpmn:/bpmn2: prefixes
   * but leaves dexpi: intact, so CSS type-selector lookups via
   * querySelectorAll('MaterialState') match by qualified name and silently
   * miss <dexpi:MaterialState>. The natural alternative
   * getElementsByTagNameNS(DEXPI_NS, ...) is unreliable across DOM engines
   * (happy-dom, used by the test suite, does not resolve declared XML
   * namespace prefixes — empty result for both the DEXPI URI and the '*'
   * wildcard). A manual depth-first walk over child elements, comparing
   * localName, is the only approach that works identically in browsers
   * and in happy-dom. The walk is bounded — only DEXPI extensionElements
   * subtrees are traversed in practice.
   *
   * Match constraint: element's namespaceURI is DEXPI or null. Real
   * browsers populate namespaceURI from the xmlns:dexpi declaration so
   * stray look-alikes in unrelated namespaces are still excluded; in
   * happy-dom namespaceURI is null and the localName test alone applies.
   */
  private findByLocalName(parent: Element, localName: string): Element[] {
    // Match case-insensitively so the helper works after a bpmn-moddle
    // round-trip, where dexpi.json's `tagAlias: lowerCase` rewrites
    // <dexpi:MaterialState> as <dexpi:materialState> on saveXML().
    // Without this, every UI-saved model silently loses material data
    // (MaterialState, MaterialTemplate, MaterialComponent, Case,
    // PhaseIdentifier, Fraction) because the discovery pass misses
    // every element whose first letter was lowercased.
    const target = localName.toLowerCase();
    const out: Element[] = [];
    const walk = (node: Element): void => {
      for (const child of Array.from(node.children) as Element[]) {
        if ((child.localName ?? '').toLowerCase() === target) {
          const ns = child.namespaceURI;
          if (!ns || ns === DEXPI_NS) out.push(child);
        }
        walk(child);
      }
    };
    walk(parent);
    return out;
  }

  private findCarrierComponentsQualifiedValue(parent: Element, propertyName: string): Element | undefined {
    for (const c of Array.from(parent.children) as Element[]) {
      if ((c.localName || '').toLowerCase() === 'components' &&
          c.getAttribute('property') === propertyName) {
        const obj = Array.from(c.children).find((o: Element) =>
          (o.localName || '').toLowerCase() === 'object'
        );
        if (obj) return obj as Element;
      }
    }
    return undefined;
  }

  /** Returns true if parent has a <dexpi:components property="X"> child. */
  private findCarrierComponentsPropertyName(parent: Element, propertyName: string): boolean {
    for (const c of Array.from(parent.children) as Element[]) {
      if ((c.localName || '').toLowerCase() === 'components' &&
          c.getAttribute('property') === propertyName) {
        return true;
      }
    }
    return false;
  }

  /**
   * Read a DataProperty value from a DEXPI rich-content element. Prefers
   * the carrier-wrapped form
   *   <dexpi:data property="Identifier">X</dexpi:data>
   * (kind recorded explicitly via the carrier element name), and falls
   * back to the legacy bare-name form
   *   <Identifier>X</Identifier>
   * for content saved before the carrier migration. Both shapes coexist
   * during the migration window; the bare-name fallback is kept as a
   * defensive read-path for hand-authored legacy BPMN files and is not
   * exercised by the canonical TEP fixture or the UI write paths.
   */
  private getChildText(parent: Element, childName: string): string {
    // Carrier form first.
    for (const c of Array.from(parent.children) as Element[]) {
      if ((c.localName === 'data' || c.localName === 'Data') &&
          c.getAttribute('property') === childName) {
        return (c.textContent ?? '').trim();
      }
    }
    // Bare-name fallback.
    const child = Array.from(parent.children).find((c: Element) =>
      c.tagName === childName || c.localName === childName
    );
    return child?.textContent || '';
  }

  /**
   * Read a ReferenceProperty's target attribute from a DEXPI rich-content
   * element. Prefers carrier-wrapped form
   *   <dexpi:references property="MaterialTemplateReference" uidRef="X"/>
   * (kind = reference, recorded explicitly), and accepts the DEXPI XSD
   * `objects="#X"` form alongside `uidRef`. Falls back to legacy bare-name
   *   <MaterialTemplateReference uidRef="X"/>
   * for content saved before the carrier migration.
   */
  private getChildValue(parent: Element, childName: string, attrName: string): string {
    // Carrier form first (References).
    for (const c of Array.from(parent.children) as Element[]) {
      if ((c.localName === 'references' || c.localName === 'References') &&
          c.getAttribute('property') === childName) {
        // For uidRef requests, also accept the DEXPI XSD `objects="#X"`
        // form so the reader is symmetric with the standalone DEXPI XML
        // shape (which uses `objects=`) without forcing every carrier
        // author to know that.
        const direct = c.getAttribute(attrName);
        if (direct) return direct;
        if (attrName === 'uidRef') {
          const objects = c.getAttribute('objects');
          if (objects) return objects.replace(/^#/, '');
        }
        return '';
      }
    }
    // Bare-name fallback.
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
        // customSuperType: user-chosen DEXPI parent class for a custom dexpiType.
        // Picked from the registry (Process + Core + already-loaded Profiles) in the
        // panel UI. Consumed by the Profile generator when synthesising a
        // <ConcreteClass> declaration for the custom class.
        customSuperType: dexpiElement.getAttribute('customSuperType') || undefined,
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
      const ll = localName.toLowerCase();

      // ── Carrier-wrapped form (preferred) ────────────────────────────────
      // <dexpi:references property="X" uidRef="..."/>
      // <dexpi:components property="X"><dexpi:object type="Core/QualifiedValue">
      //   <dexpi:data property="Value">...</dexpi:data>
      //   <dexpi:data property="Unit">...</dexpi:data>
      //   <dexpi:data property="Provenance">...</dexpi:data>
      //   <dexpi:data property="Range">...</dexpi:data>
      // </dexpi:object></dexpi:components>
      // The carrier element name encodes kind explicitly (Data → DataProperty,
      // References → ReferenceProperty, Components → CompositionProperty),
      // so the reader doesn't need shape inference.
      if (ll === 'references') {
        const propertyName = child.getAttribute('property') || '';
        const target = child.getAttribute('uidRef') ||
          (child.getAttribute('objects') || '').replace(/^#/, '') || undefined;
        if (propertyName === 'MaterialStateReference') materialStateRef = target;
        else if (propertyName === 'MaterialTemplateReference') templateRef = target;
        // Other ReferenceProperty values on Stream pass through unrecognized.
        continue;
      }
      if (ll === 'components') {
        const propertyName = child.getAttribute('property') || '';
        // Look for the inner <dexpi:object type="Core/QualifiedValue">.
        const obj = Array.from(child.children).find((o: Element) =>
          (o.localName || '').toLowerCase() === 'object'
        );
        if (!obj) continue;
        // Extract QualifiedValue's <dexpi:data property="X">v</dexpi:data> entries.
        const readData = (name: string): string => {
          for (const d of Array.from(obj.children) as Element[]) {
            if ((d.localName || '').toLowerCase() === 'data' &&
                d.getAttribute('property') === name) {
              return (d.textContent ?? '').trim();
            }
          }
          return '';
        };
        const value = readData('Value');
        if (!value) continue; // CompositionProperty with no value is uninteresting
        attributes.push({
          name: propertyName,
          value,
          unit: readData('Unit'),
          scope: readData('Scope') || 'Design',
          range: readData('Range') || 'Nominal',
          provenance: readData('Provenance') || 'Calculated',
          qualifier: readData('Qualifier') || 'Average',
        });
        continue;
      }

      // ── Legacy bare-name fallbacks (kept so already-saved BPMN files
      // continue to round-trip during the migration window) ───────────────
      if (ll === 'attribute' || ll === 'streamattribute') {
        // Unified <dexpi:Attribute> child (canonical pre-carrier) — also
        // accepts the legacy <dexpi:streamAttribute> name for back-compat
        // with BPMN files saved before the moddle Attribute/StreamAttribute
        // split was unified. Identical fields.
        attributes.push({
          name: child.getAttribute('name') || '',
          value: child.getAttribute('value') || '',
          unit: child.getAttribute('unit') || '',
          scope: child.getAttribute('scope') || 'Design',
          range: child.getAttribute('range') || 'Nominal',
          provenance: child.getAttribute('provenance') || 'Calculated',
          qualifier: child.getAttribute('qualifier') || 'Average'
        });
      } else if (ll === 'materialstatereference') {
        materialStateRef = child.getAttribute('uidRef') || undefined;
      } else if (ll === 'materialtemplatereference' || ll === 'templatereference') {
        // Legacy bare-name reference to MaterialTemplate. The folk name
        // TemplateReference is also accepted for files saved before the
        // canonical-name rename to MaterialTemplateReference.
        templateRef = child.getAttribute('uidRef') || undefined;
      } else {
        // Legacy bare-name CompositionProperty form: <MassFlow><Value/><Unit/>...
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
      sourcePortId: dexpiStream.getAttribute('sourcePortId') || undefined,
      targetPortId: dexpiStream.getAttribute('targetPortId') || undefined,
      templateReference: dexpiStream.getAttribute('templateReference') || templateRef,
      materialStateReference: materialStateRef,
      provenance: (dexpiStream.getAttribute('provenance') ?? undefined) as 'Measured' | 'Calculated' | 'Specified' | 'Estimated' | undefined,
      range: (dexpiStream.getAttribute('range') ?? undefined) as 'Design' | 'Normal' | 'Maximum' | 'Minimum' | undefined,
      attributes
    };
  }

  private extractAttributesFromElement(dexpiElement: Element): StreamAttribute[] {
    const attributes: StreamAttribute[] = [];

    // Iterate through children to find attribute / property carriers.
    for (let i = 0; i < dexpiElement.children.length; i++) {
      const child = dexpiElement.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      const ll = localName.toLowerCase();

      // Carrier-wrapped CompositionProperty form (preferred):
      //   <dexpi:components property="X">
      //     <dexpi:object type="Core/QualifiedValue">
      //       <dexpi:data property="Value">v</dexpi:data>
      //       <dexpi:data property="Unit">u</dexpi:data>
      //       <dexpi:data property="UnitReference">URI</dexpi:data>
      //       <dexpi:references property="QuantityKindReference" objects="URI"/>
      //       ...
      //     </dexpi:object>
      //   </dexpi:components>
      if (ll === 'components') {
        const propertyName = child.getAttribute('property') || '';
        const obj = Array.from(child.children).find((o: Element) =>
          (o.localName || '').toLowerCase() === 'object'
        );
        if (!obj) continue;
        const readData = (name: string): string => {
          for (const d of Array.from(obj.children) as Element[]) {
            if ((d.localName || '').toLowerCase() === 'data' &&
                d.getAttribute('property') === name) {
              return (d.textContent ?? '').trim();
            }
          }
          return '';
        };
        const readReference = (name: string): string | undefined => {
          for (const r of Array.from(obj.children) as Element[]) {
            if ((r.localName || '').toLowerCase() === 'references' &&
                r.getAttribute('property') === name) {
              return r.getAttribute('objects') || r.getAttribute('uidRef') || undefined;
            }
          }
          return undefined;
        };
        const value = readData('Value');
        if (!value) continue;
        // unitUri — bpmn2dexpi extension to QualifiedValue; not declared on
        // Core.xml. Round-tripped as <Data property="UnitReference">URI</Data>
        // inside the QV (same shape MaterialComponent + Stream emit).
        // nameUri — also a Profile-extension carrier; <References
        // property="QuantityKindReference" objects="URI"/> sibling of Data
        // inside the QV. Both flow through the existing strict-mode +
        // Profile-generator extension mechanism.
        const unitUri = readData('UnitReference') || undefined;
        const nameUri = readReference('QuantityKindReference');
        attributes.push({
          name: propertyName,
          value,
          unit: readData('Unit'),
          ...(unitUri !== undefined ? { unitUri } : {}),
          ...(nameUri !== undefined ? { nameUri } : {}),
          scope: readData('Scope') || 'Design',
          range: readData('Range') || 'Nominal',
          provenance: readData('Provenance') || 'Calculated',
          required: child.getAttribute('required') === 'true' || undefined,
        });
        continue;
      }

      // Carrier-wrapped DataProperty form (preferred for plain string /
      // enum attrs without measurement metadata). Mirrors the canonical
      // shape MaterialComponent uses; reading it here brings ProcessStep
      // and Stream onto the same convention. Schema-known structural
      // properties (HierarchyLevel, Identifier, Label) are emitted by
      // dedicated paths elsewhere — exclude them from the attribute view
      // so they don't double-up in the panel.
      if (ll === 'data') {
        const propertyName = child.getAttribute('property') || '';
        if (!propertyName) continue;
        if (propertyName === 'HierarchyLevel' || propertyName === 'Identifier' || propertyName === 'Label') continue;
        const value = (child.textContent ?? '').trim();
        if (!value) continue;
        attributes.push({
          name: propertyName,
          value,
          unit: '',
          scope: 'Design',
          range: 'Nominal',
          provenance: 'Calculated',
          required: undefined,
        });
        continue;
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

    // Pre-compute port → ProcessConnection (Stream / InformationFlow) Object id
    // so port emission can satisfy DEXPI Port.ConnectorReference (lower=1).
    // This must run before buildProcessSteps so the map is populated when each
    // port object is materialised.
    this.portConnectorMap = this.buildPortConnectorMap();

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

    // Add ProcessConnections (Streams + InformationFlows) collection if any
    // streams or flows resolved their endpoints. The in-memory `streams` /
    // `informationFlows` maps may be non-empty even when every entry fails
    // port resolution (e.g. when port-ID conventions in the source BPMN
    // don't match what findPortForConnection expects, as can happen with
    // BPMN saved through some round-trip-tolerant tools). In that case
    // buildStreams() / buildInformationFlows() return [], and emitting a
    // <Components property="ProcessConnections"/> with no Object children
    // would fail XSD validation (Components requires ≥1 Object/ObjectReference).
    if (this.streams.size > 0 || this.informationFlows.size > 0) {
      const allConnections = [
        ...this.buildStreams(),
        ...this.buildInformationFlows(),
      ];
      if (allConnections.length > 0) {
        if (!processModelObject.Components) {
          processModelObject.Components = [];
        }
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

    // Add ListsOfMaterialComponents collection (one per MaterialTemplate
    // that has components). Per Process.xml line 5227, ProcessModel
    // declares ListsOfMaterialComponents as a CompositionProperty whose
    // target is /Process.ListOfMaterialComponents — the wrapper class
    // that aggregates a template's MaterialComponent References. Each
    // wrapper id is `${templateUid}_ListOfComponents` so the
    // MaterialTemplate.ListOfComponents reference resolves locally.
    const listsOfComponents = this.buildListsOfMaterialComponents();
    if (listsOfComponents.length > 0) {
      if (!processModelObject.Components) {
        processModelObject.Components = [];
      }
      const listsComponent = {
        '$': { 'property': 'ListsOfMaterialComponents' },
        'Object': listsOfComponents,
      };
      if (Array.isArray(processModelObject.Components)) {
        processModelObject.Components.push(listsComponent);
      } else {
        processModelObject.Components = [processModelObject.Components, listsComponent];
      }
    }

    // Add Compositions collection (one per MaterialStateType that carries
    // composition data). Per Process.xml, ProcessModel.Compositions is the
    // CompositionProperty container; MaterialStateType.Composition is the
    // ReferenceProperty that points back into this collection.
    const compositionObjects = this.buildCompositions();
    if (compositionObjects.length > 0) {
      if (!processModelObject.Components) {
        processModelObject.Components = [];
      }
      const compositionsComponent = {
        '$': { 'property': 'Compositions' },
        'Object': compositionObjects,
      };
      if (Array.isArray(processModelObject.Components)) {
        processModelObject.Components.push(compositionsComponent);
      } else {
        processModelObject.Components = [processModelObject.Components, compositionsComponent];
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
          // Provenance headers required by DEXPI 2.0 Core/EngineeringModel
          // (lower=1 each). Sourced from package.json (vendor/version) and
          // Date.now() (export timestamp); no hardcoded duplicates.
          'Data': [
            {
              '$': { 'property': 'ExportDateTime' },
              'String': new Date().toISOString(),
            },
            {
              '$': { 'property': 'OriginatingSystemName' },
              'String': pkg.name,
            },
            {
              '$': { 'property': 'OriginatingSystemVendorName' },
              'String': pkg.author,
            },
            {
              '$': { 'property': 'OriginatingSystemVersion' },
              'String': pkg.version,
            },
          ],
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

      // Add ReferenceUri if the user supplied a customUri pointing at an
      // external RDL class. Independent of typing mode — orthogonal to whether
      // the class is in the DEXPI registry.
      if (step.customUri) {
        if (!Array.isArray(dexpiStep.Data)) {
          dexpiStep.Data = [dexpiStep.Data as Record<string, unknown>];
        }
        (dexpiStep.Data as Record<string, unknown>[]).push({
          '$': { 'property': 'ReferenceUri' },
          'String': step.customUri
        });
      }

      // Schema-correct instrumentation handling (DEXPI 2.0 Specification PDF
      // pp.876, 900, 910, 917): InstrumentationActivity and its subclasses
      // (MeasuringProcessVariable, ControllingProcessVariable, ConveyingSignal,
      // CalculatingProcessVariable) inherit from Core/ConceptualObject, not
      // ProcessStep. They do NOT own a Ports CompositionProperty — only
      // ProcessStep does. The connection of an instrumentation activity to
      // the process is expressed via reference properties: ProcessStepReference,
      // ProcessStepDetailReference, ConnectionReference, MeasuredVariableReference,
      // plus the signal-level composition properties InputValue / OutputValue /
      // MeasuredVariable / Setpoint. We translate accordingly: the BPMN-side
      // <dexpi:port> annotations on instrumentation tasks are dropped at emit
      // time and replaced by the schema-correct References derived from the
      // BPMN dataObject topology (extractDataObjectInformationFlows populates
      // step.processStepRef / step.measuredVariable for each instrumentation
      // task). InformationFlows mediated by an instrumentation activity are
      // suppressed elsewhere; the relationship is captured by these References.
      const bareStepType = step.type?.replace(/^Process\./, '');
      const isInstrumentationActivity =
        this.registry.size > 0 &&
        bareStepType !== undefined &&
        this.registry.hasAncestor(bareStepType, 'InstrumentationActivity');
      if (isInstrumentationActivity) {
        // InstrumentationActivity declares Description (lower=1) on its
        // abstract supertype. The BPMN-side `name` is the human-facing
        // label of this activity in the diagram — exactly what
        // Description's spec text describes ("a description"). Use it as
        // the Description value; this is reading an established equivalence
        // (label ↔ description on the same entity), not a name-similarity
        // guess.
        if (step.name) {
          if (!Array.isArray(dexpiStep.Data)) {
            dexpiStep.Data = [dexpiStep.Data as Record<string, unknown>];
          }
          (dexpiStep.Data as Record<string, unknown>[]).push({
            '$': { 'property': 'Description' },
            'String': step.name,
          });
        }
        // Schema asymmetry, intentional and registry-driven (not heuristic):
        // MeasuringProcessVariable declares ProcessStepReference (DEXPI 2.0
        // Spec p.900); the other InstrumentationActivity subclasses
        // (ControllingProcessVariable p.794, ConveyingSignal,
        // CalculatingProcessVariable) do not declare any ProcessStep ref.
        // Emit ProcessStepReference only when the registry confirms the
        // class actually owns it. For the other subclasses the relationship
        // to the controlled / signalled step is captured topologically in
        // the source BPMN (round-trip recovers it) and in the variable label.
        const ownedProperties = this.registry.size > 0 && bareStepType
          ? new Set(this.registry.getProperties(bareStepType).map(p => p.name))
          : new Set<string>();
        // step.processStepRef is a BPMN element id (e.g. "Activity_18ratv8");
        // the corresponding emitted ProcessStep Object uses its sanitized
        // uid as the DEXPI id (e.g. "uid_Activity_18ratv8"). Resolve the BPMN
        // id back to the InternalProcessStep so the reference target matches
        // the actual emitted Object id.
        const refStep = step.processStepRef ? this.processSteps.get(step.processStepRef) : undefined;
        const refStepEmittedId = refStep ? this.sanitizeId(refStep.uid) : undefined;
        if (refStepEmittedId && ownedProperties.has('ProcessStepReference')) {
          if (!dexpiStep.References) dexpiStep.References = [];
          (dexpiStep.References as Record<string, unknown>[]).push({
            '$': {
              'property': 'ProcessStepReference',
              'objects': `#${refStepEmittedId}`,
            },
          });
        }
        // Choose between schema-correct MeasuredVariableReference and a
        // Profile-extension MeasuredVariableLabel based on whether the
        // referenced ProcessStep's class actually declares the measured
        // variable as a CompositionProperty (DEXPI 2.0 Spec p.900: "The
        // measured variable is identified by reference to a parameter in
        // any process step or port"). The decision is registry-driven and
        // walks the full supertype chain — Temperature / Pressure are
        // declared on ProcessStep itself, while Duty lives on
        // ExchangingThermalEnergy, Level on StoringInSilo,
        // RotationalFrequency on Agitating / Agglomerating /
        // SupplyingMechanicalEnergy, etc. (Composition has no
        // parameter-slot home anywhere on ProcessStep, since DEXPI's
        // Composition is itself a complex class.) Variables whose name
        // is not declared on the referenced step's class are surfaced as
        // genuine vocabulary gaps via MeasuredVariableLabel; the Profile
        // generator picks them up. ControllingProcessVariable does not
        // declare MeasuredVariableReference itself (Spec p.794), so we
        // registry-gate this emission too — same pattern as
        // ProcessStepReference above.
        const refStepProps = refStep && this.registry.size > 0
          ? new Set(this.registry.getProperties(refStep.type.replace(/^Process\./, '')).map(p => p.name))
          : new Set<string>();
        const variableIsCanonical = !!step.measuredVariable && refStepProps.has(step.measuredVariable);
        if (
          refStepEmittedId &&
          step.measuredVariable &&
          variableIsCanonical &&
          ownedProperties.has('MeasuredVariableReference')
        ) {
          if (!dexpiStep.References) dexpiStep.References = [];
          (dexpiStep.References as Record<string, unknown>[]).push({
            '$': {
              'property': 'MeasuredVariableReference',
              'objects': `#${refStepEmittedId}_${this.sanitizeId(step.measuredVariable)}`,
            },
          });
        } else if (step.measuredVariable) {
          // Profile-extension fallback: variable has no canonical slot on
          // the referenced step's class. Carry the variable identity as a
          // MeasuredVariableLabel Data property — strict-mode flags it,
          // Profile generator captures it.
          if (!Array.isArray(dexpiStep.Data)) {
            dexpiStep.Data = [dexpiStep.Data as Record<string, unknown>];
          }
          (dexpiStep.Data as Record<string, unknown>[]).push({
            '$': { 'property': 'MeasuredVariableLabel' },
            'String': step.measuredVariable,
          });
        }
      }

      // Ports composition for non-instrumentation steps.
      if (!isInstrumentationActivity && step.ports && step.ports.length > 0) {
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

          // Port has no Label DataProperty per Process.xml — its named
          // properties are Identifier / Description / NominalDirection /
          // SubReference / SuperReference / ConnectorReference. The
          // BPMN-side <dexpi:port label="..."> attribute is kept on the
          // BPMN moddle for UI display, but is not emitted into DEXPI XML
          // as a Label property because no such property exists on Port.
          // The short port name (e.g. "MI1") is captured by Identifier
          // already (assigned above to safePortId).

          // ConnectorReference (lower=1, target /Process.ProcessConnection):
          // points at the Stream / InformationFlow that connects this port.
          // Pre-computed in buildPortConnectorMap; ports that are not part
          // of any connection legitimately omit it — the cardinality
          // validator will surface those as authoring gaps, which is
          // correct rather than hidden.
          const connectionUid = this.portConnectorMap.get(safePortId);
          if (connectionUid) {
            if (!portObject.References) portObject.References = [];
            (portObject.References as Record<string, unknown>[]).push({
              '$': {
                'property': 'ConnectorReference',
                'objects': `#${connectionUid}`,
              },
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
          
          // Add SubReference if this port has child ports.
          // Per Process.xml, Port.SubReference is a CompositionProperty
          // (target /Process.Port). We satisfy the composition contract
          // without duplicating the port object by emitting an
          // ObjectReference shell — DEXPI XSD permits <Components> to hold
          // either inline <Object> or <ObjectReference object="#..."/>
          // (XSD line 769-792). The actual port object continues to live
          // in the inner step's ListOfPorts (single-ownership invariant).
          if (portData?.childPortIds && portData.childPortIds.length > 0) {
            if (!portObject.Components) portObject.Components = [];
            const childObjects = portData.childPortIds.map((childId: string) => ({
              '$': { 'object': `#${this.sanitizeId(childId)}` },
            }));
            (portObject.Components as Record<string, unknown>[]).push({
              '$': { 'property': 'SubReference' },
              'ObjectReference': childObjects,
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
      // Use Object with type="Core/QualifiedValue" per DEXPI 2.0 schema.
      //
      // Kind dispatch (DataProperty vs CompositionProperty) is schema-driven:
      // we look up `attr.name` in the registry's declared properties for
      // this step's class. Schema-data → flat <Data> child; schema-
      // composition → QualifiedValue Object wrapping. For project-extension
      // attribute names the registry doesn't declare, we fall back to a
      // presence heuristic (any unit / URI / scope-range-provenance metadata
      // implies the author intended a measurement carrier). The heuristic
      // only fires on unknown names; schema-declared dispatch is primary.
      const declaredKindByName = new Map<string, 'data' | 'composition' | 'reference'>();
      if (this.registry.isValidClass(step.type)) {
        for (const p of this.registry.getProperties(step.type)) {
          declaredKindByName.set(p.name, p.kind);
        }
      }
      const resolveAttrKind = (attr: { name: string; unit?: string; unitUri?: string; nameUri?: string; scope?: string; range?: string; provenance?: string }): 'data' | 'composition' => {
        const declared = declaredKindByName.get(attr.name);
        if (declared === 'composition') return 'composition';
        if (declared === 'data' || declared === 'reference') return 'data';
        return (attr.unit || attr.unitUri || attr.nameUri ||
                attr.scope || attr.range || attr.provenance) ? 'composition' : 'data';
      };

      if (step.attributes && step.attributes.length > 0) {
        step.attributes.forEach((attr) => {
          if (!attr.name || !attr.value) return;

          if (resolveAttrKind(attr) === 'composition') {
            if (!dexpiStep.Object) {
              dexpiStep.Object = [];
            }

            // DisplayText is required (lower=1) on QualifiedValue. We
            // derive it deterministically from the inputs we already have:
            // "<value> <unit>" trimmed when a unit is present, else just
            // "<value>". This is the obvious canonical rendering of a
            // physical quantity for human consumption — no name guessing,
            // no fuzzy formatting heuristic. Schema-driven dispatch above
            // can route a unit-less measurement attribute into this branch
            // (e.g. a CompositionProperty whose unit hasn't been authored
            // yet), so the unit-related children are conditional.
            const displayText = attr.unit ? `${attr.value} ${attr.unit}`.trim() : attr.value;
            const innerValueData: Record<string, unknown>[] = [
              {
                '$': { 'property': 'Value' },
                'Double': !isNaN(parseFloat(attr.value)) ? parseFloat(attr.value) : undefined,
                'String': isNaN(parseFloat(attr.value)) ? attr.value : undefined,
              },
            ];
            if (attr.unit) {
              innerValueData.push({
                '$': { 'property': 'Unit' },
                'String': attr.unit,
              });
            }
            const qualifiedValueObject: Record<string, unknown> = {
              '$': {
                'property': attr.name,
                'type': 'Core/QualifiedValue'
              },
              'Data': [
                {
                  '$': { 'property': 'Value' },
                  'PhysicalQuantity': { 'Data': innerValueData },
                },
                {
                  '$': { 'property': 'DisplayText' },
                  'String': displayText,
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

      // Materialise QualifiedValue parameter slots for variables that
      // downstream InstrumentationActivities reference via
      // MeasuredVariableReference (DEXPI 2.0 Spec p.900: "The measured
      // variable is identified by reference to a parameter in any process
      // step or port"). One Components carrier per name; the wrapped
      // QualifiedValue carries no value (the actual measurement lives on
      // the InstrumentationActivity's OutputValue / MeasuredVariable
      // composition slots), only an id stable enough for the reference to
      // resolve. The id convention `<sanitized_step_uid>_<varName>` is
      // matched by the MeasuredVariableReference emit above.
      // Canonical names (Temperature, Pressure, AmbientTemperature,
      // AmbientPressure) align with ProcessStep's declared composition
      // properties — strict-mode reports nothing. Non-canonical names
      // (Level, MassFlow, RotationalFrequency, Composition, Duty, ...)
      // are flagged as Profile-extension findings the Profile generator
      // captures — exactly the vocabulary-gap mechanism the spec's open
      // type binding `<QualifiedValue with Type → Undefined | PhysicalQuantity>`
      // anticipates. We emit only on non-instrumentation steps; emitting
      // a measurable parameter on an InstrumentationActivity would itself
      // be a schema violation (no Components composition declared).
      if (!isInstrumentationActivity && step.measuredParameters && step.measuredParameters.size > 0) {
        // Materialise QualifiedValue parameter slots only for variables
        // whose name is a declared CompositionProperty on this step's
        // class (registry-driven; walks the supertype chain). Non-canonical
        // names are not fabricated as Components on the ProcessStep — the
        // upstream InstrumentationActivity carries them as a
        // MeasuredVariableLabel Profile-extension Data property instead.
        // This keeps the ProcessStep's emitted shape clean of Profile-
        // extension Components and confines vocabulary gaps to the
        // instrumentation side.
        const ownProps = this.registry.size > 0 && bareStepType
          ? new Set(this.registry.getProperties(bareStepType).map(p => p.name))
          : new Set<string>();
        const canonicalVars = [...step.measuredParameters].filter(v => ownProps.has(v));
        if (canonicalVars.length > 0) {
          if (!dexpiStep.Components) {
            dexpiStep.Components = [];
          } else if (!Array.isArray(dexpiStep.Components)) {
            dexpiStep.Components = [dexpiStep.Components as Record<string, unknown>];
          }
          const stepEmittedId = this.sanitizeId(step.uid);
          for (const varName of canonicalVars) {
            const safeVar = this.sanitizeId(varName);
            // QualifiedValue declares Value (lower=1) and DisplayText
            // (lower=1) — both UnionDataType (Builtin/Undefined | …). The
            // DEXPI XSD requires <Data> to carry a typed child element;
            // for placeholder slots that have no actual measurement we
            // emit <Undefined/>. The actual measurement lives on the
            // InstrumentationActivity that references this slot via
            // MeasuredVariableReference.
            (dexpiStep.Components as Record<string, unknown>[]).push({
              '$': { 'property': varName },
              'Object': {
                '$': {
                  'id': `${stepEmittedId}_${safeVar}`,
                  'type': 'Core/QualifiedValue',
                },
                'Data': [
                  { '$': { 'property': 'Value' }, 'Undefined': {} },
                  { '$': { 'property': 'DisplayText' }, 'Undefined': {} },
                ],
              },
            });
          }
        }
      }

      return dexpiStep;
  }

  /**
   * Resolve every Stream / InformationFlow to its source-port and target-port,
   * then build a lookup `sanitizedPortId → sanitizedConnectionUid`. The port
   * emission consults this to satisfy DEXPI Port.ConnectorReference (lower=1)
   * by pointing each port at the ProcessConnection that uses it.
   *
   * Pure registry/topology lookup — no name-similarity, no fuzzy matching:
   * we re-use findPortForConnection (the same resolver buildStreams uses) so
   * the references are guaranteed consistent across the two emission paths.
   *
   * Streams whose endpoints don't resolve (gateway-only chains, dangling
   * BPMN refs) contribute no entries. Ports without an entry will not emit
   * a ConnectorReference and the cardinality validator will (correctly)
   * surface them — that's the signal a port has no flow attached, which is
   * a real authoring gap rather than something the transformer should hide.
   */
  private buildPortConnectorMap(): Map<string, string> {
    const map = new Map<string, string>();

    const record = (portId: string | null | undefined, connectionUid: string): void => {
      if (!portId) return;
      // Skip streams that the buildStreams loop will itself silently skip
      // (sourceRef or targetRef is a gateway / unknown — same condition as
      // the `if (!processSteps.has(...))` guard there). We mirror the guard
      // to ensure the map only references connections that actually emit.
      const safePort = this.sanitizeId(portId);
      if (!map.has(safePort)) map.set(safePort, this.sanitizeId(connectionUid));
    };

    // Prefer sourcePortId/targetPortId (the new self-contained-id format) over
    // the legacy suffix sourcePortRef/targetPortRef. findPortForConnection's
    // existing two-step lookup (try {elementRef}_{portRef}, then portRef
    // directly) handles either form correctly: with the full id, the prefixed
    // construction misses but the direct lookup hits; with the suffix, the
    // prefixed construction hits when BPMN element ids are stable.
    this.streams.forEach((stream) => {
      if (!this.processSteps.has(stream.sourceRef) || !this.processSteps.has(stream.targetRef)) {
        return; // matches buildStreams' skip behaviour
      }
      const sourcePort = this.findPortForConnection(stream.sourceRef, stream.sourcePortId ?? stream.sourcePortRef, 'Outlet');
      const targetPort = this.findPortForConnection(stream.targetRef, stream.targetPortId ?? stream.targetPortRef, 'Inlet');
      if (!sourcePort || !targetPort) return;
      record(sourcePort, stream.uid);
      record(targetPort, stream.uid);
    });

    this.informationFlows.forEach((flow) => {
      if (!this.processSteps.has(flow.sourceRef) || !this.processSteps.has(flow.targetRef)) return;
      const sourcePort = this.findPortForConnection(
        flow.sourceRef, flow.sourcePortId ?? flow.sourcePortRef, 'Outlet', 'InformationPort', flow.name
      );
      const targetPort = this.findPortForConnection(
        flow.targetRef, flow.targetPortId ?? flow.targetPortRef, 'Inlet', 'InformationPort', flow.name
      );
      if (!sourcePort || !targetPort) return;
      record(sourcePort, flow.uid);
      record(targetPort, flow.uid);
    });

    return map;
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

      const sourcePort = this.findPortForConnection(stream.sourceRef, stream.sourcePortId ?? stream.sourcePortRef, 'Outlet');
      const targetPort = this.findPortForConnection(stream.targetRef, stream.targetPortId ?? stream.targetPortRef, 'Inlet');

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
              },
              // DisplayText (lower=1) derived deterministically from inputs.
              {
                '$': { 'property': 'DisplayText' },
                'String': `${attr.value} ${attr.unit}`.trim(),
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

    const isInstr = (stepId: string): boolean => {
      const s = this.processSteps.get(stepId);
      if (!s || this.registry.size === 0) return false;
      return this.registry.hasAncestor(s.type.replace(/^Process\./, ''), 'InstrumentationActivity');
    };

    this.informationFlows.forEach((flow) => {
      // Schema-correct: an InformationFlow's Source/Target are InformationPorts,
      // which only exist on ProcessSteps and ProcessConnections. If either
      // endpoint is an InstrumentationActivity descendant, the relationship
      // belongs on the InstrumentationActivity itself via ProcessStepReference
      // / MeasuredVariableReference (emitted in buildProcessStepObject) and
      // does NOT round-trip through an InformationFlow object. Skip emission.
      if (isInstr(flow.sourceRef) || isInstr(flow.targetRef)) {
        return;
      }

      // Match ports by the variable identity (DataObject name carried in flow.name).
      // Element with port labelled "Temperature" wins for a Temperature flow.
      const sourcePort = this.findPortForConnection(
        flow.sourceRef, flow.sourcePortId ?? flow.sourcePortRef, 'Outlet', 'InformationPort', flow.name
      );
      const targetPort = this.findPortForConnection(
        flow.targetRef, flow.targetPortId ?? flow.targetPortRef, 'Inlet', 'InformationPort', flow.name
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

      // The DataObject name (which was historically attached here as a
      // Label DataProperty on an InformationVariant child) is already
      // surfaced as the InformationFlow's own Label above (line 1737).
      // InformationVariant per Process.xml carries only typed values
      // (BooleanValue / DoubleValue / IntegerValue / VariantType /
      // VectorSize) — it has no Label DataProperty, so emitting one here
      // produced a strict-mode property-name fidelity violation. We drop
      // the embedded InformationVariant entirely; the variable name
      // continues to reach DEXPI consumers through the flow's Label.
      // Mapping the variable identity onto MeasuredVariableReference (the
      // schema-correct location on MeasuringProcessVariable) is a
      // separate semantic-fidelity concern; flagged in PR description.

      flowElements.push(dexpiFlow);
    });

    return flowElements;
  }

  /**
   * Materialise the wrapper Objects that DEXPI's MaterialTemplate.ListOfComponents
   * targets. One wrapper per template that has components; each wrapper holds
   * the per-component References. Per Process.xml lines 2219-2222
   * (ListOfMaterialComponents class) + 5227 (ProcessModel container). Wrapper
   * ids are deterministic — `${templateUid}_ListOfComponents` — so the
   * MaterialTemplate's ListOfComponents reference resolves locally.
   */
  private buildListsOfMaterialComponents(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    this.materialTemplates.forEach((template) => {
      if (!template.componentRefs || template.componentRefs.length === 0) return;
      const wrapperId = this.sanitizeId(`${template.uid}_ListOfComponents`);
      const refs = template.componentRefs.map((ref: string) => `#${this.sanitizeId(ref)}`).join(' ');
      out.push({
        '$': {
          'id': wrapperId,
          'type': 'Process/Process.ListOfMaterialComponents',
        },
        'References': [
          {
            '$': {
              'property': 'Component',
              'objects': refs,
            },
          },
        ],
      });
    });
    return out;
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

      // ListOfComponents is a single-target ReferenceProperty whose declared
      // target class is /Process.ListOfMaterialComponents (a wrapper class
      // that holds the per-component References, not the components
      // themselves). Per Process.xml lines 2219-2222 + 2439-2440. Earlier
      // versions of this transformer pointed ListOfComponents directly at
      // individual MaterialComponent objects, which Tier 4 (reference
      // target-class) correctly flagged as a target-class violation. We
      // now emit a deterministic wrapper id per template; the wrapper
      // Object itself is materialised later under
      // ProcessModel.ListsOfMaterialComponents (CompositionProperty).
      if (template.componentRefs && template.componentRefs.length > 0) {
        if (!dexpiTemplate.References) {
          dexpiTemplate.References = [];
        }
        const wrapperId = this.sanitizeId(`${template.uid}_ListOfComponents`);
        (dexpiTemplate.References as Record<string, unknown>[]).push({
          '$': {
            'property': 'ListOfComponents',
            'objects': `#${wrapperId}`,
          }
        });
      }

      // Add PhaseLabel entries — one <Data property="PhaseLabel"> per phase.
      // PhaseLabel is a multi-valued DataProperty on MaterialTemplate per
      // Process.xml line 2448; the legacy single <Data property="ListOfPhases">
      // joined-string emit deviated from the schema and is replaced here.
      if (template.phases && template.phases.length > 0) {
        for (const phase of template.phases) {
          (dexpiTemplate.Data as Record<string, unknown>[]).push({
            '$': { 'property': 'PhaseLabel' },
            'String': phase
          });
        }
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

      // Round-trip extra authored properties (project-extension thermo data,
      // Antoine equation parameters, IsEffectivelyNoncondensable flag, etc.)
      // captured by the reader. Without this, anything beyond the canonical
      // Identifier/Label/Description/ChEBI/IUPAC fields would be silently
      // dropped between BPMN input and DEXPI output.
      if (component.properties && component.properties.length > 0) {
        const compositionEntries: Record<string, unknown>[] = [];
        for (const prop of component.properties) {
          if (prop.kind === 'data') {
            (dexpiComponent.Data as Record<string, unknown>[]).push({
              '$': { 'property': prop.name },
              'String': prop.value,
            });
          } else {
            // 'composition' — emit canonical Components/Object/QualifiedValue carrier.
            // DisplayText is required (lower=1) on Core/QualifiedValue per
            // Core.xml; derive it deterministically as "<value> <unit>" so
            // the cardinality validator stays clean. Same convention as the
            // step/stream attribute emit path uses.
            const displayText = prop.unit ? `${prop.value} ${prop.unit}` : prop.value;
            const qvData: Record<string, unknown>[] = [
              { '$': { 'property': 'Value' }, 'String': prop.value },
              { '$': { 'property': 'DisplayText' }, 'String': displayText },
            ];
            if (prop.unit) qvData.push({ '$': { 'property': 'Unit' }, 'String': prop.unit });
            if (prop.unitReference) qvData.push({ '$': { 'property': 'UnitReference' }, 'String': prop.unitReference });
            compositionEntries.push({
              '$': { 'property': prop.name },
              'Object': {
                '$': { 'type': 'Core/QualifiedValue' },
                'Data': qvData,
              },
            });
          }
        }
        if (compositionEntries.length > 0) {
          dexpiComponent.Components = compositionEntries;
        }
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

      // Description (lower=1): fall back to label, then identifier — both
      // are deterministic alternative renderings of "what is this state",
      // not a name-similarity guess. Picking the first non-empty avoids
      // emitting an empty/Undefined Builtin/String which is also invalid
      // (the type isn't a UnionDataType admitting Undefined here).
      const descriptionValue = state.description || state.label || state.identifier;
      if (descriptionValue) {
        (dexpiState.Data as Record<string, unknown>[]).push({
          '$': {
            'property': 'Description'
          },
          'String': descriptionValue
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

      // State-level scalar MoleFlow on MaterialStateType. This is
      // Profile-extension territory: DEXPI 2.0's MaterialStateType
      // declares scalar MassFlow / VolumeFlow but no scalar MoleFlow —
      // a real vocabulary gap that the Profile mechanism fills. The
      // strict-mode validator surfaces this as a fidelity finding; the
      // Profile generator captures it as MaterialStateType.MoleFlow
      // alongside the genuine CustomMaterialComponent extensions.
      // Composition.MoleFlow is a different concept (multi-valued
      // per-component vector); not used by TEP at the state level.
      if (stateType.flow?.moleFlow) {
        if (!dexpiStateType.Components) {
          dexpiStateType.Components = [];
        }
        const mfValue = stateType.flow.moleFlow.value;
        const mfUnit = stateType.flow.moleFlow.unit;
        (dexpiStateType.Components as Record<string, unknown>[]).push({
          '$': { 'property': 'MoleFlow' },
          'Object': [{
            '$': { 'type': 'Core/QualifiedValue' },
            'Data': [
              { '$': { 'property': 'Value' }, 'Double': parseFloat(mfValue) || 0 },
              { '$': { 'property': 'Unit' }, 'String': mfUnit },
              { '$': { 'property': 'DisplayText' }, 'String': `${mfValue} ${mfUnit}`.trim() },
            ],
          }],
        });
      }

      // MaterialStateType.Composition is a ReferenceProperty per Process.xml
      // (target: /Process.Composition). Emit the reference here; the
      // referenced Composition Object is materialised under
      // ProcessModel.Compositions (CompositionProperty container) with a
      // deterministic id derived from the state type's uid.
      if (stateType.flow?.composition) {
        if (!dexpiStateType.References) {
          dexpiStateType.References = [];
        }
        const compositionId = this.sanitizeId(`${stateType.uid}_Composition`);
        (dexpiStateType.References as Record<string, unknown>[]).push({
          '$': {
            'property': 'Composition',
            'objects': `#${compositionId}`,
          },
        });
      }

      stateTypes.push(dexpiStateType);
    });

    return stateTypes;
  }

  /**
   * Materialise top-level Composition objects (DEXPI 2.0 ProcessModel.Compositions).
   * One Composition per MaterialStateType that carries composition data; the
   * id is derived deterministically from the state type's uid so the
   * MaterialStateType's `<References property="Composition" objects="#...">`
   * resolves locally.
   *
   * Per Process.xml, Composition declares Display + per-component fractions
   * vectors (MoleFractiona [sic] / MassFractions / VolumeFractions). Display
   * is the only piece carried through the InternalMaterialStateType today;
   * the per-component vectors are not yet exercised by the canonical TEP
   * fixture.
   */
  private buildCompositions(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    this.materialStateTypes.forEach((stateType) => {
      if (!stateType.flow?.composition) return;
      const compositionId = this.sanitizeId(`${stateType.uid}_Composition`);
      const compositionData: Record<string, unknown>[] = [];
      if (stateType.flow.composition.display) {
        compositionData.push({
          '$': { 'property': 'Display' },
          'String': stateType.flow.composition.display,
        });
      }
      const compositionObj: Record<string, unknown> = {
        '$': {
          'id': compositionId,
          'type': 'Process/Process.Composition',
        },
      };
      if (compositionData.length > 0) {
        compositionObj.Data = compositionData;
      }
      out.push(compositionObj);
    });
    return out;
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
      // Strict match: portId or port name must equal the given reference.
      // (No more substring/suffix fallback — those were brittle and could
      // bind silently to a port whose id happened to end with the same suffix.)
      const matchingPort = element.ports.find((p: DexpiPort) =>
        p.name === portRef || p.portId === portRef
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

  /**
   * Walk up the DOM from a startEvent/endEvent to find the nearest
   * enclosing bpmn:subProcess, if any. Returns its id or null if the event
   * is at the top level of the process. Used by extractSource/extractSink
   * to nest source/sink events in the correct subprocess plane on import.
   */
  private findEnclosingSubProcessId(event: Element): string | null {
    let cur: Element | null = event.parentNode as Element | null;
    while (cur) {
      const local = cur.localName || cur.tagName?.split(':').pop() || '';
      if (local.toLowerCase() === 'subprocess') {
        return cur.getAttribute('id') || null;
      }
      cur = cur.parentNode as Element | null;
    }
    return null;
  }
}

export const transformer = new BpmnToDexpiTransformer();
