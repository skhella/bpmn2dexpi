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

describe('Profile generator — required-flag on streams', () => {
  // Streams use the canonical <dexpi:components property="X"> carrier with a
  // <dexpi:object type="Core/QualifiedValue"> child since the canonical-
  // storage migration (#36). The Profile generator derives the className
  // from the BPMN-side streamType discriminator: MaterialFlow → Stream;
  // ThermalEnergyFlow → ThermalEnergyFlow; etc. Same narrow-only
  // enforcement as the step path.

  function bpmnStreamWithRequiredFlag(opts: {
    streamType: string;
    property: string;
    required: boolean;
  }): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://example.org/dexpi"
             xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
             targetNamespace="https://t/">
  <process id="p1">
    <sequenceFlow id="F1" sourceRef="A" targetRef="B">
      <extensionElements>
        <dexpi:Stream streamType="${opts.streamType}" identifier="F1" uid="uid_F1">
          <dexpi:components property="${opts.property}"${opts.required ? ' required="true"' : ''}>
            <dexpi:object type="Core/QualifiedValue">
              <dexpi:data property="Value">42</dexpi:data>
              <dexpi:data property="Unit">kg/h</dexpi:data>
            </dexpi:object>
          </dexpi:components>
        </dexpi:Stream>
      </extensionElements>
    </sequenceFlow>
  </process>
</definitions>`;
  }

  function dexpiStreamWithProperty(dexpiClass: string, property: string): string {
    return `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="src_port" type="Process/Process.MaterialPort"/>
      <Object id="tgt_port" type="Process/Process.MaterialPort"/>
      <Object id="s1" type="Process/Process.${dexpiClass}">
        <Components property="${property}">
          <Object type="Core/QualifiedValue">
            <Data property="Value">42</Data>
          </Object>
        </Components>
      </Object>
    </Model>`;
  }

  it('MaterialFlow stream → Stream.<custom> emitted with lower=1 when required', () => {
    const dexpi = dexpiStreamWithProperty('Stream', 'MyStreamProp');
    const bpmn = bpmnStreamWithRequiredFlag({
      streamType: 'MaterialFlow',
      property: 'MyStreamProp',
      required: true,
    });
    const result = generateProfileFromDexpiXml(dexpi, REGISTRY, { bpmnXml: bpmn });
    expect(result.xml).toMatch(/name="MyStreamProp"\s+lower="1"/);
    // Custom property → no DEXPI-narrowing warning (no DEXPI default to override).
    expect(result.warnings.filter(w => w.includes('Required-flag override'))).toHaveLength(0);
  });

  it('ThermalEnergyFlow stream → ThermalEnergyFlow.<custom> uses the streamType-derived class', () => {
    const dexpi = dexpiStreamWithProperty('ThermalEnergyFlow', 'MyHeatProp');
    const bpmn = bpmnStreamWithRequiredFlag({
      streamType: 'ThermalEnergyFlow',
      property: 'MyHeatProp',
      required: true,
    });
    const result = generateProfileFromDexpiXml(dexpi, REGISTRY, { bpmnXml: bpmn });
    expect(result.xml).toContain('<ConcreteClass name="ThermalEnergyFlow"');
    // Match: the ThermalEnergyFlow ConcreteClass must contain a MyHeatProp DataProperty
    // declared with lower="1" (rather than lower="0" as for non-required custom props).
    const match = result.xml.match(/<ConcreteClass name="ThermalEnergyFlow"[\s\S]*?<\/ConcreteClass>/);
    expect(match, 'expected a ThermalEnergyFlow ConcreteClass block').toBeTruthy();
    expect(match![0]).toMatch(/name="MyHeatProp"\s+lower="1"/);
  });

  it('Standard DEXPI Stream property + required=true → narrowing warning surfaces', () => {
    // Description is declared on Stream's supertype chain at lower=0; a
    // required-flag override should narrow it to lower=1 with a notice.
    const dexpi = dexpiStreamWithProperty('Stream', 'Description');
    const bpmn = bpmnStreamWithRequiredFlag({
      streamType: 'MaterialFlow',
      property: 'Description',
      required: true,
    });
    const result = generateProfileFromDexpiXml(dexpi, REGISTRY, { bpmnXml: bpmn });
    const narrow = result.warnings.find(w =>
      w.includes('Required-flag override') && w.includes('Stream.Description'),
    );
    expect(narrow, JSON.stringify(result.warnings, null, 2)).toBeDefined();
    expect(narrow).toContain('lower=0 to lower=1');
  });

  it('absent required flag on a stream attribute → no narrowing, no warning', () => {
    const dexpi = dexpiStreamWithProperty('Stream', 'AnotherStreamProp');
    const bpmn = bpmnStreamWithRequiredFlag({
      streamType: 'MaterialFlow',
      property: 'AnotherStreamProp',
      required: false,
    });
    const result = generateProfileFromDexpiXml(dexpi, REGISTRY, { bpmnXml: bpmn });
    expect(result.warnings.filter(w => w.includes('Required-flag override'))).toHaveLength(0);
    expect(result.xml).toMatch(/name="AnotherStreamProp"\s+lower="0"/);
  });

  it('flat <dexpi:data> required flag on a stream → narrowed to lower=1', () => {
    // DataProperty side of the canonical-storage migration: enum-literal /
    // string properties on streams are <dexpi:data property="X">v</dexpi:data>
    // with required="true" as an XML attribute. The Profile generator must
    // pick these up the same way it does <dexpi:components>.
    const dexpi = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="src_port" type="Process/Process.MaterialPort"/>
      <Object id="tgt_port" type="Process/Process.MaterialPort"/>
      <Object id="s1" type="Process/Process.Stream">
        <Data property="MyStreamFlag">on</Data>
      </Object>
    </Model>`;
    const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://example.org/dexpi"
             targetNamespace="https://t/">
  <process id="p1">
    <sequenceFlow id="F1" sourceRef="A" targetRef="B">
      <extensionElements>
        <dexpi:Stream streamType="MaterialFlow" identifier="F1" uid="uid_F1">
          <dexpi:data property="MyStreamFlag" required="true">on</dexpi:data>
        </dexpi:Stream>
      </extensionElements>
    </sequenceFlow>
  </process>
</definitions>`;
    const result = generateProfileFromDexpiXml(dexpi, REGISTRY, { bpmnXml: bpmn });
    expect(result.xml).toMatch(/name="MyStreamFlag"\s+lower="1"/);
  });
});

describe('Profile generator — required-flag on ports (#38 follow-up)', () => {
  // Ports gained DEXPI attribute authoring in PR #38. The Profile generator
  // walks `<dexpi:port>` elements alongside `<dexpi:element>` and
  // `<dexpi:Stream>`, using `port.portType` as the wrapping class so
  // required-flag narrowing on a port attribute scopes to the port's
  // subclass (MaterialPort, ThermalEnergyPort, …) rather than its enclosing
  // ProcessStep.

  it('required <dexpi:components> on a port → narrowed under the portType class', () => {
    const dexpi = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="src_port" type="Process/Process.MaterialPort">
        <Components property="MyPortRate">
          <Object type="Core/QualifiedValue">
            <Data property="Value">42</Data>
          </Object>
        </Components>
      </Object>
      <Object id="s1" type="Process/Process.Stream"/>
    </Model>`;
    const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://example.org/dexpi"
             targetNamespace="https://t/">
  <process id="p1">
    <task id="A">
      <extensionElements>
        <dexpi:element dexpiType="Compressing">
          <dexpi:port portId="src_port" name="MO1" portType="MaterialPort" direction="Outlet">
            <dexpi:components property="MyPortRate" required="true">
              <dexpi:object type="Core/QualifiedValue">
                <dexpi:data property="Value">42</dexpi:data>
                <dexpi:data property="Unit">kg/h</dexpi:data>
              </dexpi:object>
            </dexpi:components>
          </dexpi:port>
        </dexpi:element>
      </extensionElements>
    </task>
  </process>
</definitions>`;
    const result = generateProfileFromDexpiXml(dexpi, REGISTRY, { bpmnXml: bpmn });
    // The narrowed declaration should land on a MaterialPort ConcreteClass
    // (per-class scope), not on the wrapping Compressing class.
    expect(result.xml).toMatch(/<ConcreteClass\s+name="MaterialPort"/);
    const matMatch = result.xml.match(/<ConcreteClass[^>]*name="MaterialPort"[\s\S]*?<\/ConcreteClass>/);
    expect(matMatch, 'expected a MaterialPort ConcreteClass block').toBeDefined();
    expect(matMatch![0]).toMatch(/name="MyPortRate"\s+lower="1"/);
  });

  it('required <dexpi:data> on a port → flat-data port property narrowed', () => {
    const dexpi = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="src_port" type="Process/Process.MaterialPort">
        <Data property="MyPortFlag">on</Data>
      </Object>
      <Object id="s1" type="Process/Process.Stream"/>
    </Model>`;
    const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://example.org/dexpi"
             targetNamespace="https://t/">
  <process id="p1">
    <task id="A">
      <extensionElements>
        <dexpi:element dexpiType="Compressing">
          <dexpi:port portId="src_port" name="MO1" portType="MaterialPort" direction="Outlet">
            <dexpi:data property="MyPortFlag" required="true">on</dexpi:data>
          </dexpi:port>
        </dexpi:element>
      </extensionElements>
    </task>
  </process>
</definitions>`;
    const result = generateProfileFromDexpiXml(dexpi, REGISTRY, { bpmnXml: bpmn });
    expect(result.xml).toMatch(/name="MyPortFlag"\s+lower="1"/);
  });

  it('port without portType → defaults to MaterialPort + warns + still narrows', () => {
    // Aligns with the rest of the codebase (UI addPort, legacy migration,
    // transformer port reader): missing portType assumes MaterialPort.
    // The Profile generator surfaces a structural warning so the user
    // knows the default was applied, AND still narrows the required
    // property under MaterialPort so the user's authored intent reaches
    // the generated Profile.
    const dexpi = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="src_port" type="Process/Process.MaterialPort">
        <Components property="UnscopedPortProp">
          <Object type="Core/QualifiedValue">
            <Data property="Value">1</Data>
          </Object>
        </Components>
      </Object>
      <Object id="s1" type="Process/Process.Stream"/>
    </Model>`;
    const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://example.org/dexpi"
             targetNamespace="https://t/">
  <process id="p1">
    <task id="A">
      <extensionElements>
        <dexpi:element dexpiType="Compressing">
          <dexpi:port portId="src_port" name="MO1" direction="Outlet">
            <dexpi:components property="UnscopedPortProp" required="true">
              <dexpi:object type="Core/QualifiedValue">
                <dexpi:data property="Value">1</dexpi:data>
              </dexpi:object>
            </dexpi:components>
          </dexpi:port>
        </dexpi:element>
      </extensionElements>
    </task>
  </process>
</definitions>`;
    const result = generateProfileFromDexpiXml(dexpi, REGISTRY, { bpmnXml: bpmn });
    // Warning surfaces in the generator's warnings list.
    const missingTypeWarning = result.warnings.find(w =>
      w.includes('missing portType') && w.includes('src_port'),
    );
    expect(missingTypeWarning, JSON.stringify(result.warnings, null, 2)).toBeDefined();
    expect(missingTypeWarning).toContain('defaulted to MaterialPort');
    // The required property is narrowed against the MaterialPort default —
    // user's authored intent reaches the Profile.
    expect(result.xml).toMatch(/name="UnscopedPortProp"\s+lower="1"/);
  });
});
