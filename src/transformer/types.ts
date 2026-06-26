/**
 * Internal types for the BpmnToDexpiTransformer.
 * These replace all `any` usages and make the data flow explicit.
 */

import type { DexpiPort } from '../dexpi/moddle';

// ── Process step (ProcessStep / Source / Sink / InstrumentationActivity) ─────

export interface InternalProcessStep {
  id: string;
  name: string;
  type: string;             // DEXPI class name, e.g. "ReactingChemicals"
  typingMode?: StepTypingMode; // how the type was determined
  customUri?: string;          // external RDL URI (unvalidated only, if provided)
  customSuperType?: string;    // user-chosen DEXPI parent class for Custom-typed steps
  identifier: string;
  uid: string;
  hierarchyLevel?: string;
  ports: DexpiPort[];
  attributes: Array<{ name: string; value: string; unit?: string; scope?: string; range?: string; provenance?: string; qualifier?: string; nameUri?: string }>;
  parentId: string | null;
  subProcessSteps: string[]; // child step IDs

  /**
   * For InstrumentationActivity descendants only.
   * Per DEXPI 2.0 (Process.xml + Specification PDF p.876, p.900): InstrumentationActivity
   * is a sibling of ProcessStep, not a subclass. It does not own a Ports composition;
   * its connection to the process is expressed through reference properties
   * (ProcessStepReference, MeasuredVariableReference, ConnectionReference,
   * ProcessStepDetailReference). These fields hold the BPMN-derived values that get
   * emitted as those References on export. Populated by extractDataObjectInformationFlows.
   */
  processStepRef?: string;       // → ProcessStep (the measured / controlled step)
  measuredVariable?: string;     // variable identity (e.g. "Temperature", "Pressure")
  /**
   * BPMN dataObjectReference id of the DataObject mediating the measurement.
   * Used at emit time as the stable id for both the QualifiedValue parameter
   * slot on the connected ProcessStep and the MeasuredVariableReference target
   * pointing at it. One InstrumentationActivity ↔ one BPMN DataObject ↔ one
   * QualifiedValue, so a single id captures the full link.
   */
  measuredVariableSourceId?: string;

  /**
   * For ProcessSteps only.
   * One entry per BPMN DataObject mediating an instrumentation flow into this
   * step. On emission each entry triggers a <Components property="<VarName>">
   * carrier wrapping a Core/QualifiedValue Object whose id derives from the
   * source dataObjectReference id — the stable target of MeasuredVariableReference
   * per DEXPI 2.0 Spec PDF p.900: "The measured variable is identified by reference
   * to a parameter in any process step or port." The Object's Data children are
   * populated from the BPMN-side <dexpi:components property="X"><dexpi:object
   * type="Core/QualifiedValue">…</dexpi:object></dexpi:components> authored on
   * the dataObjectReference's extensionElements; missing fields fall back to
   * <Undefined/> placeholders. Canonical variable names (Temperature, Pressure,
   * Level, MassFlow, ...) match a CompositionProperty declared on the step's
   * class; non-canonical names emit Components on the step too — the Profile
   * generator declares them as CompositionProperty extensions on the step's
   * class so the resulting XML is fully validatable end-to-end.
   */
  measuredParameters?: Array<{
    varName: string;
    /** BPMN dataObjectReference id (stable, round-trippable). */
    dataObjectId: string;
    /** Extracted from the dataObjectReference's extensionElements. May be empty. */
    qv?: QualifiedValueData;
  }>;
}

/**
 * Subset of Core/QualifiedValue Data properties extracted from a BPMN-side
 * canonical <dexpi:object type="Core/QualifiedValue"> carrier on a
 * dataObjectReference. All fields optional; the user may have authored only
 * some (e.g. only Provenance + Range with no measurement value yet).
 */
export interface QualifiedValueData {
  provenance?: string;
  range?: string;
  value?: string;
  unit?: string;
  displayText?: string;
}

// ── Port record (enriched with step back-reference) ──────────────────────────

export interface InternalPort extends DexpiPort {
  stepId: string;
  parentPortId?: string;
  childPortIds?: string[];
}

// ── Stream / flow records ─────────────────────────────────────────────────────

export interface StreamAttribute {
  name: string;
  /** Optional URI linking the attribute name to a standard quantity kind.
   *  e.g. https://qudt.org/vocab/quantitykind/MassFlowRate
   *       https://data.15926.org/rdl/R... */
  nameUri?: string;
  value: string;
  unit?: string;
  scope?: string;
  range?: string;
  provenance?: string;
  qualifier?: string;
  /** User-asserted required-cardinality flag (see DexpiAttribute.required). */
  required?: boolean;
}

