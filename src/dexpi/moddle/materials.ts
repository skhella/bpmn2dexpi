export interface MaterialComponent {
  uid: string;
  identifier: string;
  label: string;
  description?: string;
  type: 'PureMaterialComponent' | 'CustomMaterialComponent';
  chebiId?: string;
  iupacId?: string;
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
  componentRefs: Array<{ identifier: string; uidRef: string }>;
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
      fractions: number[];
    };
  };
  temperature?: { value: number; unit: string };
  pressure?: { value: number; unit: string };
  templateRef?: string;
  streamRef?: string;
  referencedByStreams?: string[]; // List of stream names/identifiers that reference this state
}
