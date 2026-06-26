/**
 * Data-type validator — unit tests.
 *
 * Covers the third tier of fidelity validation: value-level conformance to
 * the DEXPI 2.0 information model's declared data types (Builtin
 * primitives + Enumerations).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html>');
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
  Document: dom.window.Document,
  Element: dom.window.Element,
});

import { DexpiProcessClassRegistry } from '../DexpiProcessClassRegistry';
import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';
import { validateEmittedDexpiDataTypes } from '../DexpiDataTypeValidator';

const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');
const REGISTRY = DexpiProcessClassRegistry.fromXmlSources([
  { name: 'Process.xml', xml: PROCESS_XML },
  { name: 'Core.xml', xml: CORE_XML },
]);

describe('Registry — enumeration loading', () => {
  it('parses Enumeration declarations from Process.xml + Core.xml', () => {
    expect(REGISTRY.enumerationCount).toBeGreaterThan(50); // Core has 48, Process has 14
    // Spot-check a known enumeration:
    const provenance = REGISTRY.getEnumerationLiterals('QuantityProvenance');
    expect(provenance).toBeDefined();
    expect(provenance).toContain('Calculated');
    expect(provenance).toContain('Estimated');
    expect(provenance).toContain('Specified');
  });

  it('returns undefined for unknown enumerations', () => {
    expect(REGISTRY.getEnumerationLiterals('NotAnEnum')).toBeUndefined();
  });

  it('returns a defensive copy of literals (mutation does not affect registry)', () => {
    const a = REGISTRY.getEnumerationLiterals('QuantityProvenance')!;
    a.push('FORGED');
    const b = REGISTRY.getEnumerationLiterals('QuantityProvenance')!;
    expect(b).not.toContain('FORGED');
  });
});

describe('Data-type validator — Builtin types', () => {
  function makeXml(propertyName: string, value: string, classRef = 'Core/QualifiedValue'): string {
    return `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="o1" type="${classRef}">
        <Data property="${propertyName}">${value}</Data>
      </Object>
    </Model>`;
  }

  // Value is typed Builtin/Double on the PhysicalQuantity AggregatedDataType
  // (the canonical carrier of a unit-bearing value). On a bare QualifiedValue,
  // Value is the loose /QualifiedValue.Type union and is intentionally not
  // type-checked here. So the Double conformance checks run against
  // PhysicalQuantity, matching the canonical nested output shape.
  it('accepts a valid Double value (Value on PhysicalQuantity)', () => {
    const failures = validateEmittedDexpiDataTypes(
      makeXml('Value', '42.5', 'Core/PhysicalQuantities.PhysicalQuantity'), 'unit', REGISTRY,
    );
    expect(failures).toEqual([]);
  });

  it('rejects a non-numeric Value (Value on PhysicalQuantity)', () => {
    const failures = validateEmittedDexpiDataTypes(
      makeXml('Value', 'notanumber', 'Core/PhysicalQuantities.PhysicalQuantity'), 'unit', REGISTRY,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].declaredType).toBe('Builtin/Double');
    expect(failures[0].actualValue).toBe('notanumber');
  });

  it('accepts a String value (Unit on QualifiedValue)', () => {
    const failures = validateEmittedDexpiDataTypes(
      makeXml('Unit', 'KilogramPerHour'), 'unit', REGISTRY,
    );
    expect(failures).toEqual([]);
  });

  it('skips empty values (placeholders are permitted)', () => {
    const failures = validateEmittedDexpiDataTypes(
      makeXml('Value', ''), 'unit', REGISTRY,
    );
    expect(failures).toEqual([]);
  });
});

describe('Data-type validator — Enumeration types', () => {
  function makeQvXml(propertyName: string, value: string): string {
    return `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="o1" type="Core/QualifiedValue">
        <Data property="${propertyName}">${value}</Data>
      </Object>
    </Model>`;
  }

  it('accepts a valid Provenance literal', () => {
    const failures = validateEmittedDexpiDataTypes(
      makeQvXml('Provenance', 'Estimated'), 'unit', REGISTRY,
    );
    expect(failures).toEqual([]);
  });

  it('rejects a typoed Provenance value', () => {
    const failures = validateEmittedDexpiDataTypes(
      makeQvXml('Provenance', 'Estimted'), 'unit', REGISTRY,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].propertyName).toBe('Provenance');
    expect(failures[0].declaredType).toContain('QuantityProvenance');
    expect(failures[0].actualValue).toBe('Estimted');
  });

  it('accepts a valid Range literal', () => {
    const failures = validateEmittedDexpiDataTypes(
      makeQvXml('Range', 'Nominal'), 'unit', REGISTRY,
    );
    expect(failures).toEqual([]);
  });

  it('rejects a Range value that does not exist in QuantityRange enum', () => {
    const failures = validateEmittedDexpiDataTypes(
      makeQvXml('Range', 'NotAnRange'), 'unit', REGISTRY,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].propertyName).toBe('Range');
  });
});

describe('Data-type validator — TEP fixture (regression)', () => {
  it('TEP emission has no data-type violations beyond the authored MoleFlow unit gap', { timeout: 15_000 }, async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(bpmn);
    const failures = validateEmittedDexpiDataTypes(out, 'TEP→DEXPI', REGISTRY);
    // The ONLY expected data-type findings are the authored MoleFlow unit
    // (KilomolePerHour, not yet a MoleFlowRateUnit literal) — a genuine
    // vocabulary gap the emitter surfaces (Design B) and the Profile extension
    // closes, exactly like a missing property. Everything else must be clean.
    const structural = failures.filter(f => !JSON.stringify(f).includes('KilomolePerHour'));
    if (structural.length > 0) {
      // Surface the first few for diagnosis
      console.error('Unexpected data-type failures:', JSON.stringify(structural.slice(0, 5), null, 2));
    }
    expect(structural).toEqual([]);
    // And the MoleFlow gap IS surfaced (not silently dropped).
    expect(failures.some(f => JSON.stringify(f).includes('KilomolePerHour'))).toBe(true);
  });
});

describe('Data-type validator — out-of-scope types', () => {
  it('skips properties whose target is a class reference (not a Builtin or Enum)', () => {
    // Composition.MoleFractiona uses a CompositionProperty target — the
    // <Data> inside its inner QualifiedValue Object would still be checked
    // (Value/Values/Unit handled), but a top-level <Data property="X"> on
    // Composition itself with a class-typed declared targetType would be
    // out of scope.
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="o1" type="Process/Process.MaterialStateType">
        <Data property="Identifier">whatever</Data>
      </Object>
    </Model>`;
    // Identifier is Builtin/String — anything passes.
    expect(validateEmittedDexpiDataTypes(xml, 'unit', REGISTRY)).toEqual([]);
  });

  it('skips classes not in the registry', () => {
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="o1" type="Process/Process.NotAClass">
        <Data property="SomeProp">anything</Data>
      </Object>
    </Model>`;
    expect(validateEmittedDexpiDataTypes(xml, 'unit', REGISTRY)).toEqual([]);
  });
});
