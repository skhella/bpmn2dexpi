/**
 * Acceptance tests for the canonical Core/QualifiedValue serialization fix.
 *
 * Covers the "New tests" list from the issue:
 *   - canonical emit shape (nested AggregatedDataValue / PhysicalQuantity)
 *   - unit-string -> literal mapping incl. un_symbol / un_code
 *   - the degC -> DegreeCelsius case (degC unresolvable; DegreeCelsius / °C / CEL resolve)
 *   - the unmapped-unit fail-closed path (warn; never a flat <String> or guessed literal)
 *   - port NominalDirection -> Process/Enumerations.PortDirection.{Inlet,Outlet}
 *   - instrumentation-path convergence on the canonical shape
 *   - the property-name validator: flat Unit/UnitReference rejected, nested accepted
 *   - the data-type validator's DataReference target resolver (D9): bogus target rejected
 *
 * All resolution is schema-driven (Process.xml + Core.xml); nothing is hardcoded.
 */

import { describe, it, expect, beforeAll } from 'vitest';
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
import { validateEmittedDexpiXml } from '../DexpiPropertyNameValidator';
import { validateEmittedDexpiDataTypes } from '../DexpiDataTypeValidator';

const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');
const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');

const REGISTRY = DexpiProcessClassRegistry.fromXmlSources([
  { name: 'Process.xml', xml: PROCESS_XML },
  { name: 'Core.xml', xml: CORE_XML },
]);

const MODEL = (body: string) =>
  `<?xml version="1.0"?><Model name="x" uri="urn:t">` +
  `<Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>` +
  `<Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>` +
  `${body}</Model>`;

// ── Schema-driven unit resolution ───────────────────────────────────────────

describe('schema-driven unit resolution (Core.xml PhysicalQuantities)', () => {
  const TU = 'Core/PhysicalQuantities.TemperatureUnit';
  const MFR = 'Core/PhysicalQuantities.MassFlowRateUnit';
  const PCT = 'Core/PhysicalQuantities.PercentageUnit';

  it('resolves a unit by literal name', () => {
    expect(REGISTRY.resolveUnitLiteral(TU, 'DegreeCelsius')).toBe('DegreeCelsius');
    expect(REGISTRY.resolveUnitLiteral(MFR, 'KilogramPerHour')).toBe('KilogramPerHour');
    expect(REGISTRY.resolveUnitLiteral(PCT, 'Percent')).toBe('Percent');
  });

  it('resolves a unit by un_symbol and un_code (not just name)', () => {
    expect(REGISTRY.resolveUnitLiteral(TU, '°C')).toBe('DegreeCelsius');  // un_symbol
    expect(REGISTRY.resolveUnitLiteral(TU, 'CEL')).toBe('DegreeCelsius'); // un_code
    expect(REGISTRY.resolveUnitLiteral(TU, 'K')).toBe('Kelvin');          // un_symbol
  });

  it('does NOT resolve the non-canonical token degC (matches no schema field)', () => {
    // degC is neither the literal name (DegreeCelsius), un_symbol (°C),
    // un_code (CEL), nor rdl_label (DEGREE CELSIUS).
    expect(REGISTRY.resolveUnitLiteral(TU, 'degC')).toBeNull();
    expect(REGISTRY.resolveUnitLiteral(PCT, 'Fraction')).toBeNull();
  });

  it('binds each composition property to its PhysicalQuantity unit enum from the schema', () => {
    expect(REGISTRY.getUnitEnumRefForProperty('Stream', 'MassFlow')).toBe(MFR);
    expect(REGISTRY.getUnitEnumRefForProperty('ProcessStep', 'Temperature')).toBe(TU);
    expect(REGISTRY.getUnitEnumRefForProperty('Composition', 'MoleFractiona')).toBe(PCT);
  });
});

// ── Schema-driven enum reference paths ──────────────────────────────────────

describe('schema-driven enum reference paths', () => {
  it('derives qualifier reference paths from QualifiedValue declared types', () => {
    expect(REGISTRY.getEnumReferencePathForProperty('QualifiedValue', 'Provenance'))
      .toBe('Core/DataTypes.QuantityProvenance');
    expect(REGISTRY.getEnumReferencePathForProperty('QualifiedValue', 'Range'))
      .toBe('Core/DataTypes.QuantityRange');
    expect(REGISTRY.getEnumReferencePathForProperty('QualifiedValue', 'Scope'))
      .toBe('Core/DataTypes.Scope');
  });

  it('derives the port NominalDirection path from Process.xml', () => {
    expect(REGISTRY.getEnumReferencePathForProperty('MaterialPort', 'NominalDirection'))
      .toBe('Process/Enumerations.PortDirection');
    expect(REGISTRY.getQualifiedEnumLiterals('Process/Enumerations.PortDirection'))
      .toEqual(['Inlet', 'Outlet']);
  });
});

// ── Property-name validator: flat rejected, nested accepted (criterion 4) ────