export interface InternalStream {
  id: string;
  name: string;
  identifier: string;
  uid: string;
  sourceRef: string;
  targetRef: string;
  /**
   * Legacy port reference format (suffix only — e.g. "MO1_port"). The
   * transformer reads either this OR sourcePortId/targetPortId; new files
   * are written with sourcePortId/targetPortId. See DexpiStream's interface
   * docs for the full rationale.
   */
  sourcePortRef?: string;
  targetPortRef?: string;
  /** Preferred port reference format: full port id, self-contained in the
   *  dexpi extension. Robust to host-tool BPMN element renumbering. */
  sourcePortId?: string;
  targetPortId?: string;
  streamType: 'MaterialFlow' | 'EnergyFlow' | 'ThermalEnergyFlow' | 'MechanicalEnergyFlow' | 'ElectricalEnergyFlow' | 'InformationFlow';
  templateReference?: string;
  materialStateReference?: string;
  provenance?: string;
  range?: string;
  attributes: StreamAttribute[];
  informationVariantLabel?: string;  // DataObject name → DEXPI InformationVariant label
}

// ── Material data records ─────────────────────────────────────────────────────

export interface InternalMaterialTemplate {
  uid: string;
  identifier: string;
  label: string;
  description: string;
  numberOfComponents?: string;
  numberOfPhases?: string;
  componentRefs: string[];
  phases: string[];
}

/**
 * One authored property on a MaterialComponent that's not one of the
 * canonical-DEXPI fields (Identifier / Label / Description / ChEBI_identifier
 * / IUPAC_identifier). Captured verbatim so the transformer can round-trip
 * project-extension data (thermodynamic measurements like MolecularWeight,
 * Antoine equation coefficients, etc.) from BPMN to DEXPI XML without loss.
 *
 * `kind: 'composition'` rows hold a `Core/QualifiedValue`-shaped measurement
 * (Value + optional Unit + optional UnitReference). `kind: 'data'` rows hold
 * a flat string DataProperty (e.g. IsEffectivelyNoncondensable, an equation
 * descriptor, a project tag).
 */
export interface MaterialComponentExtraProperty {
  kind: 'composition' | 'data';
  name: string;
  /** For 'composition': the QualifiedValue's Value. For 'data': the flat string. */
  value: string;
  /** Only meaningful when kind = 'composition'. */
  unit?: string;
}

export interface InternalMaterialComponent {
  uid: string;
  identifier: string;
  label: string;
  description: string;
  chebiId?: string;
  iupacId?: string;
  xsiType: string;
  /**
   * Extra authored properties beyond the canonical-DEXPI fields above.
   * Round-tripped verbatim from the BPMN extensionElements to the emitted
   * DEXPI XML so project-extension thermo data (and any other authored
   * content) survives the BPMN → DEXPI conversion. Without this, the
   * reader would silently drop everything outside the typed fields above.
   */
  properties?: MaterialComponentExtraProperty[];
}

export interface InternalMaterialState {
  uid: string;
  identifier: string;
  label: string;
  description: string;
  caseName?: string;
  stateTypeRef?: string;
}

export interface FractionData {
  value: string;
  componentRef: string;
}

export interface CompositionData {
  basis: string;
  display: string;
  /**
   * The unit token authored on the fraction vector's QualifiedValue (e.g.
   * 'Percent'). Carried through so the emitter resolves it to a real
   * PhysicalQuantityVector unit literal rather than hardcoding one. Optional;
   * absent when the authoring omitted a unit (then the vector fails closed).
   */
  unit?: string;
  fractions: FractionData[];
}

/**
 * Scalar QualifiedValue property authored as a direct
 * <dexpi:components property="X"><dexpi:object type="Core/QualifiedValue">
 * child of MaterialStateType. No property name is special-cased: canonical
 * names declared on MaterialStateType in Process.xml (MassFlow, VolumeFlow,
 * ...) and project-extension names (e.g. MoleFlow) flow through this single
 * shape, and the Profile generator declares any non-canonical names at
 * export time.
 */
export interface ScalarFlowProperty {
  property: string;
  value: string;
  unit?: string;
  /**
   * Authored quantity choice (bare unit-enum name, e.g. 'MoleFlowRateUnit') from
   * the `unitEnum` attribute on the `<dexpi:components>` carrier. Only meaningful
   * for a custom measurement whose unit is not in the standard vocabulary and
   * whose property carries no schema unit-binding; the emitter uses it to write a
   * fully-qualified unit `DataReference` so the data-type tier (D9) can flag the
   * missing literal, which the Profile extension then closes.
   */
  unitEnum?: string;
}

export interface FlowData {
  scalars?: ScalarFlowProperty[];
  composition?: CompositionData;
}

export interface InternalMaterialStateType {
  uid: string;
  identifier: string;
  label: string;
  description: string;
  templateRef?: string;
  flow: FlowData;
}

// ── DEXPI model output structure ──────────────────────────────────────────────

export interface DexpiAttribute {
  $: Record<string, string>;
  Value?: { _: string; $?: Record<string, string> };
  Unit?: { _: string };
}

export interface DexpiPortOutput {
  $: {
    uid: string;
    identifier: string;
    label?: string;
    portType?: string;
    direction?: string;
  };
}

export interface DexpiProcessStepOutput {
  $: {
    'xsi:type': string;
    uid: string;
    identifier: string;
    label?: string;
    hierarchyLevel?: string;
  };
  ListOfPorts?: { Port: DexpiPortOutput[] };
  [key: string]: unknown;
}

