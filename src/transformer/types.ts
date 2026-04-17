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
  identifier: string;
  uid: string;
  hierarchyLevel?: string;
  ports: DexpiPort[];
  attributes: Array<{ name: string; value: string; unit?: string; scope?: string; range?: string; provenance?: string }>;
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
  value: string;
  unit?: string;
  scope?: string;
  range?: string;
  provenance?: string;
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
  streamType: 'MaterialFlow' | 'EnergyFlow' | 'InformationFlow';
  templateReference?: string;
  materialStateReference?: string;
  provenance?: string;
  range?: string;
  attributes: StreamAttribute[];
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
}

// ── Validation result ─────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
