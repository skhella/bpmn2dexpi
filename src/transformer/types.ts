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
  customUri?: string;          // external RDL URI (mode 2 only)
  suggestedDexpiClass?: string; // closest DEXPI class suggestion (mode 2 only)
  identifier: string;
  uid: string;
  hierarchyLevel?: string;
  ports: DexpiPort[];
  attributes: Array<{ name: string; value: string; unit?: string; scope?: string; range?: string; provenance?: string; qualifier?: string; nameUri?: string; unitUri?: string }>;
  parentId: string | null;
  subProcessSteps: string[]; // child step IDs
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
  /** Optional URI linking the unit to a standard unit definition.
   *  e.g. https://qudt.org/vocab/unit/KiloGM-PER-HR
   *       https://qudt.org/vocab/unit/DEG_C */
  unitUri?: string;
  scope?: string;
  range?: string;
  provenance?: string;
  qualifier?: string;
}

export interface InternalStream {
  id: string;
  name: string;
  identifier: string;
  uid: string;
  sourceRef: string;
  targetRef: string;
  sourcePortRef?: string;
  targetPortRef?: string;
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

export interface InternalMaterialComponent {
  uid: string;
  identifier: string;
  label: string;
  description: string;
  chebiId?: string;
  iupacId?: string;
  xsiType: string;
}

export interface InternalMaterialState {
  uid: string;
  identifier: string;
  label: string;
  description: string;
  caseName?: string;
  stateTypeRef?: string;
}

export interface MoleFlowData {
  value: string;
  unit: string;
}

export interface FractionData {
  value: string;
  componentRef: string;
}

export interface CompositionData {
  basis: string;
  display: string;
  fractions: FractionData[];
}

export interface FlowData {
  moleFlow?: MoleFlowData;
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
   * Optional raw Process.xml content. Required in browser environments where
   * the transformer cannot read from the filesystem; in Node it falls back to
   * reading dexpi-schema-files/Process.xml from disk if omitted.
   */
  processXml?: string;
}

// ── Validation result ─────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ── Step typing result (three-mode classification) ────────────────────────────

/**
 * The three ways a process step type can be resolved, in priority order:
 *
 * 1. 'dexpi-validated'  — explicit dexpiType annotation found in extensionElements
 *                         AND the class name exists in the DEXPI Process.xml registry.
 *                         This is the only mode that produces clean, warning-free output.
 *
 * 2. 'custom-type'      — explicit dexpiType annotation found but NOT in the DEXPI
 *                         registry. The user is defining a custom process step class
 *                         (e.g. from a company RDL or another ontology). The custom
 *                         type name is preserved in the DEXPI output; an optional
 *                         customUri stores the external class URI. A warning is emitted
 *                         with a "did you mean?" suggestion for the closest DEXPI class.
 *
 * 3. 'unannotated'      — no dexpiType annotation present at all. Defaults to
 *                         'ProcessStep' (the generic DEXPI superclass). Always emits
 *                         a warning prompting the user to add a dexpiType annotation.
 *                         No name-based inference is attempted.
 */
export type StepTypingMode = 'dexpi-validated' | 'custom-type' | 'unannotated';

export interface StepTypingResult {
  /** The resolved DEXPI class name (or heuristic guess). */
  dexpiClass: string;
  /** How the class was determined. */
  mode: StepTypingMode;
  /** Present when mode is 'custom-uri' — stored in DEXPI output as ExternalReference. */
  customUri?: string;
  /** Closest DEXPI class suggestion (populated for custom-uri mode when a near-match exists). */
  suggestedDexpiClass?: string;
}
