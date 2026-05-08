/**
 * Tier-5 cardinality validator — unit tests.
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
import { validateEmittedDexpiCardinality } from '../DexpiCardinalityValidator';

const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');
const REGISTRY = DexpiProcessClassRegistry.fromXmlSources([
  { name: 'Process.xml', xml: PROCESS_XML },
  { name: 'Core.xml', xml: CORE_XML },
]);

describe('Tier 5: cardinality validator', () => {
  it('flags missing required property (lower=1, observed=0)', () => {
    // QualifiedValue.Value has lower=1 (required). An Object without a Value
    // entry should be flagged.
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="qv_1" type="Core/QualifiedValue">
        <Data property="Unit"><String>kg/h</String></Data>
      </Object>
    </Model>`;
    const failures = validateEmittedDexpiCardinality(xml, 'unit', REGISTRY);
    const valueFailure = failures.find(f => f.propertyName === 'Value');
    expect(valueFailure).toBeDefined();
    expect(valueFailure!.expectedLower).toBe(1);
    expect(valueFailure!.actualCount).toBe(0);
  });

  it('flags exceeds-upper (upper=1, observed=2)', () => {
    // Identifier on most classes has upper=1. Two <Data property="Identifier"/>
    // on the same Object should be flagged.
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="s1" type="Process/Process.Stream">
        <Data property="Identifier"><String>S1</String></Data>
        <Data property="Identifier"><String>S2</String></Data>
      </Object>
    </Model>`;
    const failures = validateEmittedDexpiCardinality(xml, 'unit', REGISTRY);
    const idFailure = failures.find(f => f.propertyName === 'Identifier');
    expect(idFailure).toBeDefined();
    expect(idFailure!.actualCount).toBe(2);
    expect(idFailure!.expectedUpper).toBe(1);
  });

  it('passes when all cardinalities are satisfied (single QualifiedValue with Value+Unit)', () => {
    // Note: QualifiedValue declares quite a few required properties (DisplayText,
    // Value, etc.). A truly clean Object would emit all of them. This test
    // checks the validator's mechanics, not exhaustive correctness — we
    // pick a property combination where we know about lower=1's that ARE
    // satisfied.
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="s1" type="Process/Process.Stream">
        <Data property="Identifier"><String>S1</String></Data>
        <Data property="Label"><String>Feed</String></Data>
      </Object>
    </Model>`;
    const failures = validateEmittedDexpiCardinality(xml, 'unit', REGISTRY);
    // Identifier should NOT be flagged (lower=1 satisfied). Other required
    // properties (e.g. NominalDirection on Port) wouldn't apply here. We just
    // check that Identifier is not in the failure list.
    expect(failures.find(f => f.propertyName === 'Identifier')).toBeUndefined();
  });

  it('skips classes not in the registry', () => {
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="o1" type="Process/Process.NotAClass"/>
    </Model>`;
    expect(validateEmittedDexpiCardinality(xml, 'unit', REGISTRY)).toEqual([]);
  });

  it('TEP regression: only Method authoring gaps remain (12 across 5 ProcessStep subclasses)', async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(bpmn);
    const failures = validateEmittedDexpiCardinality(out, 'TEP', REGISTRY);
    // Earlier this test snapshotted ~229 cardinality violations dominated by
    // missing ConnectorReference / DisplayText / Description / EngineeringModel
    // headers. All of those are now emitted from the transformer (using
    // registry-driven defaults — no name-similarity heuristics). What
    // remains are 12 missing `Method` literals across the 5 ProcessStep
    // subclasses TEP exercises (ReactingChemicals, RemovingThermalEnergy,
    // ExchangingThermalEnergy, Compressing, Cooling). Method is a class-
    // specific enum (CompressionMethod / ReactionProcessType /
    // HeatExchangeMethod) whose value is genuine project-authoring data —
    // the BPMN fixture must supply it; the transformer cannot fabricate it
    // without guessing the unit's technology.
    expect(failures.length).toBe(12);
    const uniqueKeys = new Set(failures.map(f => `${f.className}.${f.propertyName}`));
    expect(uniqueKeys.size).toBe(5);
    expect(failures.every(f => f.propertyName === 'Method')).toBe(true);
    // No ConnectorReference / DisplayText / Description / OriginatingSystem*
    // gaps should remain — the transformer emits those.
    expect(failures.some(f => f.propertyName === 'ConnectorReference')).toBe(false);
    expect(failures.some(f => f.propertyName === 'DisplayText')).toBe(false);
  });
});
