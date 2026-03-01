import dexpiDescriptor from './dexpi.json';

export default dexpiDescriptor;

export interface DexpiElement {
  dexpiType?: string;
  identifier?: string;
  uid?: string;
  hierarchyLevel?: string;
  ports?: DexpiPort[];
  attributes?: Array<{ name: string; value: string }>;
}

export interface DexpiPort {
  portId: string;
  name: string;
  portType: 'MaterialPort' | 'InformationPort' | 'ThermalEnergyPort' | 'MechanicalEnergyPort' | 'ElectricalEnergyPort';
  direction: 'Inlet' | 'Outlet';
  anchorSide?: 'top' | 'right' | 'bottom' | 'left';
  anchorOffset?: number;
  anchorX?: number;
  anchorY?: number;
}

export interface DexpiStream {
  identifier?: string;
  name?: string;
  streamType?: 'MaterialFlow' | 'EnergyFlow';
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
