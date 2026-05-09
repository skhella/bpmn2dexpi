/**
 * One authored property on a MaterialComponent that's not one of the
 * canonical DEXPI fields (Identifier / Label / Description / ChEBI_identifier
 * / IUPAC_identifier). Held in the MaterialLibraryPanel state and
 * round-tripped through the BPMN extensionElements so project-extension
 * thermo data (MolecularWeight, AntoineA, etc.) and ad-hoc DataProperties
 * (IsEffectivelyNoncondensable, ProjectReference, …) survive editing.
 *
 * `kind: 'composition'` rows hold a Core/QualifiedValue-shaped measurement
 * (Value + optional Unit + optional UnitReference). `kind: 'data'` rows
 * hold a flat string DataProperty.
 *
 * Mirror of `MaterialComponentExtraProperty` in transformer/types.ts; the
 * MaterialLibraryPanel and the transformer use the same shape to keep
 * read/write paths in lockstep.
 */
export interface MaterialComponentProperty {
  kind: 'composition' | 'data';
  name: string;
  value: string;
  unit?: string;
  unitReference?: string;
}

export interface MaterialComponent {
  uid: string;
  identifier: string;
  label: string;
  description?: string;
  type: 'PureMaterialComponent' | 'CustomMaterialComponent';
  chebiId?: string;
  iupacId?: string;
  /**
   * Project-extension and thermo data authored on this MaterialComponent.
   * Round-tripped verbatim through the BPMN extensionElements so the panel
   * surfaces what the transformer reads (MolecularWeight, AntoineA, etc.)
   * and writes back any user edits to the same canonical-DEXPI carriers.
   */
  properties?: MaterialComponentProperty[];
  // Legacy convenience accessor — kept so callers that already compute
  // physicalProperties.molecularWeight from the structured properties
  // continue to work. New code should read from `properties` directly.
  physicalProperties?: {
    molecularWeight?: { value: number; unit: string };
    vapourHeatCapacity?: { value: number; unit: string };
    referenceTemperature?: number;
  };
}

export interface MaterialTemplate {
  uid: string;
  identifier: string;
  label: string;
  description?: string;
  numberOfComponents: number;
  numberOfPhases: number;
  componentRefs: Array<string | { identifier: string; uidRef: string }>;
  phases: string[];
}

export interface MaterialState {
  uid: string;
  identifier: string;
  label: string;
  description?: string;
  flow?: {
    moleFlow?: { value: number; unit: string };
    massFlow?: { value: number; unit: string };
    composition?: {
      basis: string;
      display: string;
      /**
       * Per-component fraction entries. Each entry pairs a value with the
       * MaterialComponent it refers to (componentReference is the
       * MaterialComponent uid), in the same order as the
       * MaterialTemplate's ListOfComponents. Editors render each row as
       * "Component | Fraction value | Unit"; consumers that only need
       * the numeric vector can map(f => f.value).
       */
      fractions: { componentReference: string; value: number; unit?: string }[];
    };
  };
  temperature?: { value: number; unit: string };
  pressure?: { value: number; unit: string };
  templateRef?: string;
  streamRef?: string;
  referencedByStreams?: string[]; // List of stream names/identifiers that reference this state
}