export interface DexpiModelOutput {
  'dexpi:Plant': {
    $: Record<string, string>;
    PlantInformation?: unknown;
    ListOfProcessSteps?: { ProcessStep: DexpiProcessStepOutput[] };
    ListOfStreams?: { Stream: unknown[] };
    ListOfInformationFlows?: { InformationFlow: unknown[] };
    ListOfMaterialTemplates?: { MaterialTemplate: unknown[] };
    ListOfMaterialComponents?: { MaterialComponent: unknown[] };
    ListOfMaterialStates?: { MaterialState: unknown[] };
    ListOfMaterialStateTypes?: { MaterialStateType: unknown[] };
  };
}

// ── Transformer options ───────────────────────────────────────────────────────

export interface TransformOptions {
  projectName?: string;
  projectDescription?: string;
  author?: string;
  /**
   * URI for the emitted DEXPI Model wrapper (Model/@uri, XSD-required).
   * Defaults to `urn:bpmn2dexpi:model:<sanitized projectName>` — a local
   * URN that validates as `xsd:anyURI` without pretending to be a
   * publishable URL. Set explicitly when the model has a real home
   * (e.g. `"https://acme.com/dexpi/models/tep-2026"`).
   */
  modelUri?: string;
  /**
   * Optional raw Process.xml content. Required in browser environments where
   * the transformer cannot read from the filesystem; in Node it falls back to
   * reading dexpi-schema-files/Process.xml from disk if omitted.
   */
  processXml?: string;
  /**
   * Optional raw Core.xml content. Same browser-vs-Node fallback as
   * processXml. Required when strict-mode property-name validation is on
   * because supertype walking crosses Process → Core (e.g. Stream inherits
   * Identifier/Label/Source/Target from ProcessConnection → ConceptualObject).
   */
  coreXml?: string;
  /**
   * Optional DEXPI Profile extensions to merge into the schema registry.
   * Each entry is one extension XML in the same DEXPI metamodel grammar
   * Process.xml uses; entries may add new ConcreteClass / AbstractClass
   * declarations or extend existing classes with extra DataProperty /
   * ReferenceProperty / CompositionProperty entries. Conflicts (duplicate
   * class names) and unresolved supertypes are surfaced as load-time
   * errors via DexpiProcessClassRegistry.fromXmlSources().
   */
  profileXmls?: { name: string; xml: string }[];
  /**
   * Strict-mode validation toggle. Default false (DEXPI 2.0's permissive
   * philosophy: any XSD-valid output is exchangeable, so the user-facing
   * default is XSD-only). When true, the transformer additionally runs
   * property-name fidelity validation against the merged schema registry
   * after producing the DEXPI XML; results are surfaced via
   * BpmnToDexpiTransformer.lastPropertyNameValidation.
   *
   * Strict-mode failures NEVER block file production — output is written
   * the same way it is in non-strict mode. The CI test suite hard-codes
   * strict=true regardless of this default; see
   * DexpiPropertyNameCompliance.unit.test.ts.
   */
  strict?: boolean;
}

// ── Validation result ─────────────────────────────────────────────────────────

/**
 * 'xsd'        — full XSD validation against the official DEXPI 2.0 schema
 *                via xmllint (Node / CLI environments).
 * 'structural' — browser-safe fallback that checks the key DEXPI 2.0 object-model
 *                invariants without invoking xmllint.
 */
export type ValidationMode = 'xsd' | 'structural' | 'property-names';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Which validation strategy produced this result. */
  mode?: ValidationMode;
}

// ── Step typing result (three-mode classification) ────────────────────────────

/**
 * The three ways a process step type can be resolved, in priority order:
 *
 * 1. 'dexpi-validated'  — explicit dexpiType annotation found in extensionElements
 *                         AND the class name exists in the DEXPI Process.xml registry.
 *                         Clean, warning-free output.
 *
 * 2. 'custom-supertype' — dexpiType is NOT in the registry, but the user has
 *                         declared a customSuperType that IS in the registry.
 *                         The custom class name is preserved in the export and a
 *                         paired Profile (generated separately) declares it as a
 *                         subclass of the chosen supertype. Reload-validate closes
 *                         the loop without losing the custom type.
 *
 * 3. 'unvalidated'      — no dexpiType annotation, OR neither dexpiType nor
 *                         customSuperType is recognised by the registry. Falls
 *                         back to generic 'ProcessStep' with a warning naming the
 *                         specific failure (missing annotation vs. unknown
 *                         supertype). No fuzzy suggestions — the UI must offer a
 *                         supertype picker for custom classes; heuristic class
 *                         suggestions are out of scope.
 */
export type StepTypingMode = 'dexpi-validated' | 'custom-supertype' | 'unvalidated';

export interface StepTypingResult {
  /** The resolved DEXPI class name. */
  dexpiClass: string;
  /** How the class was determined. */
  mode: StepTypingMode;
  /** Optional URI referencing an external RDL class — stored in DEXPI output as ReferenceUri. */
  customUri?: string;
  /** User-chosen DEXPI parent class for custom-typed steps; consumed by the
   *  Profile generator when it synthesises a ConcreteClass declaration. */
  customSuperType?: string;
}
