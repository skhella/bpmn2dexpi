/**
 * Standalone DEXPI-file validation (--validate) — acceptance tests.
 *
 * Pins the contract of validateDexpiXml(): the same five fidelity
 * dimensions strict mode runs on transformer output apply to any existing
 * DEXPI 2.0 document, with identical finding strings, and a generated
 * Profile closes the same gaps through this standalone path.
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

import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';
import { DexpiProcessClassRegistry } from '../DexpiProcessClassRegistry';
import { generateProfileFromDexpiXml } from '../DexpiProfileGenerator';
import { validateDexpiXml, checkImportPrefixes } from '../validateDexpiXml';

const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');
const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');

const baseRegistry = () => DexpiProcessClassRegistry.fromXmlSources([
  { name: 'Process.xml', xml: PROCESS_XML },
  { name: 'Core.xml', xml: CORE_XML },
]);

describe('validateDexpiXml — standalone fidelity validation of DEXPI files', () => {
  it('reproduces the strict-mode surface on the TEP export, and a generated Profile closes it', { timeout: 30_000 }, async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const t = new BpmnToDexpiTransformer();
    const dexpiXml = await t.transform(bpmn, {
      processXml: PROCESS_XML,
      coreXml: CORE_XML,
      strict: true,
    });

    // Standalone validation of the produced FILE must match what strict
    // mode reported during the transform — same validators, same registry.
    const reg = baseRegistry();
    const result = validateDexpiXml(dexpiXml, reg);
    const byTier = Object.fromEntries(result.tiers.map(x => [x.tier, x.errors]));

    expect(byTier['property-name + kind'].length).toBe(
      t.lastPropertyNameValidation!.errors.length,
    );
    expect(byTier['data-type']).toEqual([]);
    expect(byTier['reference target-class']).toEqual([]);
    expect(byTier['cardinality']).toEqual([]);
    expect(byTier['class existence']).toEqual([]);
    expect(result.prefixWarnings).toEqual([]);

    // Close the loop through the STANDALONE path: registry + generated
    // Profile → zero findings on the same file.
    const profile = generateProfileFromDexpiXml(dexpiXml, reg, { bpmnXml: bpmn });
    const regWithProfile = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: PROCESS_XML },
      { name: 'Core.xml', xml: CORE_XML },
      { name: 'GeneratedProfile.xml', xml: profile.xml },
    ]);
    const closed = validateDexpiXml(dexpiXml, regWithProfile);
    expect(closed.totalFindings).toBe(0);
  });

  it('flags each dimension on a hand-broken DEXPI document', () => {
    const xml = `<?xml version="1.0"?><Model name="x" uri="urn:t">
      <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
      <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
      <Object id="o1" type="Process/Process.Compressing">
      </Object>
      <Object id="o2" type="Core/QualifiedValue">
        <Data property="Provenance">NotALiteral</Data>
      </Object>
      <Object id="o3" type="Process/Process.NoSuchClass">
      </Object>
    </Model>`;
    const result = validateDexpiXml(xml, baseRegistry());
    const byTier = Object.fromEntries(result.tiers.map(x => [x.tier, x.errors]));

    // Compressing declares Method with lower=1 — absent value → cardinality.
    expect(byTier['cardinality'].some(e => e.includes('Compressing.Method'))).toBe(true);
    // Provenance value must be a QuantityProvenance literal → data-type.
    expect(byTier['data-type'].some(e => e.includes('Provenance'))).toBe(true);
    // Unknown class → class existence.
    expect(byTier['class existence'].some(e => e.includes('NoSuchClass'))).toBe(true);
    expect(result.totalFindings).toBeGreaterThanOrEqual(3);
  });
});

describe('checkImportPrefixes — non-conventional prefixes are surfaced', () => {
  it('accepts the conventional Core/Process prefixes silently', () => {
    const xml = `<?xml version="1.0"?><Model name="x" uri="urn:t">
      <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
      <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
    </Model>`;
    expect(checkImportPrefixes(xml)).toEqual([]);
  });

  it('warns when a model is imported under a different prefix', () => {
    const xml = `<?xml version="1.0"?><Model name="x" uri="urn:t">
      <Import prefix="c" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
    </Model>`;
    const warnings = checkImportPrefixes(xml);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"c"');
  });

  it('warns when no Import declarations exist', () => {
    const xml = `<?xml version="1.0"?><Model name="x" uri="urn:t"><Object id="o" type="Core/QualifiedValue"/></Model>`;
    expect(checkImportPrefixes(xml)).toHaveLength(1);
  });

  it('warns when the document imports a model outside the loaded vocabulary (e.g. the plant model)', () => {
    const xml = `<?xml version="1.0"?><Model name="x" uri="urn:t">
      <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
      <Import prefix="Plant" source="https://data.dexpi.org/models/2.0.0/Plant.xml"/>
    </Model>`;
    const warnings = checkImportPrefixes(xml);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Plant.xml');
    expect(warnings[0]).toContain('not part of the loaded vocabulary');
  });
});
