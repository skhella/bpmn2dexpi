import dexpiDescriptor from './dexpi.json';

export default dexpiDescriptor;

export interface DexpiElement {
  dexpiType?: string;
  /** Optional URI referencing an external RDL (ISO 15926, OntoCAPE, company ontology).
   *  Used when dexpiType is not a standard DEXPI 2.0 Process class.
   *  Example: customUri="https://data.15926.org/rdl/R1234" */
  customUri?: string;
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
  type: 'MaterialPort' | 'InformationPort' | 'ThermalEnergyPort' | 'MechanicalEnergyPort' | 'ElectricalEnergyPort';
  portType?: string; // legacy alias — use type
  direction: 'Inlet' | 'Outlet';
  anchorSide?: 'top' | 'right' | 'bottom' | 'left';
  anchorOffset?: number;
  anchorX?: number;
  anchorY?: number;
}

export interface DexpiStream {
  identifier?: string;
  name?: string;
  streamType?: 'MaterialFlow' | 'EnergyFlow' | 'ThermalEnergyFlow' | 'MechanicalEnergyFlow' | 'ElectricalEnergyFlow' | 'InformationFlow';
  sourcePortRef?: string;
  targetPortRef?: string;
  templateReference?: string;
  materialStateReference?: string;
  provenance?: 'Measured' | 'Calculated' | 'Specified' | 'Estimated';
  range?: 'Design' | 'Normal' | 'Maximum' | 'Minimum';
  attributes?: DexpiStreamAttribute[];
}

export interface DexpiStreamAttribute {
  name: string;
  value: string;
  unit?: string;
  mode?: 'Input' | 'Output' | 'InOut';
  qualifier?: string;
}

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
