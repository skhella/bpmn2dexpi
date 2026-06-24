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
  /** Step-level qualified attributes (Components/Data on the Object). */
  attributes?: ParsedStreamAttribute[];
  referenceUri?: string;
  parentId?: string;
  children: DexpiStep[];
  /**
   * For InstrumentationActivity descendants only — populated by parseStep
   * from the schema-correct DEXPI 2.0 emission shape (Spec p.876, p.900).
   * processStepRef holds the DEXPI Object id of the referenced ProcessStep
   * (read from <References property="ProcessStepReference"/>).
   * measuredVariable holds the variable identity, resolved either from
   * MeasuredVariableReference (canonical: walk to QualifiedValue's owning
   * Components carrier and read its property name) or from the
   * MeasuredVariableLabel Profile-extension Data property (fallback for
   * variables with no canonical ProcessStep parameter slot).
   */
  processStepRef?: string;
  measuredVariable?: string;
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
  /** Parsed stream-level attributes (Components→QualifiedValue + simple Data). */
  attributes?: ParsedStreamAttribute[];
  /** Optional reference to a MaterialState (DEXPI MaterialStateReference). */
  materialStateRef?: string;
  /** Optional reference to a MaterialTemplate. */
  materialTemplateRef?: string;
}

interface ParsedStreamAttribute {
  name: string;
  value: string;
  unit?: string;
  unitUri?: string;
  provenance?: string;
  range?: string;
  nameUri?: string;
}

interface DexpiMaterialTemplate {
  uid: string;
  identifier: string;
  label: string;
  description?: string;
  numberOfComponents?: string;
  numberOfPhases?: string;
  /** UIDs (without leading #) of referenced MaterialComponents. */
  componentRefs: string[];
  /** Phase identifier strings. */
  phases: string[];
}

interface DexpiMaterialComponent {
  uid: string;
  identifier: string;
  label: string;
  description?: string;
  chebiId?: string;
  iupacId?: string;
  /** xsi:type from the original BPMN, or a guess based on DEXPI subclass. */
  xsiType: string;
}

interface DexpiMaterialStateType {
  uid: string;
  identifier: string;
  label: string;
  description?: string;
  templateRef?: string;
  moleFlow?: { value: string; unit: string };
  composition?: {
    basis?: string;
    display?: string;
    fractions: { value: string; unit?: string; componentRef?: string }[];
  };
}

interface DexpiMaterialState {
  uid: string;
  identifier: string;
  label: string;
  description?: string;
  templateRef?: string;
  /** UID of the linked MaterialStateType (Object referenced by the State property). */
  stateTypeRef?: string;
}

interface ParsedDexpi {
  steps: DexpiStep[];
  connections: DexpiConnection[];
  materialTemplates: DexpiMaterialTemplate[];
  materialComponents: DexpiMaterialComponent[];
  materialStates: DexpiMaterialState[];
  materialStateTypes: DexpiMaterialStateType[];
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

    // Build a global map of QualifiedValue Object id → owning Components
    // carrier's property name. This lets us resolve a
    // MeasuredVariableReference target id (e.g. "uid_Activity_X_Temperature")
    // to the variable identity ("Temperature") without parsing the id
    // string itself, which would be fragile because step uids can contain
    // arbitrary underscore-separated segments. The map is built by
    // walking every <Components property="X"><Object id="..."/></Components>
    // anywhere in the document.
    const qualifiedValueIdToProperty = new Map<string, string>();
    Array.from(doc.getElementsByTagName('Components')).forEach(comp => {
      const property = comp.getAttribute('property');
      if (!property) return;
      Array.from(comp.children)
        .filter(c => c.tagName === 'Object')
        .forEach(child => {
          const cid = child.getAttribute('id');
          if (cid) qualifiedValueIdToProperty.set(cid, property);
        });
    });

    // Resolve __refid: markers placed by parseStep into the actual property
    // names. Done after parsing so all Components carriers have been seen.
    const resolveMeasuredVariable = (step: DexpiStep): void => {
      if (step.measuredVariable && step.measuredVariable.startsWith('__refid:')) {
        const refId = step.measuredVariable.slice('__refid:'.length);
        const propName = qualifiedValueIdToProperty.get(refId);
        step.measuredVariable = propName || undefined;
      }
      step.children.forEach(resolveMeasuredVariable);
    };
    steps.forEach(resolveMeasuredVariable);

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

    // Parse MaterialTemplates (full content — components, phases, etc.)
    const materialTemplates: DexpiMaterialTemplate[] = [];
    const tmplContainer = this.findComponents(processModel, 'MaterialTemplates');
    if (tmplContainer) {
      Array.from(tmplContainer.children)
        .filter(el => el.tagName === 'Object')
        .forEach(obj => materialTemplates.push(this.parseMaterialTemplate(obj)));
    }

    // Parse MaterialComponents (PureMaterialComponent / MaterialComponent / etc.)
    const materialComponents: DexpiMaterialComponent[] = [];
    const compContainer = this.findComponents(processModel, 'MaterialComponents');
    if (compContainer) {
      Array.from(compContainer.children)
        .filter(el => el.tagName === 'Object')
        .forEach(obj => materialComponents.push(this.parseMaterialComponent(obj)));
    }

    // Parse MaterialStates (linked to a MaterialStateType via the State reference).
    const materialStates: DexpiMaterialState[] = [];
    const stateContainer = this.findComponents(processModel, 'MaterialStates');
    if (stateContainer) {
      Array.from(stateContainer.children)
        .filter(el => el.tagName === 'Object')
        .forEach(obj => materialStates.push(this.parseMaterialState(obj)));
    }

    // Parse MaterialStateTypes (the actual flow data — MoleFlow, Composition, etc.)
    const materialStateTypes: DexpiMaterialStateType[] = [];
    const stateTypeContainer = this.findComponents(processModel, 'MaterialStateTypes');
    if (stateTypeContainer) {
      Array.from(stateTypeContainer.children)
        .filter(el => el.tagName === 'Object')
        .forEach(obj => materialStateTypes.push(this.parseMaterialStateType(obj)));
    }

