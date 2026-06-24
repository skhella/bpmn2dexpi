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
 * (Value + optional Unit, serialised in the canonical nested PhysicalQuantity
 * carrier). `kind: 'data'` rows hold a flat string DataProperty.
 */
export interface MaterialComponentProperty {
  kind: 'composition' | 'data';
  name: string;
  value: string;
  unit?: string;
  /**
   * URI linking the property name to a standard quantity kind (QUDT,
   * ISO 15926, …). Only meaningful on composition rows whose inner Object
   * type is `Core/QualifiedValue` — emitted inside the QV Object as
   * `<dexpi:references property="QuantityKindReference" objects="URI"/>`,
   * which is the canonical DEXPI carrier for an attribute-name URI.
   * Ignored for data rows (no clean canonical slot in
   * `<dexpi:data property="X">value</dexpi:data>`).
   */
  nameUri?: string;
  /**
   * Multi-record payload for composition properties whose inner Object type
   * is **not** `Core/QualifiedValue` — e.g. `PersistentIdentifiers` whose
   * inner class is `Core/PersistentIdentifier` (Context + Value fields).
   * Each record is a flat map of inner DataProperty name → value.
   *
   * When `records` is set, `value` / `unit` / `nameUri`
   * are unused; the composition is rendered and serialised as a list of
   * the declared inner class's records. Inner class is resolved via
   * `registry.getCompositionInnerClassName(wrappingClass, prop.name)`.
   *
   * Empty array means "carrier present, no records yet" — useful for
   * UI placeholder rows. The save path skips emitting a `<dexpi:components>`
   * carrier when records is empty (same convention QualifiedValue uses
   * with empty value).
   */
  records?: Array<Record<string, string>>;
  /**
   * Inner Object's `type` attribute as it appeared in the BPMN — e.g.
   * `'Core/PersistentIdentifier'`. Captured at read time so writes preserve
   * the exact ref the source BPMN had (cross-namespace cases that the
   * registry's bare-name lookup can't reconstruct). When freshly authored,
   * the writer fills this in from `registry.getCompositionInnerClassName`
   * + a sensible default namespace. Only meaningful when `records` is set.
   */
  recordsType?: string;
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
    /**
     * Scalar QualifiedValue properties on the MaterialStateType, one entry
     * per <dexpi:components property="X"><dexpi:object type="Core/QualifiedValue">
     * authored on the BPMN side. Canonical names declared on MaterialStateType
     * in Process.xml (MassFlow, VolumeFlow, ...) coexist here alongside
     * project-extension names (MoleFlow, etc.); the Profile generator declares
     * any non-canonical names at export time. No property is special-cased.
     */
    scalars?: { property: string; value: string; unit?: string }[];
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
