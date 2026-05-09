import dexpiDescriptor from './dexpi.json';

/**
 * The dexpi.json moddle declares four DEXPI *carrier* types — Data,
 * References, Components, Object — that serialize (per the file's
 * `tagAlias: lowerCase`) as `<dexpi:data property="X">v</dexpi:data>`,
 * `<dexpi:references property="X" uidRef="..."/>`, and so on.
 *
 * They mirror the carrier elements DEXPI's standalone Process XML uses
 * (`<Data>`, `<References>`, `<Components>`, `<Object>`) and let property
 * kind (DataProperty / ReferenceProperty / CompositionProperty) be
 * recorded EXPLICITLY at write time rather than inferred from element
 * shape at read time — which is what the validator's
 * inferKindFromBpmnElement() heuristic does for legacy bare-name content.
 *
 * Using the `dexpi:` prefix is required by BPMN 2.0's `tExtensionElements
 * xsd:any namespace="##other"` rule. Under the strict reading of `##other`
 * (W3C XSD 1.1, which excludes both the target namespace and the absent
 * namespace), unprefixed elements inside `<bpmn:extensionElements>` are
 * not BPMN 2.0 compliant. Wire-form differs from DEXPI Process XSD only
 * by this namespace prefix; semantics are identical.
 *
 * If DEXPI publishes a canonical Profile / extension namespace, migration
 * is a single-attribute change in dexpi.json.
 */
export default dexpiDescriptor;

export interface DexpiElement {
  dexpiType?: string;
  /** Optional URI referencing an external RDL (ISO 15926, OntoCAPE, company ontology).
   *  Used when dexpiType is not a standard DEXPI 2.0 Process class.
   *  Example: customUri="https://data.15926.org/rdl/R1234" */
  customUri?: string;
  /**
   * For Custom (non-registry) dexpiType values: the user-chosen DEXPI parent
   * class that the custom class extends. Picked from the registry dropdown
   * in the panel (Process + Core + already-loaded Profiles). Consumed by the
   * Profile generator when emitting <ConcreteClass superTypes="..."/> for
   * the custom class. When empty, the generator falls back to
   * Core/ConceptualObject — the most permissive root.
   */
  customSuperType?: string;
  identifier?: string;
  uid?: string;
  hierarchyLevel?: string;
  ports?: DexpiPort[];
  attributes?: Array<{ name: string; value: string }>;
}

export interface DexpiPort {
  portId: string;
  name: string;
  /**
   * Human-readable label for the port. Carries the semantic identity of what
   * flows through the port (e.g. "Temperature" for an IPO_Temperature port).
   * Used by the transformer to match ports to InformationFlows / SequenceFlows
   * by name when multiple same-direction ports exist.
   */
  label?: string;
  /**
   * Explicit link to a port at the more-detailed hierarchy level (DEXPI SubReference).
   * Set on subprocess boundary ports. When present, used directly instead of
   * name+direction inference. Value is the portId of the child boundary port.
   */
  subReference?: string;
  /**
   * Explicit back-link to a port at a coarser hierarchy level (DEXPI SuperReference).
   * Set on proxy-event ports. Value is the portId of the parent subprocess port.
   */
  superReference?: string;
  portType: 'MaterialPort' | 'InformationPort' | 'ThermalEnergyPort' | 'MechanicalEnergyPort' | 'ElectricalEnergyPort';
  direction: 'Inlet' | 'Outlet';
  anchorSide?: 'top' | 'right' | 'bottom' | 'left';
  anchorOffset?: number;
  anchorX?: number;
  anchorY?: number;
  /**
   * Port-level DEXPI attributes authored via the panel's PortAttributesSection.
   * Reuses the same StreamAttribute shape that ProcessStep / Stream attributes
   * use, since the read+emit path is identical (canonical-carrier
   * `<dexpi:data>` / `<dexpi:components>` carriers on the port element,
   * dispatched to flat Data or QualifiedValue Object on emit).
   *
   * Optional and absent on most TEP / fixture ports — ports historically
   * carried only connection metadata. Populated when the user authors
   * Identifier / Label / PersistentIdentifiers / MaterialTemplateReference
   * etc. via the per-port attribute editor.
   */
  attributes?: Array<{
    name: string;
    value: string;
    unit?: string;
    unitUri?: string;
    nameUri?: string;
    scope?: string;
    range?: string;
    provenance?: string;
    qualifier?: string;
    required?: boolean;
  }>;
}