describe('property-name validator — flat Unit rejected, nested PhysicalQuantity accepted', () => {
  it('rejects a flat Unit directly on a Core/QualifiedValue', () => {
    const xml = MODEL(
      `<Object type="Core/QualifiedValue">` +
      `<Data property="DisplayText"><String>x</String></Data>` +
      `<Data property="Unit"><DataReference data="Core/PhysicalQuantities.TemperatureUnit.Kelvin"/></Data>` +
      `</Object>`);
    const failures = validateEmittedDexpiXml(xml, 't', REGISTRY);
    expect(failures.map(f => `${f.className}.${f.propertyName}`)).toContain('QualifiedValue.Unit');
  });

  it('rejects a flat UnitReference on a Core/QualifiedValue', () => {
    const xml = MODEL(
      `<Object type="Core/QualifiedValue"><Data property="UnitReference"><String>abc://u</String></Data></Object>`);
    const failures = validateEmittedDexpiXml(xml, 't', REGISTRY);
    expect(failures.map(f => `${f.className}.${f.propertyName}`)).toContain('QualifiedValue.UnitReference');
  });

  it('accepts Unit nested inside a PhysicalQuantity AggregatedDataValue', () => {
    const xml = MODEL(
      `<Object type="Core/QualifiedValue">` +
      `<Data property="DisplayText"><String>x</String></Data>` +
      `<Data property="Value">` +
      `<AggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity">` +
      `<Data property="Unit"><DataReference data="Core/PhysicalQuantities.TemperatureUnit.Kelvin"/></Data>` +
      `<Data property="Value"><Double>230.2</Double></Data>` +
      `</AggregatedDataValue></Data></Object>`);
    expect(validateEmittedDexpiXml(xml, 't', REGISTRY)).toEqual([]);
  });
});

// ── Data-type validator DataReference target resolver (D9) ───────────────────

describe('data-type validator — DataReference target resolution (D9)', () => {
  it('rejects a deliberately bogus enum namespace (Core/Enumerations.*)', () => {
    const xml = MODEL(
      `<Object type="Core/QualifiedValue"><Data property="Provenance">` +
      `<DataReference data="Core/Enumerations.Provenance.Observed"/></Data></Object>`);
    const failures = validateEmittedDexpiDataTypes(xml, 't', REGISTRY);
    expect(failures).toHaveLength(1);
    expect(failures[0].context).toContain('does not exist in the imported models');
  });

  it('rejects a bogus enum name (PortDirectionClassification) and a bogus literal', () => {
    const bogusEnum = MODEL(
      `<Object id="p" type="Process/Process.MaterialPort"><Data property="NominalDirection">` +
      `<DataReference data="Process/Enumerations.PortDirectionClassification.In"/></Data></Object>`);
    expect(validateEmittedDexpiDataTypes(bogusEnum, 't', REGISTRY)).toHaveLength(1);

    const bogusLiteral = MODEL(
      `<Object id="p" type="Process/Process.MaterialPort"><Data property="NominalDirection">` +
      `<DataReference data="Process/Enumerations.PortDirection.Sideways"/></Data></Object>`);
    const f = validateEmittedDexpiDataTypes(bogusLiteral, 't', REGISTRY);
    expect(f).toHaveLength(1);
    expect(f[0].context).toContain('is not a member of');
  });

  it('accepts real enum DataReference targets', () => {
    const xml = MODEL(
      `<Object type="Core/QualifiedValue">` +
      `<Data property="Provenance"><DataReference data="Core/DataTypes.QuantityProvenance.Observed"/></Data>` +
      `<Data property="Range"><DataReference data="Core/DataTypes.QuantityRange.Nominal"/></Data>` +
      `</Object>`);
    expect(validateEmittedDexpiDataTypes(xml, 't', REGISTRY)).toEqual([]);
  });

  it('rejects an enum reference whose model prefix is not imported', () => {
    const xml = MODEL(
      `<Object type="Core/QualifiedValue"><Data property="Provenance">` +
      `<DataReference data="Nope/DataTypes.QuantityProvenance.Observed"/></Data></Object>`);
    const f = validateEmittedDexpiDataTypes(xml, 't', REGISTRY);
    expect(f).toHaveLength(1);
    expect(f[0].context).toContain('is not a declared <Import>');
  });
});

// ── Canonical emit on the TEP fixture ───────────────────────────────────────