    return {
      steps,
      connections,
      materialTemplates,
      materialComponents,
      materialStates,
      materialStateTypes,
    };
  }

  /** Parse a Process.MaterialTemplate Object. */
  private parseMaterialTemplate(obj: Element): DexpiMaterialTemplate {
    const uid = obj.getAttribute('id') || this.uid();
    const identifier = this.getDataString(obj, 'Identifier') || uid;
    const label = this.getDataString(obj, 'Label') || identifier;
    const description = this.getDataString(obj, 'Description') || undefined;
    const numberOfComponents = this.getDataInteger(obj, 'NumberOfMaterialComponents');
    const numberOfPhases = this.getDataInteger(obj, 'NumberOfPhases');

    // Component refs come either as a References property="ListOfMaterialComponents"
    // (canonical XSD form) OR as a Data property="ListOfMaterialComponents" with a
    // space-separated string (some legacy exports). Accept both.
    const componentRefs = this.getReferenceIds(obj, 'ListOfMaterialComponents');
    const phasesString = this.getDataString(obj, 'ListOfPhases');
    const phases = phasesString
      ? phasesString.split(/[,\s]+/).map(p => p.trim()).filter(Boolean)
      : [];

    return {
      uid, identifier, label, description,
      numberOfComponents, numberOfPhases,
      componentRefs, phases,
    };
  }

  /** Parse a Process.PureMaterialComponent or Process.MaterialComponent Object. */
  private parseMaterialComponent(obj: Element): DexpiMaterialComponent {
    const uid = obj.getAttribute('id') || this.uid();
    const fullType = obj.getAttribute('type') || '';
    // 'Process/Process.PureMaterialComponent' → 'PureMaterialComponent'.
    // Fall back to CustomMaterialComponent if the type is missing/unrecognised
    // — that's the BPMN convention for components without a DEXPI subclass.
    const xsiType = fullType.replace('Process/Process.', '') || 'CustomMaterialComponent';
    const identifier = this.getDataString(obj, 'Identifier') || uid;
    const label = this.getDataString(obj, 'Label') || identifier;
    const description = this.getDataString(obj, 'Description') || undefined;
    const chebiId = this.getDataString(obj, 'ChEBIIdentifier') || this.getDataString(obj, 'ChEBI_identifier') || undefined;
    const iupacId = this.getDataString(obj, 'IUPACIdentifier') || this.getDataString(obj, 'IUPAC_identifier') || undefined;

    return { uid, identifier, label, description, chebiId, iupacId, xsiType };
  }

  /** Parse a Process.MaterialState Object. */
  private parseMaterialState(obj: Element): DexpiMaterialState {
    const uid = obj.getAttribute('id') || this.uid();
    const identifier = this.getDataString(obj, 'Identifier') || uid;
    const label = this.getDataString(obj, 'Label') || identifier;
    const description = this.getDataString(obj, 'Description') || undefined;
    // The 'State' reference points to the MaterialStateType holding the flow data.
    const stateRefs = this.getReferenceIds(obj, 'State');
    const stateTypeRef = stateRefs[0];
    // Some exporters also place a TemplateReference directly on the state.
    const tmplRefs = this.getReferenceIds(obj, 'MaterialTemplateReference');
    const templateRef = tmplRefs[0];

    return { uid, identifier, label, description, templateRef, stateTypeRef };
  }

  /** Parse a Process.MaterialStateType Object — flow data hangs off here. */
  private parseMaterialStateType(obj: Element): DexpiMaterialStateType {
    const uid = obj.getAttribute('id') || this.uid();
    const identifier = this.getDataString(obj, 'Identifier') || uid;
    const label = this.getDataString(obj, 'Label') || identifier;
    const description = this.getDataString(obj, 'Description') || undefined;
    const tmplRefs = this.getReferenceIds(obj, 'MaterialTemplateReference');
    const templateRef = tmplRefs[0];

    // MoleFlow lives in <Components property="MoleFlow"><Object type="Core/QualifiedValue"/></Components>
    const moleFlowComp = Array.from(obj.children).find(c =>
      c.tagName === 'Components' && c.getAttribute('property') === 'MoleFlow'
    );
    const moleFlowObj = moleFlowComp ? Array.from(moleFlowComp.children).find(c => c.tagName === 'Object') : null;
    const moleFlow = moleFlowObj ? {
      value: this.getDataString(moleFlowObj as Element, 'Value'),
      unit: this.getDataString(moleFlowObj as Element, 'Unit'),
    } : undefined;

    // Composition lives in <Components property="Composition"><Object type="Process/Process.Composition"/></Components>
    const compComp = Array.from(obj.children).find(c =>
      c.tagName === 'Components' && c.getAttribute('property') === 'Composition'
    );
    const compObj = compComp ? Array.from(compComp.children).find(c => c.tagName === 'Object') : null;
    let composition: DexpiMaterialStateType['composition'];
    if (compObj) {
      const basis = this.getDataString(compObj as Element, 'Basis') || undefined;
      const display = this.getDataString(compObj as Element, 'Display') || undefined;
      // Fractions are <Components property="Fractions"><Object type="Core/QualifiedValue"/>...
      // OR (legacy) repeated Data property="Fraction" entries.
      const fractionsComp = Array.from((compObj as Element).children).find(c =>
        c.tagName === 'Components' && c.getAttribute('property') === 'Fractions'
      );
      const fractions: { value: string; unit?: string; componentRef?: string }[] = [];
      if (fractionsComp) {
        Array.from(fractionsComp.children)
          .filter(c => c.tagName === 'Object')
          .forEach(f => {
            const value = this.getDataString(f, 'Value');
            const unit = this.getDataString(f, 'Unit') || undefined;
            const refs = this.getReferenceIds(f, 'ComponentReference');
            fractions.push({ value, unit, componentRef: refs[0] });
          });
      }
      composition = { basis, display, fractions };
    }

    return { uid, identifier, label, description, templateRef, moleFlow, composition };
  }

  /** Like getDataString but returns the Integer node text. */
  private getDataInteger(parent: Element, property: string): string | undefined {
    const node = Array.from(parent.children).find(c =>
      c.tagName === 'Data' && c.getAttribute('property') === property
    );
    if (!node) return undefined;
    const intNode = Array.from(node.children).find(c => c.tagName === 'Integer');
    return intNode?.textContent || undefined;
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

    // Step-level attributes — same shape as stream attributes (Components +
    // Data, structural ones excluded). Lets DEXPI step properties survive
    // the round-trip into the BPMN extension and into the properties panel.
    const attributes = this.parseAttributesOn(
      obj,
      new Set([
        'Identifier', 'Label', 'Description', 'Ports', 'ProcessSteps',
        'SubProcessSteps', 'NominalDirection',
        // Schema-correct instrumentation properties (DEXPI 2.0 Spec p.900):
        // these are structural references that get synthesized into the
        // BPMN dataObject pattern downstream — not user-visible attributes.
        'ProcessStepReference', 'ProcessStepDetailReference',
        'ConnectionReference', 'MeasuredVariableReference',
        // Profile-extension carrier for the variable identity when no
        // canonical parameter slot exists.
        'MeasuredVariableLabel',
      ])
    );

    // Schema-correct instrumentation references (post-71c1ea0/a32d514 export
    // shape). The export drops Ports composition for InstrumentationActivity
    // descendants and emits ProcessStepReference + MeasuredVariableReference /
    // MeasuredVariableLabel instead. We capture them here for the synthesis
    // pass that recreates the BPMN dataObject pattern in the imported BPMN.
    const processStepRef = this.getReferenceIds(obj, 'ProcessStepReference')[0];
    const measuredVariableRefId = this.getReferenceIds(obj, 'MeasuredVariableReference')[0];
    // Variable identity: prefer the canonical reference (resolves later in
    // parseDexpi to the property name carried on the parameter's
    // <Components property="X"> wrapper), then fall back to the
    // Profile-extension MeasuredVariableLabel Data property.
    const measuredVariableLabel = this.getDataString(obj, 'MeasuredVariableLabel');
    // measuredVariable from the canonical path is resolved post-parse via
    // the qualifiedValueId→property map; for now we record the raw ref id
    // in a tagged form, and let parseDexpi swap it for the property name.
    let measuredVariable: string | undefined;
    if (measuredVariableRefId) {
      measuredVariable = `__refid:${measuredVariableRefId}`;
    } else if (measuredVariableLabel) {
      measuredVariable = measuredVariableLabel;
    }

    return {
      id, dexpiType, identifier, label, ports, parentId, children,
      attributes: attributes.length > 0 ? attributes : undefined,
      processStepRef: processStepRef || undefined,
      measuredVariable,
    };
  }

  /**
   * Pull DEXPI attribute-style children off any Object: physical-quantity
   * attributes via <Components property="X"><Object type="Core/QualifiedValue"/>,
   * and simple string attrs via <Data property="X"><String>...</String></Data>.
   * Properties listed in `skip` (structural ones) are ignored.
   */
  private parseAttributesOn(obj: Element, skip: Set<string>): ParsedStreamAttribute[] {
    const out: ParsedStreamAttribute[] = [];

    Array.from(obj.children)
      .filter(c => c.tagName === 'Components')
      .forEach(comp => {
        const property = comp.getAttribute('property') || '';
        if (!property || skip.has(property)) return;
        const inner = Array.from(comp.children).find(c => c.tagName === 'Object');
        if (!inner || inner.getAttribute('type') !== 'Core/QualifiedValue') return;
        const value = this.getDataString(inner, 'Value');
        const unit = this.getDataString(inner, 'Unit') || undefined;
        const unitUri = this.getDataString(inner, 'UnitReference') || undefined;
        const provenance = this.getDataString(inner, 'Provenance') || undefined;
        const range = this.getDataString(inner, 'Range') || undefined;
        const nameUri = this.getReferenceIds(inner, 'QuantityKindReference')[0];
        out.push({ name: property, value, unit, unitUri, provenance, range, nameUri });
      });

    Array.from(obj.children)
      .filter(c => c.tagName === 'Data')
      .forEach(data => {
        const property = data.getAttribute('property') || '';
        if (!property || skip.has(property)) return;
        const stringNode = Array.from(data.children).find(c => c.tagName === 'String');
        if (!stringNode) return;
        const value = stringNode.textContent?.trim() || '';
        const nameUri = data.getAttribute('nameUri') || undefined;
        out.push({ name: property, value, nameUri });
      });

    return out;
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

    // Material refs (when the stream points at a particular state of a defined
    // material — common on MaterialFlow streams).
    const materialStateRef = this.getReferenceIds(obj, 'MaterialStateReference')[0];
    const materialTemplateRef = this.getReferenceIds(obj, 'MaterialTemplateReference')[0];

    // Stream-level attributes — same parser as step attributes; skip the
    // structural properties that already became dedicated fields above.
    const attributes = this.parseAttributesOn(
      obj,
      new Set(['Identifier', 'Label', 'InformationValue', 'Source', 'Target'])
    );

    return {
      id, dexpiType, identifier, label,
      sourcePortId, targetPortId,
      informationVariantLabel: infoVariantLabel,
      materialStateRef, materialTemplateRef,
      attributes: attributes.length > 0 ? attributes : undefined,
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
      ['ThermalEnergyPort', 'MechanicalEnergyPort', 'ElectricalEnergyPort'].includes(port.type);
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
    // DEXPI primitive values can live inside <String>, <Double>, <Integer>,
    // or <Boolean> wrappers depending on the property's type. Pick the first
    // wrapper we find and stringify its content; per-property typing happens
    // at the consumer level.
    const dataEl = Array.from(parent.children).find(c =>
      c.tagName === 'Data' && c.getAttribute('property') === property
    );
    if (!dataEl) return '';
    const valueNode = Array.from(dataEl.children).find(c =>
      c.tagName === 'String' || c.tagName === 'Double' ||
      c.tagName === 'Integer' || c.tagName === 'Boolean'
    );
    return valueNode?.textContent?.trim() || '';
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
      layout.set(`dt_${tmpl.uid}`, { x: dtX, y: dtY, w: 36, h: 50 });
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

    // Generic rule: energy supply Sources (whose only port is energy-typed) are
    // auxiliary inputs (e.g. EEI1 → motor), not the start of the material flow.
    // They should NOT contribute to "process roots" — otherwise their target
    // task gets pinned at layer 1, overriding the layer it would naturally
    // receive from the material chain. Material sources only.
    const materialSourceIds = sources.filter(id =>
      !this.isEnergyBoundaryProxy(stepById.get(id)!)
    );

    const sourceAdjacent = new Set<string>();
    materialSourceIds.forEach(sourceId => {
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
      let x = baseX + (stack === 0 ? 0 : (stack % 2 === 1 ? stackOffset : -stackOffset));

      // Avoid collision with adjacent task boxes (e.g. a recycle step sitting
      // in the same Y band): if the chosen X overlaps any other layout box,
      // shift sideways until clear or accept the original X if no clear slot
      // is found.
      const collidesWith = (cx: number) => {
        for (const [otherId, box] of layout.entries()) {
          if (otherId === otherStepId || otherId === proxy.id) continue;
          if (!box.w || !box.h) continue;
          const overlapX = cx + w > box.x - 4 && cx < box.x + box.w + 4;
          const overlapY = y + h > box.y - 4 && y < box.y + box.h + 4;
          if (overlapX && overlapY) return true;
        }
        return false;
      };
      if (collidesWith(x)) {
        for (let stepIdx = 1; stepIdx <= 6; stepIdx += 1) {
          const dx = stepIdx * (w + 12);
          if (!collidesWith(x + dx)) { x = x + dx; break; }
          if (!collidesWith(x - dx)) { x = x - dx; break; }
        }
      }

      layout.set(proxy.id, { x, y, w, h });
    });
  }

  // ── BPMN builder ────────────────────────────────────────────────────────────

  private buildBpmn(parsed: ParsedDexpi, layout: Map<string, LayoutBox>): string {
    const { steps, connections, materialTemplates, materialComponents, materialStates, materialStateTypes } = parsed;

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
        // Only collapse the middle point if it's a true mid-point of a
        // straight monotonic run. A U-turn shares the constant axis with both
        // neighbors but reverses direction along the other axis — dropping it
        // would silently turn the U-turn into a straight line that no longer
        // passes the original waypoint.
        const verticalLine = previous.x === point.x && point.x === next.x;
        const horizontalLine = previous.y === point.y && point.y === next.y;
        const monotonicY = (previous.y - point.y) * (point.y - next.y) > 0;
        const monotonicX = (previous.x - point.x) * (point.x - next.x) > 0;
        const collapsibleVertical = verticalLine && monotonicY;
        const collapsibleHorizontal = horizontalLine && monotonicX;
        return !(collapsibleVertical || collapsibleHorizontal);
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

      // Helper: pick a Y that's clear of every obstacle whose X-extent overlaps
      // the corridor strip [xMin..xMax]. The returned Y sits above the topmost
      // overlapping box (side='top') or below the bottommost (side='bottom'),
      // padded by `pad`, so a horizontal segment placed there cannot cut
      // through any task body in the strip.
      const clearLaneY = (
        xMin: number,
        xMax: number,
        side: 'top' | 'bottom',
        pad = 45
      ) => {
        const lo = Math.min(xMin, xMax) - 4;
        const hi = Math.max(xMin, xMax) + 4;
        const overlapping = obstacles.filter(box =>
          box.x + box.w > lo && box.x < hi
        );
        if (overlapping.length === 0) {
          return side === 'top'
            ? Math.min(srcY, tgtY) - pad - laneOffset
            : Math.max(srcY, tgtY) + pad + laneOffset;
        }
        return side === 'top'
          ? Math.min(srcY, tgtY, ...overlapping.map(b => b.y)) - pad - laneOffset
          : Math.max(srcY, tgtY, ...overlapping.map(b => b.y + b.h)) + pad + laneOffset;
      };

      // Helper: find an X column clear of every obstacle (plus src and tgt
      // boxes) whose Y-extent overlaps [yMin..yMax]. Scans gaps between
      // obstacle x-ranges and returns the gap-midpoint closest to `preferX`.
      // Falls back to a position outside all obstacles if no interior gap
      // accommodates the column.
      const clearXColumn = (yMin: number, yMax: number, preferX: number) => {
        const lo = Math.min(yMin, yMax) - 4;
        const hi = Math.max(yMin, yMax) + 4;
        const blockers = [...obstacles, srcPos, tgtPos].filter(box =>
          box.y + box.h > lo && box.y < hi
        );
        if (blockers.length === 0) return preferX;

        const sorted = blockers
          .map(b => ({ x1: b.x - 30, x2: b.x + b.w + 30 }))
          .sort((a, b) => a.x1 - b.x1);
        const merged: { x1: number; x2: number }[] = [];
        for (const r of sorted) {
          const last = merged[merged.length - 1];
          if (last && r.x1 <= last.x2) last.x2 = Math.max(last.x2, r.x2);
          else merged.push({ ...r });
        }
        const gaps: number[] = [];
        gaps.push(merged[0].x1 - 30);
        for (let i = 1; i < merged.length; i++) {
          gaps.push((merged[i - 1].x2 + merged[i].x1) / 2);
        }
        gaps.push(merged[merged.length - 1].x2 + 30);
        return gaps.reduce((best, x) =>
          Math.abs(x - preferX) < Math.abs(best - preferX) ? x : best
        , gaps[0]);
      };

      // Generic rule: when either endpoint anchors on a top/bottom edge, route
      // with a stub-corner-stub pattern. The stub direction is dictated by the
      // edge so the connection visibly enters/exits perpendicular to the box.
      if (srcAnchor.side === 'top' || srcAnchor.side === 'bottom' ||
          tgtAnchor.side === 'top' || tgtAnchor.side === 'bottom') {
        // Stub is the perpendicular exit/entry segment — keep it short and
        // constant so verticals from different routes that happen to share
        // an X column (e.g. one route's src.bottom and another route's
        // tgt.top both anchored at the same x) don't extend into each
        // other's territory. Spreading parallel flows from the SAME port is
        // handled separately by port-share anchor nudging; spreading
        // parallel detour Ys is still done via laneOffset on the detour
        // band (clearLaneY / safeUDetour) below.
        const stub = 30;
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
          mid = { x: tgtStub.x, y: srcStub.y };
        } else if (!srcVertical && !tgtVertical) {
          mid = { x: tgtStub.x, y: srcStub.y };
        } else if (srcVertical) {
          mid = { x: srcStub.x, y: tgtStub.y };
        } else {
          mid = { x: tgtStub.x, y: srcStub.y };
        }

        // Validate the direct route against external obstacles AND against
        // src/tgt bodies for interior segments. The first segment (srcPoint
        // → srcStub) and the last segment (tgtStub → tgtPoint) are the
        // legitimate exit/entry to each anchor and may touch the box edges
        // — exclude them from the self-cut check. Without this exclusion
        // the legitimate exit would be flagged because the segment leaves
        // the source's edge into the padded region around it.
        const directRoute = [srcPoint, srcStub, mid, tgtStub, tgtPoint];
        const interiorCutsSelf = directRoute.some((point, index) => {
          if (index <= 1 || index >= directRoute.length - 1) return false;
          const prev = directRoute[index - 1];
          return segmentIntersectsObstacle(prev, point, [srcPos, tgtPos]);
        });
        if (!routeIntersectsObstacle(directRoute, obstacles) && !interiorCutsSelf) {
          return directRoute;
        }

        // The simple route cuts through a task. For two top/bottom anchors
        // (both vertical), the route depends on whether the two anchor sides
        // agree on a single Y band: if both want to exit DOWN (or both UP),
        // a 4-point detour through a clear lane works. If one exits down and
        // the other up — or the two rows aren't separated enough — a 4-point
        // detour would force the approach segment to traverse target's body
        // to reach an anchor on the opposite side, so build a 6-point loop
        // through a clear X column instead.
        if (srcVertical && tgtVertical) {
          const srcSide = srcAnchor.side as 'top' | 'bottom';
          const tgtSide = tgtAnchor.side as 'top' | 'bottom';
          const srcOuter = srcSide === 'bottom' ? srcPos.y + srcPos.h : srcPos.y;
          const tgtOuter = tgtSide === 'bottom' ? tgtPos.y + tgtPos.h : tgtPos.y;

          // Same side (both top or both bottom) → 4-point detour through a
          // single lane that's clear of every obstacle in the corridor.
          if (srcSide === tgtSide) {
            const farY = clearLaneY(srcPoint.x, tgtPoint.x, srcSide, 30);
            return [
              srcPoint,
              { x: srcPoint.x, y: farY },
              { x: tgtPoint.x, y: farY },
              tgtPoint,
            ];
          }

          // Opposite sides with a clear gap between them (src exits down,
          // tgt enters from above with tgt below src; or symmetric).
          // A 4-point route through a Y in the gap works: src exits into
          // the gap, traverses horizontally, then enters tgt on its facing
          // side — both stubs are perpendicular to their respective edges.
          const gapBetween =
            (srcSide === 'bottom' && tgtSide === 'top' && tgtOuter > srcOuter + 30) ||
            (srcSide === 'top' && tgtSide === 'bottom' && tgtOuter < srcOuter - 30);
          if (gapBetween) {
            const gapMin = Math.min(srcOuter, tgtOuter);
            const gapMax = Math.max(srcOuter, tgtOuter);
            const lo = Math.min(srcPoint.x, tgtPoint.x) - 4;
            const hi = Math.max(srcPoint.x, tgtPoint.x) + 4;
            const candidate = (gapMin + gapMax) / 2;
            const blocked = obstacles.some(box =>
              box.x + box.w > lo && box.x < hi &&
              candidate >= box.y - 4 && candidate <= box.y + box.h + 4
            );
            if (!blocked) {
              return [
                srcPoint,
                { x: srcPoint.x, y: candidate },
                { x: tgtPoint.x, y: candidate },
                tgtPoint,
              ];
            }
          }

          // Conflicting sides (src exits one way, tgt enters the other way).
          // Loop: short stub past src's edge → horizontal to a clean X column
          // outside every obstacle (plus src/tgt boxes) whose Y-extent
          // overlaps the [tgt-stub..src-stub] range → vertical along the
          // clean column → short stub past tgt's edge → into tgt.
          const srcStubY = srcStub.y;
          const tgtStubY = tgtStub.y;
          const cleanX = clearXColumn(
            Math.min(srcStubY, tgtStubY),
            Math.max(srcStubY, tgtStubY),
            (srcPoint.x + tgtPoint.x) / 2
          );
          return [
            srcPoint,
            { x: srcPoint.x, y: srcStubY },
            { x: cleanX, y: srcStubY },
            { x: cleanX, y: tgtStubY },
            { x: tgtPoint.x, y: tgtStubY },
            tgtPoint,
          ];
        }

        // Mixed sides (one vertical anchor + one horizontal anchor). Build a
        // 6-point route: src → vertical stub → corner past obstacles → over →
        // corner → horizontal stub → tgt. Pick whichever side (above/below or
        // left/right) of the obstacle group keeps the path clear.
        const allYs = obstacles.flatMap(b => [b.y, b.y + b.h]);
        const allXs = obstacles.flatMap(b => [b.x, b.x + b.w]);
        const verticalAnchorIsSrc = srcVertical;
        const verticalSide = verticalAnchorIsSrc ? srcAnchor.side : tgtAnchor.side;
        const verticalPoint = verticalAnchorIsSrc ? srcPoint : tgtPoint;
        const horizontalSide = verticalAnchorIsSrc ? tgtAnchor.side : srcAnchor.side;
        const horizontalPoint = verticalAnchorIsSrc ? tgtPoint : srcPoint;
        const farY = verticalSide === 'top'
          ? Math.min(verticalPoint.y, ...allYs) - 30 - laneOffset
          : Math.max(verticalPoint.y, ...allYs) + 30 + laneOffset;
        const farX = horizontalSide === 'left'
          ? Math.min(horizontalPoint.x, ...allXs) - 30 - laneOffset
          : Math.max(horizontalPoint.x, ...allXs) + 30 + laneOffset;
        // Vertical end's stub: extend perpendicular to far Y.
        const vStub = { x: verticalPoint.x, y: farY };
        // Horizontal end's stub: extend perpendicular to far X.
        const hStub = { x: farX, y: horizontalPoint.y };
        // Corner connecting them.
        const corner = { x: farX, y: farY };
        return verticalAnchorIsSrc
          ? [srcPoint, vStub, corner, hStub, tgtPoint]
          : [srcPoint, hStub, corner, vStub, tgtPoint];
      }

      // Helper: build a safe U-shape detour from src to tgt. Prefer routing
      // through the gap BETWEEN the source and target rows when one exists
      // (and is clear of obstacles in the strip) — that keeps the detour
      // Y inside the canvas instead of looping above or below everything.
      // Otherwise, fall back to a lane above all obstacles (or below, based
      // on which side puts the route closer to its endpoints).
      const safeUDetour = (
        exitX: number,
        entryX: number,
        forceBelow?: boolean
      ): Waypoint[] => {
        const goBelow = forceBelow !== undefined
          ? forceBelow
          : tgtPos.y + tgtPos.h / 2 > srcPos.y + srcPos.h / 2;

        const buildRoute = (detourY: number): Waypoint[] => [
          { x: srcX, y: srcY },
          { x: exitX, y: srcY },
          { x: exitX, y: detourY },
          { x: entryX, y: detourY },
          { x: entryX, y: tgtY },
          { x: tgtX, y: tgtY },
        ];

        const lo = Math.min(exitX, entryX) - 4;
        const hi = Math.max(exitX, entryX) + 4;
        const stripObstacles = obstacles.filter(box =>
          box.x + box.w > lo && box.x < hi
        );

        // Try the inter-row gap first when src and tgt are on different rows
        // — keeps the detour close to the endpoints. Validate the full route;
        // if any segment cuts an obstacle, fall through to the side-lane
        // candidates below.
        const rowsOverlap = srcPos.y < tgtPos.y + tgtPos.h && tgtPos.y < srcPos.y + srcPos.h;
        if (!rowsOverlap) {
          const gapTop = Math.min(srcPos.y + srcPos.h, tgtPos.y + tgtPos.h);
          const gapBottom = Math.max(srcPos.y, tgtPos.y);
          if (gapBottom - gapTop > 30) {
            // Spread parallel detours within the gap by `laneOffset` so two
            // routes through the same gap don't sit on top of each other.
            // The center is the natural pick for lane 0; later lanes
            // alternate above/below the center, clamped to the gap interior.
            const center = (gapTop + gapBottom) / 2;
            const halfGap = (gapBottom - gapTop) / 2 - 6;
            const spread = Math.max(-halfGap, Math.min(halfGap, laneOffset / 2));
            const candidate = center + spread;
            const blocked = stripObstacles.some(box =>
              candidate >= box.y - 4 && candidate <= box.y + box.h + 4
            );
            if (!blocked) {
              const route = buildRoute(candidate);
              if (!routeIntersectsObstacle(route, obstacles)) return route;
            }
          }
        }

        // Side lanes — try the preferred side first, then the opposite.
        for (const side of [goBelow ? 'bottom' : 'top', goBelow ? 'top' : 'bottom'] as const) {
          const detourY = clearLaneY(exitX, entryX, side);
          const route = buildRoute(detourY);
          if (!routeIntersectsObstacle(route, obstacles)) return route;
        }

        // Last resort: preferred side with no validation (better than throwing).
        return buildRoute(clearLaneY(exitX, entryX, goBelow ? 'bottom' : 'top'));
      };

      // Helper: pick a clear corridor X between two candidate positions, falling
      // back to a U-detour if the corridor route still intersects an obstacle.
      const exitFromAnchor = (anchor: Anchor, x: number) =>
        anchor.side === 'left' ? x - 35 - laneOffset : x + 35 + laneOffset;

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

        // Z-route cuts a task. Detour through a lane that is genuinely clear
        // of every obstacle in the corridor strip — and validate that the
        // verticals connecting srcY/tgtY to the detour Y don't traverse an
        // obstacle that contains exitX or entryX in its X range. If the
        // preferred side fails, try the other side; if both fail, fall back
        // to safeUDetour (which can route through inter-row gaps).
        let exitX = srcX + 35 + laneOffset;
        const entryMin = srcX + 35;
        const entryMax = Math.max(entryMin, tgtX - 25);
        let entryX = clamp(tgtX - 60 - laneOffset, entryMin, entryMax);

        // Push exitX/entryX past any obstacle whose Y range contains srcY/
        // tgtY and whose X range overlaps the source-exit / target-entry
        // horizontal — otherwise that approach segment would cut through it.
        // The exit goes RIGHT from srcX (so push exitX past the obstacle's
        // right edge); the entry goes RIGHT from entryX into tgtX (so push
        // entryX past the obstacle's right edge). Both segments go right
        // because src and tgt are both right→left forward (tgtX > srcX).
        for (const box of obstacles) {
          const overlapsRowSrc = box.y - 4 <= srcY && srcY <= box.y + box.h + 4;
          const overlapsRowTgt = box.y - 4 <= tgtY && tgtY <= box.y + box.h + 4;
          if (overlapsRowSrc) {
            const segMinX = Math.min(srcX, exitX);
            const segMaxX = Math.max(srcX, exitX);
            if (box.x + box.w + 4 > segMinX && box.x - 4 < segMaxX) {
              exitX = Math.max(exitX, box.x + box.w + 30);
            }
          }
          if (overlapsRowTgt) {
            const segMinX = Math.min(entryX, tgtX);
            const segMaxX = Math.max(entryX, tgtX);
            if (box.x + box.w + 4 > segMinX && box.x - 4 < segMaxX) {
              // Entry goes from entryX → tgtX. If obstacle is past entryX
              // but before tgtX, push entryX past the obstacle's right edge
              // (still keeping entryX < tgtX).
              const candidate = box.x + box.w + 30;
              if (candidate < tgtX) entryX = Math.max(entryX, candidate);
            }
          }
        }
        entryX = Math.min(entryX, entryMax);

        // Build a candidate detour route at a given Y and validate the whole
        // route against the obstacle list (catches verticals at exitX/entryX
        // that pass through obstacles whose X-range contains those columns).
        const buildDetourAt = (detourY: number): Waypoint[] => [
          { x: srcX, y: srcY },
          { x: exitX, y: srcY },
          { x: exitX, y: detourY },
          { x: entryX, y: detourY },
          { x: entryX, y: tgtY },
          { x: tgtX, y: tgtY },
        ];
        const tryDetourSide = (side: 'top' | 'bottom'): Waypoint[] | null => {
          // First try a tight Y that just clears the obstacles BLOCKING the
          // direct route (those whose Y range overlaps the [srcY..tgtY]
          // band). Going above ALL obstacles in the strip — as clearLaneY
          // does by default — produces visually weird peaks when the strip
          // happens to contain unrelated tasks far above/below the row.
          const stripLo = Math.min(exitX, entryX) - 4;
          const stripHi = Math.max(exitX, entryX) + 4;
          const bandLo = Math.min(srcY, tgtY) - 4;
          const bandHi = Math.max(srcY, tgtY) + 4;
          const blockers = obstacles.filter(box =>
            box.x + box.w > stripLo && box.x < stripHi &&
            box.y + box.h > bandLo && box.y < bandHi
          );
          if (blockers.length > 0) {
            const tightY = side === 'top'
              ? Math.min(...blockers.map(b => b.y)) - 30 - laneOffset
              : Math.max(...blockers.map(b => b.y + b.h)) + 30 + laneOffset;
            const tight = buildDetourAt(tightY);
            if (!routeIntersectsObstacle(tight, obstacles)) return tight;
          }
          // Fall back to the conservative lane (above/below ALL obstacles
          // in the strip). Needed when the verticals at exitX/entryX would
          // cut an obstacle in their column even at the tight Y.
          const conservativeY = clearLaneY(exitX, entryX, side);
          const conservative = buildDetourAt(conservativeY);
          if (routeIntersectsObstacle(conservative, obstacles)) return null;
          return conservative;
        };

        // Try BOTH sides and pick the route whose detour Y stays closest to
        // the source/target Y. Try 'bottom' first so it wins ties — visually
        // an under-row detour (going beneath the obstacle row) reads more
        // naturally than a peak above it.
        const candidates = (['bottom', 'top'] as const)
          .map(side => tryDetourSide(side))
          .filter((r): r is Waypoint[] => r !== null);
        if (candidates.length > 0) {
          const refY = (srcY + tgtY) / 2;
          candidates.sort((a, b) =>
            Math.abs(a[2].y - refY) - Math.abs(b[2].y - refY)
          );
          return candidates[0];
        }
        return safeUDetour(exitX, entryX);
      }

      // Backward flow shares two cases (right→left with srcX > tgtX, and
      // left→right with srcX < tgtX). In both, a short corridor approaches
      // the anchor edge from the wrong side and crosses target's body.
      // When src and tgt sit on the same row (their Y ranges overlap), the
      // crossing is at the row level and is the conventional recycle-return
      // corridor — keep the short corridor. When tgt is on a different row,
      // the corridor's vertical climb takes it into target's row and the
      // last horizontal cuts target body — fall to a safe U-detour above or
      // below every obstacle in the strip.
      const sameRow = (a: LayoutBox, b: LayoutBox) =>
        a.y < b.y + b.h && b.y < a.y + a.h;

      if (srcAnchor.side === 'right' && tgtAnchor.side === 'left' && srcX > tgtX) {
        const exitX = exitFromAnchor(srcAnchor, srcX);
        const entryX = exitFromAnchor(tgtAnchor, tgtX);
        if (sameRow(srcPos, tgtPos)) {
          const corridorRoute = [
            { x: srcX, y: srcY },
            { x: srcX + 45 + laneOffset, y: srcY },
            { x: srcX + 45 + laneOffset, y: tgtY },
            { x: tgtX, y: tgtY },
          ];
          if (!routeIntersectsObstacle(corridorRoute, obstacles)) return corridorRoute;
        }
        return safeUDetour(exitX, entryX);
      }

      if (srcAnchor.side === 'left' && tgtAnchor.side === 'right' && srcX < tgtX) {
        const exitX = exitFromAnchor(srcAnchor, srcX);
        const entryX = exitFromAnchor(tgtAnchor, tgtX);
        if (sameRow(srcPos, tgtPos)) {
          const corridorRoute = [
            { x: srcX, y: srcY },
            { x: srcX - 45 - laneOffset, y: srcY },
            { x: srcX - 45 - laneOffset, y: tgtY },
            { x: tgtX, y: tgtY },
          ];
          if (!routeIntersectsObstacle(corridorRoute, obstacles)) return corridorRoute;
        }
        return safeUDetour(exitX, entryX);
      }

      if (srcAnchor.side === tgtAnchor.side) {
        const corridorPadding = 45 + laneOffset;
        const corridorX = srcAnchor.side === 'left'
          ? Math.min(srcX, tgtX) - corridorPadding
          : Math.max(srcX, tgtX) + corridorPadding;
        const corridorRoute = [
          { x: srcX, y: srcY },
          { x: corridorX, y: srcY },
          { x: corridorX, y: tgtY },
          { x: tgtX, y: tgtY },
        ];
        if (!routeIntersectsObstacle(corridorRoute, obstacles)) return corridorRoute;
        const exitX = exitFromAnchor(srcAnchor, srcX);
        const entryX = exitFromAnchor(tgtAnchor, tgtX);
        return safeUDetour(exitX, entryX);
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

    const escAttrXml = (text: string) => text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const renderAttrTags = (
      attrs: ParsedStreamAttribute[] | undefined,
      indent: string,
    ): string => {
      if (!attrs || attrs.length === 0) return '';
      return attrs.map(attr => {
        const parts: string[] = [`name="${escAttrXml(attr.name)}"`, `value="${escAttrXml(attr.value)}"`];
        if (attr.unit) parts.push(`unit="${escAttrXml(attr.unit)}"`);
        if (attr.unitUri) parts.push(`unitUri="${escAttrXml(attr.unitUri)}"`);
        if (attr.nameUri) parts.push(`nameUri="${escAttrXml(attr.nameUri)}"`);
        if (attr.provenance) parts.push(`provenance="${escAttrXml(attr.provenance)}"`);
        if (attr.range) parts.push(`range="${escAttrXml(attr.range)}"`);
        return `${indent}<dexpi:Attribute ${parts.join(' ')}/>`;
      }).join('\n');
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
      const attrsXml = renderAttrTags(step.attributes, `${indent}    `);
      const innerLines = [portsXml, attrsXml].filter(Boolean).join('\n');

      return `${indent}<bpmn:extensionElements>
${indent}  <dexpi:element dexpiType="${step.dexpiType}" identifier="${step.identifier}" uid="${step.id}">
${innerLines ? innerLines + '\n' : ''}${indent}  </dexpi:element>
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

    // Data-object position pre-pass.
    // Sequence flows route around data objects, so we need their bounding
    // boxes in the obstacle list before the seq-flow routing loop runs.
    // The actual XML generation (dataObjectReference, association edges)
    // happens later in `infoFlows.forEach`, which finds the precomputed
    // entries in `dobjBySourcePort` and skips repositioning.
    const dobjBySourcePort = new Map<string, { dobjId: string; dobjX: number; dobjY: number; key: string }>();
    const dataObjBoxesByOwner = new Map<string, LayoutBox[]>();
    const DATA_OBJ_W = 36;
    const DATA_OBJ_H = 50;
    const placeDataObject = (conn: DexpiConnection) => {
      const src = portToStep.get(conn.sourcePortId);
      const tgt = portToStep.get(conn.targetPortId);
      if (!src || !tgt) return;
      if (dobjBySourcePort.has(conn.sourcePortId)) return;

      const srcStep = stepById.get(src);
      const key = ownerKey(srcStep?.parentId);
      const varName = conn.informationVariantLabel || conn.label;

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
      const gap = 12;

      let dobjY = (srcCenter.y + tgtCenter.y) / 2 - DATA_OBJ_H / 2;
      if (srcPos && tgtPos) {
        const above = srcPos.y < tgtPos.y ? srcPos : tgtPos;
        const below = srcPos.y < tgtPos.y ? tgtPos : srcPos;
        const minY = above.y + above.h + gap;
        const maxY = below.y - gap - DATA_OBJ_H;
        if (minY <= maxY) {
          dobjY = Math.max(minY, Math.min(maxY, dobjY));
        }
      }
      let dobjX = (srcCenter.x + tgtCenter.x) / 2 - DATA_OBJ_W / 2;

      const obstacleList = [...ownerLayout.entries()]
        .filter(([id, box]) => id !== src && id !== tgt && box.w > 0 && box.h > 0)
        .map(([, box]) => box);
      const PORT_STUB_HALF = 18;
      const collidesAt = (x: number, y: number) => {
        for (const box of obstacleList) {
          const overlapX = x + DATA_OBJ_W > box.x - 4 && x < box.x + box.w + 4;
          const overlapY = y + DATA_OBJ_H > box.y - 4 && y < box.y + box.h + 4;
          if (overlapX && overlapY) return true;
        }
        for (const box of obstacleList) {
          const cx = box.x + box.w / 2;
          const inFootprintY = y + DATA_OBJ_H > box.y - 4 && y < box.y + box.h + 4;
          const onCenterLine = cx > x - PORT_STUB_HALF && cx < x + DATA_OBJ_W + PORT_STUB_HALF;
          if (inFootprintY && onCenterLine) return true;
        }
        return false;
      };
      if (collidesAt(dobjX, dobjY)) {
        for (let stepIdx = 1; stepIdx <= 8; stepIdx += 1) {
          const dx = stepIdx * 22;
          let resolved = false;
          for (const candidate of [dobjX + dx, dobjX - dx]) {
            if (!collidesAt(candidate, dobjY)) {
              dobjX = candidate;
              resolved = true;
              break;
            }
          }
          if (resolved) break;
        }
      }

      dobjBySourcePort.set(conn.sourcePortId, { dobjId, dobjX, dobjY, key });
      if (!dataObjBoxesByOwner.has(key)) dataObjBoxesByOwner.set(key, []);
      dataObjBoxesByOwner.get(key)!.push({ x: dobjX, y: dobjY, w: DATA_OBJ_W, h: DATA_OBJ_H });
    };
    infoFlows.forEach(conn => placeDataObject(conn));

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

      // Include any stream-level attributes / material refs parsed from the
      // DEXPI XML so they show up in the Stream Properties panel and survive
      // a second round-trip back to DEXPI.
      const escAttr = (text: string) => text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      const tmplAttr = conn.materialTemplateRef ? ` templateReference="${escAttr(conn.materialTemplateRef)}"` : '';
      const stateAttr = conn.materialStateRef ? ` materialStateReference="${escAttr(conn.materialStateRef)}"` : '';
      const streamHasChildren = (conn.attributes && conn.attributes.length > 0);
      const streamOpenTag = `<dexpi:Stream uid="${conn.id}" identifier="${conn.identifier}"${streamTypeAttr} sourcePortRef="${conn.sourcePortId}" targetPortRef="${conn.targetPortId}"${tmplAttr}${stateAttr}`;
      let streamXml: string;
      if (streamHasChildren) {
        const attrLines = (conn.attributes || []).map(attr => {
          const parts: string[] = [`name="${escAttr(attr.name)}"`, `value="${escAttr(attr.value)}"`];
          if (attr.unit) parts.push(`unit="${escAttr(attr.unit)}"`);
          if (attr.unitUri) parts.push(`unitUri="${escAttr(attr.unitUri)}"`);
          if (attr.nameUri) parts.push(`nameUri="${escAttr(attr.nameUri)}"`);
          if (attr.provenance) parts.push(`provenance="${escAttr(attr.provenance)}"`);
          if (attr.range) parts.push(`range="${escAttr(attr.range)}"`);
          // Both step and stream attributes share the unified <dexpi:Attribute>
          // element. DEXPI Process.xml itself has no Attribute/StreamAttribute
          // distinction (both are encoded as <Components property="X"><Object
          // type="Core/QualifiedValue"/></Components>); the moddle previously
          // had two parallel types with identical fields, now unified into
          // one. BpmnToDexpiTransformer.extractStreamData accepts both
          // 'attribute' and 'streamattribute' localNames for back-compat.
          return `      <dexpi:Attribute ${parts.join(' ')}/>`;
        }).join('\n');
        streamXml = `${streamOpenTag}>
${attrLines}
    </dexpi:Stream>`;
      } else {
        streamXml = `${streamOpenTag}/>`;
      }

      sequenceFlowsByOwner.get(key)!.push(`<bpmn:sequenceFlow id="${connId}" name="${conn.label}" sourceRef="${bpmnId(src)}" targetRef="${bpmnId(tgt)}">
  <bpmn:extensionElements>
    ${streamXml}
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
      const dataObjObstacles = dataObjBoxesByOwner.get(key) || [];
      const routedWaypoints = routeSequenceFlow(srcPos, tgtPos, nextLane(key), srcA, tgtA, [...obstacles, ...dataObjObstacles]);
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
    // Positions in `dobjBySourcePort` were computed by the pre-pass above
    // (so seq-flow routing could include data objects as obstacles); this
    // loop emits the actual XML, using `dobjEmitted` to ensure each
    // (source-port, dataObject) pair emits its shape/output-association
    // only once even when multiple infoFlows share the same source port.
    const dobjEmitted = new Set<string>();
    infoFlows.forEach(conn => {
      const src = portToStep.get(conn.sourcePortId);
      const tgt = portToStep.get(conn.targetPortId);
      if (!src || !tgt) return;
      const srcStep = stepById.get(src);
      const tgtStep = stepById.get(tgt);
      const key = ownerKey(srcStep?.parentId);
      const varName = conn.informationVariantLabel || conn.label;

      const dobjInfo = dobjBySourcePort.get(conn.sourcePortId);
      if (!dobjInfo) return;

      if (!dobjEmitted.has(conn.sourcePortId)) {
        dobjEmitted.add(conn.sourcePortId);

        const ownerLayout = ownerLayouts.get(key) || layout;
        const srcPos = ownerLayout.get(src);
        const { dobjId, dobjX, dobjY } = dobjInfo;

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

    // Schema-correct instrumentation re-synthesis (DEXPI 2.0 Spec p.876, 900):
    // the export branch (post-71c1ea0) drops Ports composition for
    // InstrumentationActivity descendants and emits ProcessStepReference +
    // MeasuredVariableReference / MeasuredVariableLabel on the activity Object
    // itself. parseStep captures both fields on DexpiStep; here we synthesize
    // the BPMN dataObject pattern that the user is used to seeing graphically:
    // dataObjectReference (named after the variable identity) +
    // bpmn:association from the InstrumentationActivity to the dataObject +
    // bpmn:association from the dataObject to the referenced ProcessStep.
    // The result is a round-trip that recovers the visual relationship even
    // though no InformationFlow object was carried in the DEXPI XML.
    const instrDobjEmitted = new Set<string>();
    const INSTR_DATA_OBJ_W = 36;
    const INSTR_DATA_OBJ_H = 50;
    steps
      .filter(s => !hiddenStepIds.has(s.id))
      .filter(s => this.isInstrumentationStep(s))
      .filter(s => !!s.processStepRef && !!s.measuredVariable)
      .forEach(activity => {
        const refStepId = activity.processStepRef!;
        if (hiddenStepIds.has(refStepId)) return;
        const refStep = stepById.get(refStepId);
        if (!refStep) return;

        const activityKey = ownerKey(activity.parentId);
        const ownerLayout = ownerLayouts.get(activityKey) || layout;
        const activityPos = ownerLayout.get(activity.id);
        // The referenced ProcessStep may live in a different subprocess
        // hierarchy. Use whichever layout actually contains it; fall back
        // to the root layout.
        let refPos = ownerLayout.get(refStepId);
        if (!refPos) {
          const refKey = ownerKey(refStep.parentId);
          refPos = (ownerLayouts.get(refKey) || layout).get(refStepId);
        }
        if (!activityPos || !refPos) return;

        // Stable dobjId that survives multiple instrumentation activities
        // sharing the same target variable on the same step (rare). Stable
        // enough that re-running the import yields identical IDs.
        const safeVar = activity.measuredVariable!.replace(/[^a-zA-Z0-9_]/g, '_');
        const dobjId = `dobj_instr_${bpmnId(activity.id).replace(/^bpmn_/, '')}_${safeVar}`;
        if (instrDobjEmitted.has(dobjId)) return;
        instrDobjEmitted.add(dobjId);

        // Position the dataObject at the midpoint between the two tasks.
        const aCx = activityPos.x + activityPos.w / 2;
        const aCy = activityPos.y + activityPos.h / 2;
        const rCx = refPos.x + refPos.w / 2;
        const rCy = refPos.y + refPos.h / 2;
        const dobjX = (aCx + rCx) / 2 - INSTR_DATA_OBJ_W / 2;
        const dobjY = (aCy + rCy) / 2 - INSTR_DATA_OBJ_H / 2;

        const assocOutId = `assocOut_${dobjId}`;
        const assocInId = `assocIn_${dobjId}`;
        const varName = activity.measuredVariable!;

        const dataObjectXml = `<bpmn:dataObjectReference id="${dobjId}" name="${varName}" dataObjectRef="DataObject_${dobjId}"/>
  <bpmn:dataObject id="DataObject_${dobjId}"/>
  <bpmn:association id="${assocOutId}" sourceRef="${bpmnId(activity.id)}" targetRef="${dobjId}" associationDirection="One"/>
  <bpmn:association id="${assocInId}" sourceRef="${dobjId}" targetRef="${bpmnId(refStepId)}" associationDirection="One"/>`;
        if (activityKey === rootOwner) {
          processElements.push(indentBlock(dataObjectXml, '  '));
        } else {
          pushOwned(extraProcessElementsByOwner, activityKey, dataObjectXml);
        }

        const shapeXml = `      <bpmndi:BPMNShape id="${dobjId}_di" bpmnElement="${dobjId}">
        <dc:Bounds x="${dobjX}" y="${dobjY}" width="${INSTR_DATA_OBJ_W}" height="${INSTR_DATA_OBJ_H}"/>
        <bpmndi:BPMNLabel/>
      </bpmndi:BPMNShape>`;
        if (activityKey === rootOwner) {
          shapeElements.push(shapeXml);
        } else {
          pushOwned(shapeElementsByOwner, activityKey, shapeXml);
        }

        // Edge from activity → dataObject. Pick the closer side (top/bottom)
        // based on where the dataObject lands relative to the activity.
        const dobjCenterY = dobjY + INSTR_DATA_OBJ_H / 2;
        const dobjBelowActivity = dobjCenterY >= aCy;
        const aEdgeY = dobjBelowActivity ? activityPos.y + activityPos.h : activityPos.y;
        const dobjEdgeYFromActivity = dobjBelowActivity ? dobjY : dobjY + INSTR_DATA_OBJ_H;
        const edgeOutXml = `      <bpmndi:BPMNEdge id="${assocOutId}_di" bpmnElement="${assocOutId}">
        <di:waypoint x="${aCx}" y="${aEdgeY}"/>
        <di:waypoint x="${dobjX + INSTR_DATA_OBJ_W / 2}" y="${dobjEdgeYFromActivity}"/>
      </bpmndi:BPMNEdge>`;
        if (activityKey === rootOwner) {
          edgeElements.push(edgeOutXml);
        } else {
          pushOwned(edgeElementsByOwner, activityKey, edgeOutXml);
        }

        // Edge from dataObject → referenced ProcessStep.
        const dobjBelowRef = dobjCenterY >= rCy;
        const rEdgeY = dobjBelowRef ? refPos.y + refPos.h : refPos.y;
        const dobjEdgeYFromRef = dobjBelowRef ? dobjY : dobjY + INSTR_DATA_OBJ_H;
        const edgeInXml = `      <bpmndi:BPMNEdge id="${assocInId}_di" bpmnElement="${assocInId}">
        <di:waypoint x="${dobjX + INSTR_DATA_OBJ_W / 2}" y="${dobjEdgeYFromRef}"/>
        <di:waypoint x="${rCx}" y="${rEdgeY}"/>
      </bpmndi:BPMNEdge>`;
        if (activityKey === rootOwner) {
          edgeElements.push(edgeInXml);
        } else {
          pushOwned(edgeElementsByOwner, activityKey, edgeInXml);
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

    // Material data → BPMN extension XML.
    //
    // Two container DataObjectReferences mirror the format the BPMN→DEXPI
    // transformer's extractMaterialData reads back in:
    //   * "MaterialTemplates" container — holds all <MaterialTemplate> and
    //     <MaterialComponent> entries (with full body: NumberOfPhases,
    //     ListOfMaterialComponents references, etc.).
    //   * "Base Case MaterialStates" container — holds all <MaterialState>
    //     entries with <Flow><MoleFlow/><Composition/></Flow> inlined from
    //     the linked MaterialStateType.
    // This is what MaterialLibraryPanel and MaterialEditorPanel walk; without
    // these containers the imported BPMN has no recoverable material data.
    const stateTypeByUid = new Map(materialStateTypes.map(s => [s.uid, s]));

    const escapeXml = (text: string) => text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const renderMaterialTemplate = (t: DexpiMaterialTemplate): string => {
      const lines: string[] = [`        <MaterialTemplate uid="${escapeXml(t.uid)}">`];
      lines.push(`          <Identifier>${escapeXml(t.identifier)}</Identifier>`);
      lines.push(`          <Label>${escapeXml(t.label)}</Label>`);
      if (t.description) lines.push(`          <Description>${escapeXml(t.description)}</Description>`);
      if (t.numberOfComponents) lines.push(`          <NumberOfMaterialComponents>${escapeXml(t.numberOfComponents)}</NumberOfMaterialComponents>`);
      if (t.numberOfPhases) lines.push(`          <NumberOfPhases>${escapeXml(t.numberOfPhases)}</NumberOfPhases>`);
      if (t.componentRefs.length > 0) {
        lines.push(`          <ListOfMaterialComponents>`);
        t.componentRefs.forEach(ref => {
          lines.push(`            <MaterialComponentIdentifier uidRef="${escapeXml(ref)}"/>`);
        });
        lines.push(`          </ListOfMaterialComponents>`);
      }
      if (t.phases.length > 0) {
        lines.push(`          <ListOfPhases>`);
        t.phases.forEach(phase => {
          lines.push(`            <PhaseIdentifier Identifier="${escapeXml(phase)}"/>`);
        });
        lines.push(`          </ListOfPhases>`);
      }
      lines.push(`        </MaterialTemplate>`);
      return lines.join('\n');
    };

    const renderMaterialComponent = (c: DexpiMaterialComponent): string => {
      const lines: string[] = [`        <MaterialComponent xsi:type="${escapeXml(c.xsiType)}" uid="${escapeXml(c.uid)}">`];
      lines.push(`          <Identifier>${escapeXml(c.identifier)}</Identifier>`);
      lines.push(`          <Label>${escapeXml(c.label)}</Label>`);
      if (c.description) lines.push(`          <Description>${escapeXml(c.description)}</Description>`);
      if (c.chebiId) lines.push(`          <ChEBI_identifier>${escapeXml(c.chebiId)}</ChEBI_identifier>`);
      if (c.iupacId) lines.push(`          <IUPAC_identifier>${escapeXml(c.iupacId)}</IUPAC_identifier>`);
      lines.push(`        </MaterialComponent>`);
      return lines.join('\n');
    };

    const renderMaterialState = (s: DexpiMaterialState): string => {
      const lines: string[] = [`        <MaterialState uid="${escapeXml(s.uid)}">`];
      lines.push(`          <Identifier>${escapeXml(s.identifier)}</Identifier>`);
      lines.push(`          <Label>${escapeXml(s.label)}</Label>`);
      if (s.description) lines.push(`          <Description>${escapeXml(s.description)}</Description>`);
      // Inline Flow data from the linked MaterialStateType.
      const stateType = s.stateTypeRef ? stateTypeByUid.get(s.stateTypeRef) : undefined;
      if (stateType) {
        const hasFlow = stateType.moleFlow || stateType.composition;
        if (hasFlow) {
          lines.push(`          <Flow>`);
          if (stateType.moleFlow) {
            lines.push(`            <MoleFlow>`);
            lines.push(`              <Value>${escapeXml(stateType.moleFlow.value)}</Value>`);
            lines.push(`              <Unit>${escapeXml(stateType.moleFlow.unit)}</Unit>`);
            lines.push(`            </MoleFlow>`);
          }
          if (stateType.composition) {
            lines.push(`            <Composition>`);
            if (stateType.composition.basis) lines.push(`              <Basis>${escapeXml(stateType.composition.basis)}</Basis>`);
            if (stateType.composition.display) lines.push(`              <Display>${escapeXml(stateType.composition.display)}</Display>`);
            stateType.composition.fractions.forEach(f => {
              lines.push(`              <Fraction>`);
              lines.push(`                <Value>${escapeXml(f.value)}</Value>`);
              if (f.unit) lines.push(`                <Unit>${escapeXml(f.unit)}</Unit>`);
              if (f.componentRef) lines.push(`                <ComponentReference>${escapeXml(f.componentRef)}</ComponentReference>`);
              lines.push(`              </Fraction>`);
            });
            lines.push(`            </Composition>`);
          }
          lines.push(`          </Flow>`);
        }
      }
      // Either the state itself OR its linked state-type may carry a TemplateReference.
      const tmplRef = s.templateRef || stateType?.templateRef;
      if (tmplRef) {
        lines.push(`          <TemplateReference uidRef="${escapeXml(tmplRef)}"/>`);
      }
      lines.push(`        </MaterialState>`);
      return lines.join('\n');
    };

    if (materialTemplates.length > 0 || materialComponents.length > 0) {
      const tmplsXml = materialTemplates.map(renderMaterialTemplate).join('\n');
      const compsXml = materialComponents.map(renderMaterialComponent).join('\n');
      const innerXml = [tmplsXml, compsXml].filter(Boolean).join('\n');
      // Anchor the container near the first template's layout position so the
      // BPMN diagram still has a visible icon for it.
      const first = materialTemplates[0];
      const pos = first ? layout.get(`dt_${first.uid}`) : undefined;
      const dobjId = `dt_dobj_MaterialTemplates`;
      processElements.push(`  <bpmn:dataObjectReference id="${dobjId}" name="MaterialTemplates" dataObjectRef="DataObject_${dobjId}">
    <bpmn:extensionElements>
${innerXml}
    </bpmn:extensionElements>
  </bpmn:dataObjectReference>
  <bpmn:dataObject id="DataObject_${dobjId}"/>`);
      if (pos) {
        shapeElements.push(`      <bpmndi:BPMNShape id="${dobjId}_di" bpmnElement="${dobjId}">
        <dc:Bounds x="${pos.x}" y="${pos.y}" width="36" height="50"/>
        <bpmndi:BPMNLabel/>
      </bpmndi:BPMNShape>`);
      }
    }

    if (materialStates.length > 0) {
      const statesXml = materialStates.map(renderMaterialState).join('\n');
      // Anchor next to the templates container if a second template position
      // exists, otherwise leave unpositioned.
      const second = materialTemplates[1];
      const pos = second ? layout.get(`dt_${second.uid}`) : undefined;
      const dobjId = `dt_dobj_MaterialStates`;
      processElements.push(`  <bpmn:dataObjectReference id="${dobjId}" name="Base Case MaterialStates" dataObjectRef="DataObject_${dobjId}">
    <bpmn:extensionElements>
${statesXml}
    </bpmn:extensionElements>
  </bpmn:dataObjectReference>
  <bpmn:dataObject id="DataObject_${dobjId}"/>`);
      if (pos) {
        shapeElements.push(`      <bpmndi:BPMNShape id="${dobjId}_di" bpmnElement="${dobjId}">
        <dc:Bounds x="${pos.x}" y="${pos.y}" width="36" height="50"/>
        <bpmndi:BPMNLabel/>
      </bpmndi:BPMNShape>`);
      }
    }

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
    // A Source/Sink is a port-proxy (mirrored boundary that the BPMN exporter
    // emitted to give a parent-port a visual representation) when one of:
    //   1. Any port carries an explicit superPortId pointing at the parent
    //      ProcessNode port — the structural link from sub/superReference.
    //   2. The step label equals every port's label and at least one port
    //      exists — the BPMN→DEXPI exporter writes proxies this way (step
    //      named after the port it mirrors). Real energy/material supply
    //      boundaries carry a descriptive name that differs from their port.
    if (step.dexpiType !== 'Source' && step.dexpiType !== 'Sink') return false;
    if (step.ports.some(port => port.superPortId)) return true;

    // A Source/Sink that owns a real (non-mirrored) energy port represents an
    // energy supply/sink boundary — keep it visible so positionEnergy­Boundary­
    // Proxies can place it above/below the connected interior task.
    if (step.ports.some(port => this.isEnergyPort(port) && !port.superPortId)) {
      return false;
    }

    const label = step.label.trim();
    if (!label || step.ports.length === 0) return false;
    return step.ports.every(port => port.label === label);
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
