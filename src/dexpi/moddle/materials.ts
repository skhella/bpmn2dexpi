/**
 * One authored property on a MaterialComponent. Holds every DataProperty or
 * QualifiedValue-shaped CompositionProperty declared on the component's
 * concrete class (PureMaterialComponent: ChEBI_identifier, IUPAC_identifier;
 * CustomMaterialComponent: ProjectReference) plus any project-extension
 * thermo data (MolecularWeight, AntoineA, IsEffectivelyNoncondensable, …)
 * the model author has added beyond the schema's vocabulary.
 *
 * Identifier / Label / Description stay as typed structural fields on
 * `MaterialComponent` because they're used as cross-reference targets and
 * list-display labels throughout the codebase; everything else flows
 * through this shape so the editor can render rows directly from
 * `DexpiProcessClassRegistry.getProperties(className)` and pick up new
 * Process.xml properties automatically when the schema is updated.
 *
 * `kind: 'composition'` rows hold a Core/QualifiedValue-shaped measurement
 * (Value + optional Unit + optional UnitReference). `kind: 'data'` rows
 * hold a flat string DataProperty.
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
  /**
   * Every DataProperty / CompositionProperty authored on this component
   * other than the three structural fields above. Schema-declared properties
   * (ChEBI_identifier on PureMaterialComponent, ProjectReference on
   * CustomMaterialComponent, …) and project-extension thermo data
   * (MolecularWeight, AntoineA, …) share the same array shape so the
   * editor can render both from a single registry-driven loop.
   */
  properties?: MaterialComponentProperty[];
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
