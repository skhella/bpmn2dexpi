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
  
  Scope: ['Alarm', 'Allowable', 'Design', 'Expected', 'Incidental', 'Operating', 'Protection', 'Rated', 'Test', 'Warning'],
  
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
  
  Provenance: ['Set', 'Specified', 'Estimated', 'Calculated', 'Observed'],
  
  PumpingMethod: [
    'CentrifugalMotion',
    'CustomMethod',
    'Eductor',
    'PositiveDisplacement',
    'RotaryMotion',
    'Unspecified'
  ],
  
  Range: ['Actual', 'Average', 'LowerLimit', 'Nominal', 'Normal', 'UpperLimit'],
  
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

export type EnumerationKey = keyof typeof DexpiEnumerations;

// Helper to get enum values
export function getEnumValues(enumName: EnumerationKey): readonly string[] {
  return DexpiEnumerations[enumName];
}

// Helper to check if a value is valid for an enum
export function isValidEnumValue(enumName: EnumerationKey, value: string): boolean {
  return (DexpiEnumerations[enumName] as readonly string[]).includes(value);
}
