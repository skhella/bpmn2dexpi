// DEXPI Process Schema Enumerations
// Auto-generated from Process.xml schema

export const DexpiEnumerations = {
  CompositionBasis: ['Mass', 'Mole'],
  
  CompositionDisplay: ['AbsoluteValue', 'Fraction', 'Percent'],
  
  CompressionMethod: [
    'AxialMotion',
    'Blower',
    'CentrifugalMotion',
    'CustomMethod',
    'Ejector',
    'Fan',
    'ReciprocatingMotion',
    'RotaryMotion',
    'Unspecified'
  ],
  
  EngineDriveMethod: ['Diesel', 'GasTurbine', 'OttoCycle', 'Unspecified'],
  
  HeatExchangeMethod: ['Generic', 'Plate', 'Spiral', 'Tubular'],
  
  InformationVariantType: ['Boolean', 'Double', 'Integer'],
  
  MeasuredQuantity: [
    'AudioVisual',
    'Density',
    'ElectricCurrent',
    'ElectricPotential',
    'ElectromagneticField',
    'Energy',
    'Flow',
    'Humidity',
    'Level',
    'MultipleQuantities',
    'NumberOfEvents',
    'Power',
    'Pressure',
    'PressureDifference',
    'Quality',
    'Radiation',
    'SpatialDimension',
    'Time',
    'Velocity',
    'VibrationOrTorque',
    'WeightMassForce'
  ],
  
  MotorDriveMethod: [
    'AlternatingCurrent',
    'DirectCurrent',
    'StepperMotor',
    'Unspecified'
  ],
  
  PortDirection: ['Inlet', 'Outlet'],
  
  ProcessStepHierarchyLevel: [
    'ControlFunction',
    'ElementaryFunction',
    'Process',
    'ProcessSection',
    'ProcessTrain',
    'SafetyFunction',
    'SupportFunction',
    'UnitOperation'
  ],
  
  PumpingMethod: [
    'CentrifugalMotion',
    'CustomMethod',
    'Eductor',
    'PositiveDisplacement',
    'RotaryMotion',
    'Unspecified'
  ],
  
  ReactionProcessType: [
    'FluidizedBed',
    'PackedBed',
    'Tank',
    'Tubular',
    'Unspecified'
  ],
  
  TrayRole: ['Bottom', 'Feed', 'Monitored', 'Top'],
  
  TurbineDriveMethod: ['Expander', 'Unspecified', 'WaterTurbine', 'WindTurbine']
} as const;

// ProcessStep types from DEXPI schema
export const ProcessStepTypes = [
  'ProcessStep',
  
  // Main categories
  'Emitting',
  'ExchangingThermalEnergy',
  'Flaring',
  'FormingSolidMaterial',
  'GeneratingFlow',
  'IncreasingParticleSize',
  'Mixing',
  'Packaging',
  'ReactingChemicals',
  'ReducingParticleSize',
  'RemovingThermalEnergy',
  'Separating',
  'Sink',
  'Source',
  'SupplyingElectricalEnergy',
  'SupplyingFluids',
  'SupplyingMechanicalEnergy',
  'SupplyingSolids',
  'SupplyingThermalEnergy',
  'TransportingElectricalEnergy',
  'TransportingFluids',
  'TransportingSolids',
  
  // GeneratingFlow subtypes
  'Compressing',
  'Pumping',
  
  // IncreasingParticleSize subtypes
  'Agglomerating',
  'Coalescing',
  'Crystallizing',
  'Flocculating',
  
  // ReducingParticleSize subtypes
  'Crushing',
  'Cutting',
  'Grinding',
  'Milling',
  
  // Separating subtypes
  'SeparatingByCentrifugalForce',
  'SeparatingByContact',
  'SeparatingByCyclonicMotion',
  'SeparatingByElectromagneticForce',
  'SeparatingByElectrostaticForce',
  'SeparatingByFlash',
  'SeparatingByGravity',
  'SeparatingByIonExchange',
  'SeparatingByMagneticForce',
  'SeparatingByPhaseSeparation',
  'SeparatingByPhysicalProcess',
  'SeparatingBySurfaceTension',
  'SeparatingByThermalProcess',
  'SeparatingMechanically',
  
  // SeparatingByPhysicalProcess subtypes
  'Absorbing',
  'Adsorbing',
  'SeparatingByContact',
  'SeparatingByIonExchange',
  'SeparatingBySurfaceTension',
  
  // SeparatingByThermalProcess subtypes
  'Distilling',
  'Drying',
  'Evaporating',
  
  // SeparatingMechanically subtypes
  'Filtering',
  'Sieving',
  'Skimming'
] as const;

export type ProcessStepType = typeof ProcessStepTypes[number];

// InstrumentationActivity types from DEXPI schema
export const InstrumentationActivityTypes = [
  'InstrumentationActivity',
  
  // Main types
  'CalculatingProcessVariable',
  'ControllingProcessVariable',
  'ConveyingSignal',
  'MeasuringProcessVariable',
  
  // CalculatingProcessVariable subtypes
  'CalculatingRatio',
  'CalculatingSplitRange',
  'TransformingProcessVariable'
] as const;

export type InstrumentationActivityType = typeof InstrumentationActivityTypes[number];

export type EnumerationKey = keyof typeof DexpiEnumerations;

// Helper to get enum values
export function getEnumValues(enumName: EnumerationKey): readonly string[] {
  return DexpiEnumerations[enumName];
}

// Helper to check if a value is valid for an enum
export function isValidEnumValue(enumName: EnumerationKey, value: string): boolean {
  return DexpiEnumerations[enumName].includes(value as any);
}
