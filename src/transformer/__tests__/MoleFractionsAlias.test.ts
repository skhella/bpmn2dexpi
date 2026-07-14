/**
 * MoleFractions read-alias + schema-driven fraction carrier.
 *
 * The `MoleFractiona` spelling in Process.xml is a known schema typo whose
 * correction to `MoleFractions` is anticipated in a future DEXPI release. Until
 * that schema ships, the contract is:
 *
 *   - READ:  both spellings are accepted as the authored fractions carrier in
 *            BPMN extensionElements (so files written against either era —
 *            including ones that use the corrected spelling — round-trip
 *            their values).
 *   - EMIT:  the carrier property name comes from the loaded schema
 *            (DexpiProcessClassRegistry.compositionFractionProperty), so the
 *            output always matches what Process.xml declares — `MoleFractiona`
 *            today, flipping automatically when the corrected schema is
 *            dropped in.
 *
 * The input below uses a flat carrier, the MoleFractions spelling, Unit token
 * `Fraction`, and MoleFlow in KilomolePerHour.
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

const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');

const LISTING2_STYLE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
             id="Defs_2" targetNamespace="http://example.com/bpmn">
  <bpmn:process id="P2" isExecutable="false">
    <bpmn:dataObjectReference id="DOR_states" name="Base Case MaterialStates"
                              dataObjectRef="DO_1">
      <bpmn:extensionElements>
        <dexpi:MaterialState uid="uuid_MS_S1">
          <dexpi:data property="Identifier">1</dexpi:data>
          <dexpi:data property="Label">A Feed</dexpi:data>
          <dexpi:data property="Description"/>
          <dexpi:references property="State" uidRef="uuid_MS_S1_MST"/>
        </dexpi:MaterialState>
        <dexpi:MaterialStateType uid="uuid_MS_S1_MST">
          <dexpi:data property="Identifier">1-State</dexpi:data>
          <dexpi:data property="Label">A Feed State</dexpi:data>
          <dexpi:data property="Description">State-type for A Feed</dexpi:data>
          <dexpi:components property="MoleFlow">
            <dexpi:object type="Core/QualifiedValue">
              <dexpi:data property="Value">11.2</dexpi:data>
              <dexpi:data property="Unit">KilomolePerHour</dexpi:data>
            </dexpi:object>
          </dexpi:components>
          <dexpi:references property="Composition" uidRef="uuid_MS_S1_Composition"/>
        </dexpi:MaterialStateType>
        <dexpi:Composition uid="uuid_MS_S1_Composition">
          <dexpi:data property="Display">Fraction</dexpi:data>
          <dexpi:components property="MoleFractions">
            <dexpi:object type="Core/QualifiedValue">
              <dexpi:data property="Values">0.99990</dexpi:data>
              <dexpi:data property="Values">0.00010</dexpi:data>
              <dexpi:data property="Values">0.00000</dexpi:data>
              <dexpi:data property="Values">0.00000</dexpi:data>
              <dexpi:data property="Values">0.00000</dexpi:data>
              <dexpi:data property="Values">0.00000</dexpi:data>
              <dexpi:data property="Values">0.00000</dexpi:data>
              <dexpi:data property="Values">0.00000</dexpi:data>
              <dexpi:data property="Unit">Fraction</dexpi:data>
            </dexpi:object>
          </dexpi:components>
        </dexpi:Composition>
      </bpmn:extensionElements>
    </bpmn:dataObjectReference>
    <bpmn:dataObject id="DO_1"/>
  </bpmn:process>
</bpmn:definitions>`;

describe('Registry — compositionFractionProperty (schema-driven carrier name)', () => {
  it('returns the declared names from the loaded schema', () => {
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: PROCESS_XML },
      { name: 'Core.xml', xml: CORE_XML },
    ]);
    expect(reg.compositionFractionProperty('Mole')).toBe('MoleFractiona');
    expect(reg.compositionFractionProperty('Mass')).toBe('MassFractions');
  });

  it('falls back to the published names with no schema loaded', () => {
    const reg = DexpiProcessClassRegistry.empty();
    expect(reg.compositionFractionProperty('Mole')).toBe('MoleFractiona');
    expect(reg.compositionFractionProperty('Mass')).toBe('MassFractions');
  });
});

describe('MoleFractions read-alias (listing input round-trips)', () => {
  it('extracts a MoleFractions-spelled vector and emits it under the schema-declared carrier', { timeout: 15_000 }, async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(LISTING2_STYLE_BPMN, {
      strict: true,
      processXml: PROCESS_XML,
      coreXml: CORE_XML,
    });

    // Values survive — no silent drop of the authored fractions. (Numeric
    // normalization trims trailing zeros: 0.99990 → 0.9999, value-identical.)
    expect(out).toContain('>0.9999<');
    expect(out).toContain('>0.0001<');
    expect(out.match(/property="Values"/g)).toHaveLength(8);
    // Emitted under the schema-declared spelling, not the authored one.
    expect(out).toMatch(/property="MoleFractiona"/);
    expect(out).not.toMatch(/property="MoleFractions"/);

    // The fractions carrier resolves as a declared property — the only
    // property-name finding from this input is the MoleFlow vocabulary gap.
    const propErrors = t.lastPropertyNameValidation!.errors;
    expect(propErrors.some(e => e.includes('MaterialStateType.MoleFlow'))).toBe(true);
    expect(propErrors.some(e => e.includes('MoleFraction'))).toBe(false);

    // The authored token `Fraction` is not a PercentageUnit literal; the
    // schema-bound carrier emits it as a qualified DataReference so the
    // data-type tier flags it — closeable by a generated Profile (Design B).
    const dtErrors = t.lastDataTypeValidation!.errors;
    expect(dtErrors.some(e => e.includes('PercentageUnit.Fraction'))).toBe(true);
  });
});
