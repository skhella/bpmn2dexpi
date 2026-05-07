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
