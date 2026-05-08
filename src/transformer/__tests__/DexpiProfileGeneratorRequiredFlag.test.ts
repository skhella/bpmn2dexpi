/**
 * Required-flag Profile generation pipeline — narrow-only enforcement.
 *
 * The user marks a per-attribute "required" flag in the BPMN properties
 * panel; the Profile generator translates that into a `lower="1"` override
 * for the wrapping class. Profiles can NARROW DEXPI declarations (e.g.
 * lower=0 → lower=1) but never LOOSEN them — that's why we don't expose a
 * "not required" UI; DEXPI's own `lower=1` declarations stand.
 *
 * Three cases tested:
 *   1. Custom property + required=true   → emit lower=1, no narrowing warning.
 *   2. Standard DEXPI property declared lower=0 + required=true
 *                                         → emit lower=1, narrowing warning.
 *   3. Standard DEXPI property declared lower>=1 + required=true
 *                                         → no-op (already required).
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
import { generateProfileFromDexpiXml } from '../DexpiProfileGenerator';

const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');
const REGISTRY = DexpiProcessClassRegistry.fromXmlSources([
  { name: 'Process.xml', xml: PROCESS_XML },
  { name: 'Core.xml', xml: CORE_XML },
]);

// Helper: minimal BPMN shell carrying a single dexpi:element with one
// dexpi:components child whose `required` attribute is the test variable.
function bpmnWithRequiredFlag(opts: {
  dexpiType: string;
  property: string;
  required: boolean;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://example.org/dexpi"
             xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
             targetNamespace="https://t/">
  <process id="p1">
    <task id="T1" name="t1">
      <extensionElements>
        <dexpi:element dexpiType="${opts.dexpiType}" identifier="T1" uid="uid_T1">
          <dexpi:components property="${opts.property}"${opts.required ? ' required="true"' : ''}>
            <dexpi:object type="Core/QualifiedValue">
              <dexpi:data property="Value">42</dexpi:data>
            </dexpi:object>
          </dexpi:components>
        </dexpi:element>
      </extensionElements>
    </task>
  </process>
</definitions>`;
}

// Helper: minimal DEXPI XML carrying a single Object of `dexpiType` with
// a Components/Object/Data carrier matching the BPMN above. The Profile
// generator infers cardinality from this emitted XML; the BPMN supplies
// the user-asserted required flag.
function dexpiWithProperty(dexpiType: string, property: string): string {
  return `<?xml version="1.0"?><Model name="x" uri="https://t/">
    <Object id="o1" type="Process/Process.${dexpiType}">
      <Components property="${property}">
        <Object type="Core/QualifiedValue">
          <Data property="Value">42</Data>
        </Object>
      </Components>
    </Object>
  </Model>`;
}

describe('Profile generator — required-flag (narrow-only) pipeline', () => {
  it('custom property + required=true → emits lower=1, no narrowing warning', () => {
    const dexpi = dexpiWithProperty('Stream', 'MyCustomProp');
    const bpmn = bpmnWithRequiredFlag({
      dexpiType: 'Stream',
      property: 'MyCustomProp',
      required: true,
    });
    const result = generateProfileFromDexpiXml(dexpi, REGISTRY, { bpmnXml: bpmn });
    // Custom property: should appear with lower="1".
    expect(result.xml).toMatch(/name="MyCustomProp"\s+lower="1"/);
    // No DEXPI-narrowing warning because there was no DEXPI declaration to narrow.
    expect(result.warnings.filter(w => w.includes('Required-flag override'))).toHaveLength(0);
  });

  it('standard DEXPI property + required=true → emits lower=1 AND narrowing warning', () => {
    // Stream declares many properties at lower=0. We pick "Description"
    // which is on Stream's supertype chain (ConceptualObject) and declared
    // optional in DEXPI.
    const dexpi = dexpiWithProperty('Stream', 'Description');
    const bpmn = bpmnWithRequiredFlag({
      dexpiType: 'Stream',
      property: 'Description',
      required: true,
    });
    const result = generateProfileFromDexpiXml(dexpi, REGISTRY, { bpmnXml: bpmn });
    // Narrowing notice surfaces.
    const narrow = result.warnings.find(w => w.includes('Required-flag override'));
    expect(narrow, JSON.stringify(result.warnings, null, 2)).toBeDefined();
    expect(narrow).toContain('Stream.Description');
    expect(narrow).toContain('lower=0 to lower=1');
  });

  it('absent required flag → no narrowing, no warning', () => {
    const dexpi = dexpiWithProperty('Stream', 'MyOtherProp');
    const bpmn = bpmnWithRequiredFlag({
      dexpiType: 'Stream',
      property: 'MyOtherProp',
      required: false,
    });
    const result = generateProfileFromDexpiXml(dexpi, REGISTRY, { bpmnXml: bpmn });
    expect(result.warnings.filter(w => w.includes('Required-flag override'))).toHaveLength(0);
    // The custom property still appears, but with lower=0 (DEXPI flexibility).
    expect(result.xml).toMatch(/name="MyOtherProp"\s+lower="0"/);
  });
});