export interface DexpiStream {
  identifier?: string;
  name?: string;
  streamType?: 'MaterialFlow' | 'EnergyFlow' | 'ThermalEnergyFlow' | 'MechanicalEnergyFlow' | 'ElectricalEnergyFlow' | 'InformationFlow';
  /**
   * Legacy port reference — short suffix form (e.g. "MO1_port"). The reader
   * combines this with the BPMN sequenceFlow's sourceRef/targetRef to
   * reconstruct the full port id. Brittle when a host BPMN tool renumbers
   * BPMN element ids without touching foreign-extension content
   * (the suffix and the BPMN sourceRef drift apart). Kept for
   * backward compatibility with files written before sourcePortId was added.
   */
  sourcePortRef?: string;
  targetPortRef?: string;
  /**
   * Preferred port reference — full port id, self-contained inside the
   * dexpi extension. Robust to host-tool BPMN element renumbering because
   * both the port's id attribute and this reference live inside foreign
   * extensions, which a compliant tool preserves verbatim. New writes
   * use these fields; reads accept either form.
   */
  sourcePortId?: string;
  targetPortId?: string;
  templateReference?: string;
  materialStateReference?: string;
  provenance?: 'Measured' | 'Calculated' | 'Specified' | 'Estimated';
  range?: 'Design' | 'Normal' | 'Maximum' | 'Minimum';
  attributes?: DexpiAttribute[];
}

/**
 * Unified attribute payload — used for both step (`<dexpi:Attribute>`
 * inside `<dexpi:Element>`) and stream (`<dexpi:Attribute>` inside
 * `<dexpi:Stream>`) properties. DEXPI Process.xml itself has no
 * Attribute/StreamAttribute distinction; both encode as
 * `<Components property="X"><Object type="Core/QualifiedValue"/></Components>`.
 */
export interface DexpiAttribute {
  name: string;
  value: string;
  unit?: string;
  unitUri?: string;
  nameUri?: string;
  scope?: string;
  range?: string;
  provenance?: string;
  mode?: 'Input' | 'Output' | 'InOut';
  qualifier?: string;
  /**
   * User-asserted required-cardinality flag for the generated Profile.
   * When true, the Profile generator emits `lower="1"` for the property
   * named `name` on the wrapping Object's class — narrowing DEXPI's
   * default `lower="0"`. The generator enforces narrow-only semantics:
   *   • DEXPI lower=0 → user lower=1 : allowed (with a "narrowing" warning)
   *   • DEXPI lower=1 → user lower=0 : blocked (cannot loosen DEXPI)
   * Defaults to `false` (or omitted) — purely opt-in.
   */
  required?: boolean;
}

/** @deprecated Use DexpiAttribute. Kept for back-compat with older callers. */
export type DexpiStreamAttribute = DexpiAttribute;

export interface DexpiInformationFlow {
  identifier?: string;
  name?: string;
  dataObjectRef?: string;
  sourceRef?: string;
  targetRef?: string;
}

export interface DexpiMaterialTemplate {
  identifier?: string;
  name?: string;
  uid?: string;
  componentList?: DexpiComponent[];
}

export interface DexpiComponent {
  name: string;
  casNumber?: string;
  fraction?: number;
}

export interface DexpiMaterialState {
  identifier?: string;
  name?: string;
  uid?: string;
  templateRef?: string;
  provenance?: 'Measured' | 'Calculated' | 'Specified' | 'Estimated';
  range?: 'Design' | 'Normal' | 'Maximum' | 'Minimum';
  properties?: DexpiStateProperty[];
}

export interface DexpiStateProperty {
  name: string;
  value: string;
  unit?: string;
}