describe('TEP canonical QualifiedValue emit', () => {
  let out: string;
  let warnings: readonly string[];

  beforeAll(async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const t = new BpmnToDexpiTransformer();
    out = await t.transform(bpmn, { processXml: PROCESS_XML, coreXml: CORE_XML });
    warnings = t.logger.warnings;
  });

  const count = (re: RegExp) => (out.match(re) ?? []).length;

  it('nests a unit-bearing value in an AggregatedDataValue PhysicalQuantity with a unit DataReference', () => {
    expect(out).toContain('<AggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity">');
    expect(out).toContain('<DataReference data="Core/PhysicalQuantities.MassFlowRateUnit.KilogramPerHour"/>');
    // The temperature unit resolves to the canonical literal (fixture: DegreeCelsius).
    expect(out).toContain('<DataReference data="Core/PhysicalQuantities.TemperatureUnit.DegreeCelsius"/>');
  });

  it('emits fraction vectors as a PhysicalQuantityVector with a PercentageUnit reference', () => {
    expect(out).toContain('<AggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantityVector">');
    expect(out).toContain('<DataReference data="Core/PhysicalQuantities.PercentageUnit.Percent"/>');
    expect(count(/<Data property="Values"/g)).toBe(88); // 11 compositions × 8 components
  });

  it('never emits a flat <String> Unit/UnitReference on a QualifiedValue', () => {
    // Every Unit is a nested DataReference; no flat string units, no UnitReference.
    expect(out).not.toMatch(/<Data property="Unit">\s*<String>/);
    expect(out).not.toContain('property="UnitReference"');
  });

  it('emits qualifiers + port direction as DataReferences to the real schema enums', () => {
    expect(out).toContain('<DataReference data="Core/DataTypes.QuantityProvenance.');
    expect(out).toContain('<DataReference data="Core/DataTypes.QuantityRange.Nominal"/>');
    expect(out).toContain('<DataReference data="Process/Enumerations.PortDirection.Inlet"/>');
    expect(out).toContain('<DataReference data="Process/Enumerations.PortDirection.Outlet"/>');
    // The stale targets are gone entirely.
    expect(out).not.toContain('Core/Enumerations.');
    expect(out).not.toContain('PortDirectionClassification');
  });

  it('converges the instrumentation path on the canonical form (Provenance via Core/DataTypes)', () => {
    // Every instrumentation slot uses the same canonical qualifier references.
    expect(count(/Core\/DataTypes\.QuantityProvenance\.Observed/g)).toBe(19);
  });

  it('fails closed on the unrepresentable MoleFlow unit (warn; no flat String, no guessed literal)', () => {
    const moleFlowWarn = warnings.filter(w => w.includes('MoleFlow') && w.includes('KilomolePerHour'));
    expect(moleFlowWarn.length).toBeGreaterThan(0);
    expect(moleFlowWarn[0]).toContain('fail-closed');
    // No invented MoleFlowRateUnit literal for KilomolePerHour anywhere.
    expect(out).not.toContain('MoleFlowRateUnit.KilomolePerHour');
  });

  it('validates against the DEXPI 2.0 envelope (no Unit/qualifier regressions)', () => {
    // Property-name + data-type tiers clean against Process+Core (no Profile):
    // the canonical QualifiedValue shape itself introduces no findings.
    const nameFailures = validateEmittedDexpiXml(out, 'tep', REGISTRY)
      .filter(f => f.className === 'QualifiedValue' || f.className === 'PhysicalQuantity' || f.className === 'PhysicalQuantityVector');
    expect(nameFailures).toEqual([]);
    expect(validateEmittedDexpiDataTypes(out, 'tep', REGISTRY)).toEqual([]);
  });

  it('round-trips values, units and qualifiers (re-reads the canonical output)', () => {
    // There is no separate DEXPI-XML importer; "round-trip" here means a
    // consumer can read every authored value/unit/qualifier back out of the
    // canonical output in machine-resolvable form. Parse the emitted XML and
    // verify every unit-bearing MassFlow QualifiedValue exposes a numeric
    // value, a unit that resolves to a real MassFlowRateUnit literal, and
    // valid qualifier references.
    const doc = new DOMParser().parseFromString(out, 'text/xml');
    const massFlowCarriers = Array.from(doc.getElementsByTagName('Components'))
      .filter(c => c.getAttribute('property') === 'MassFlow');
    let unitBearing = 0;
    for (const carrier of massFlowCarriers) {
      const qv = carrier.querySelector(':scope > Object[type="Core/QualifiedValue"]');
      if (!qv) continue;
      const pq = qv.querySelector('AggregatedDataValue[type="Core/PhysicalQuantities.PhysicalQuantity"]');
      if (!pq) continue; // value-less instrumentation slot — skip
      unitBearing++;

      // Unit → resolves to a real MassFlowRateUnit literal.
      const unitData = pq.getAttribute('data')
        ?? pq.querySelector('Data[property="Unit"] DataReference')?.getAttribute('data') ?? '';
      const lastDot = unitData.lastIndexOf('.');
      const enumPath = unitData.slice(0, lastDot);
      const literal = unitData.slice(lastDot + 1);
      expect(REGISTRY.getQualifiedEnumLiterals(enumPath)).toContain(literal);

      // Value → a finite number.
      const valueText = pq.querySelector('Data[property="Value"] Double')?.textContent ?? '';
      expect(Number.isFinite(parseFloat(valueText))).toBe(true);

      // Qualifiers, when present, are valid DataReference targets.
      for (const q of ['Provenance', 'Range', 'Scope']) {
        const qData = qv.querySelector(`:scope > Data[property="${q}"] DataReference`)?.getAttribute('data');
        if (!qData) continue;
        const qDot = qData.lastIndexOf('.');
        expect(REGISTRY.getQualifiedEnumLiterals(qData.slice(0, qDot))).toContain(qData.slice(qDot + 1));
      }
    }
    expect(unitBearing).toBeGreaterThan(0);
  });
});
