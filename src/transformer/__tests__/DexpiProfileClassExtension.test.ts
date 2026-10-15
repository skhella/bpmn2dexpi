/**
 * Profiles as DEXPI XML models: ClassExtension in, ClassExtension out.
 *
 * The DEXPI 2.0 XML Schema defines <ClassExtension name="…" baseType="…">
 * (allowed under <Model> and <Package>) as the way to add properties to a
 * class another model declares; the DISC profile — the reference case of
 * the "Profiles for DEXPI" working draft — is published that way. These
 * tests pin three things:
 *
 *   1. The registry applies a ClassExtension to its base class on load,
 *      from any source and in any order, and rejects an unknown base.
 *   2. The generator emits a ClassExtension (never a re-declaration) for a
 *      class the registry knows, a ConcreteClass only for a new one, and a
 *      <Model> root whose <Import>s make every reference resolvable.
 *   3. The generated profile is itself valid against the official XSD, and
 *      the exporter declares the profile as an <Import> when asked to.
 *
 * The older same-name re-declaration still loads, with a deprecation note.
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
import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';
import { validateDexpiOutputXsd } from '../DexpiOutputValidator';

const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');
const TEP_BPMN = readFileSync(join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn'), 'utf-8');

const base = () => [
  { name: 'Process.xml', xml: PROCESS_XML },
  { name: 'Core.xml', xml: CORE_XML },
];

const EXTENSION_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<Model name="test_profile" uri="https://test/ext">
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
  <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
  <ClassExtension name="PumpingExtension" baseType="Process/Process.Pumping">
    <DataProperty name="ImpellerDiameter" lower="0" upper="1">
      <DataTypeReference type="Builtin/Double"/>
    </DataProperty>
  </ClassExtension>
  <ClassExtension name="QualifiedValueExtension" baseType="Core/QualifiedValue">
    <DataProperty name="Remark" lower="0" upper="1">
      <DataTypeReference type="Builtin/String"/>
    </DataProperty>
  </ClassExtension>
</Model>`;

describe('registry: ClassExtension by baseType', () => {
  it('adds the extension properties to the base class, which keeps its identity', () => {
    const reg = DexpiProcessClassRegistry.fromXmlSources([...base(), { name: 'ext.xml', xml: EXTENSION_PROFILE }]);
    const pumping = reg.getClass('Pumping')!;
    expect(pumping.sourceFile).toBe('Process.xml');
    expect(pumping.kind).toBe('concrete');
    expect(reg.getProperties('Pumping').some(p => p.name === 'ImpellerDiameter' && p.kind === 'data')).toBe(true);
    expect(reg.getProperties('QualifiedValue').some(p => p.name === 'Remark')).toBe(true);
    // Sanctioned mechanism — no merge warning.
    expect(reg.mergeWarnings).toEqual([]);
    // The extension's own name is not a class.
    expect(reg.isValidClass('PumpingExtension')).toBe(false);
  });

  it('applies regardless of source order (extension before the model it extends)', () => {
    const reg = DexpiProcessClassRegistry.fromXmlSources([{ name: 'ext.xml', xml: EXTENSION_PROFILE }, ...base()]);
    expect(reg.getProperties('Pumping').some(p => p.name === 'ImpellerDiameter')).toBe(true);
  });

  it('rejects an extension whose base type is not loaded', () => {
    const bad = `<Model name="bad" uri="https://test/bad">
      <ClassExtension name="NopeExtension" baseType="Process/Process.NoSuchClass">
        <DataProperty name="X" lower="0" upper="1"><DataTypeReference type="Builtin/String"/></DataProperty>
      </ClassExtension>
    </Model>`;
    expect(() => DexpiProcessClassRegistry.fromXmlSources([...base(), { name: 'bad.xml', xml: bad }]))
      .toThrow(/NopeExtension.*unknown base type.*NoSuchClass/s);
  });

  it('rejects an extension that re-declares an existing property with another kind', () => {
    const clash = `<Model name="clash" uri="https://test/clash">
      <ClassExtension name="StreamExtension" baseType="Process/Process.Stream">
        <ReferenceProperty name="Identifier" lower="0" upper="1"><ClassReference type="Core/ConceptualObject"/></ReferenceProperty>
      </ClassExtension>
    </Model>`;
    expect(() => DexpiProcessClassRegistry.fromXmlSources([...base(), { name: 'clash.xml', xml: clash }]))
      .toThrow(/StreamExtension.*Identifier.*kind divergence/s);
  });

  it('cloneAndMergeXml applies extensions too', () => {
    const reg = DexpiProcessClassRegistry.fromXmlSources(base()).cloneAndMergeXml('ext.xml', EXTENSION_PROFILE);
    expect(reg.getProperties('Pumping').some(p => p.name === 'ImpellerDiameter')).toBe(true);
  });

  it('still loads a same-name re-declaration, but marks it deprecated', () => {
    const legacy = `<Model name="legacy" uri="https://test/legacy">
      <ConcreteClass name="Pumping" superTypes="/Process.GeneratingFlow">
        <DataProperty name="LegacyProp" lower="0" upper="1"><DataTypeReference type="Builtin/String"/></DataProperty>
      </ConcreteClass>
    </Model>`;
    const reg = DexpiProcessClassRegistry.fromXmlSources([...base(), { name: 'legacy.xml', xml: legacy }]);
    expect(reg.getProperties('Pumping').some(p => p.name === 'LegacyProp')).toBe(true);
    expect(reg.mergeWarnings.some(w => /Pumping.*legacy\.xml.*deprecated.*ClassExtension/s.test(w))).toBe(true);
  });
});

describe('generator: profile as a DEXPI XML model', () => {
  const emitted = `<?xml version="1.0"?><Model name="x" uri="https://t/">
    <Object type="Process/Process.Pumping">
      <Data property="ImpellerDiameter"><Double>0.3</Double></Data>
      <Components property="Housing"><Object type="Core/QualifiedValue"/></Components>
    </Object>
    <Object type="Core/QualifiedValue">
      <Data property="Remark"><String>x</String></Data>
    </Object>
    <Object type="Process/ProcessModel">
      <Data property="Revision"><String>A</String></Data>
    </Object>
  </Model>`;

  it('extends known classes with ClassExtension and references them through the imports', () => {
    const reg = DexpiProcessClassRegistry.fromXmlSources(base());
    const { xml } = generateProfileFromDexpiXml(emitted, reg);
    expect(xml).toMatch(/<Model name="[A-Za-z_0-9]+" uri="[^"]+">/);
    expect(xml).toContain('<Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>');
    expect(xml).toContain('<Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>');
    // Packaged Process class, top-level Core class, top-level Process class.
    expect(xml).toContain('<ClassExtension name="PumpingExtension" baseType="Process/Process.Pumping">');
    expect(xml).toContain('<ClassExtension name="QualifiedValueExtension" baseType="Core/QualifiedValue">');
    expect(xml).toContain('<ClassExtension name="ProcessModelExtension" baseType="Process/ProcessModel">');
    // Never a re-declaration of a standard class.
    expect(xml).not.toMatch(/<ConcreteClass name="(Pumping|QualifiedValue|ProcessModel)"/);
    expect(xml).not.toContain('<Profile');
  });

  it('round-trips: a fresh registry loads the generated profile and the gaps close', () => {
    const reg = DexpiProcessClassRegistry.fromXmlSources(base());
    const { xml } = generateProfileFromDexpiXml(emitted, reg);
    const reloaded = DexpiProcessClassRegistry.fromXmlSources([...base(), { name: 'gen.xml', xml }]);
    expect(reloaded.mergeWarnings).toEqual([]);
    expect(reloaded.getProperties('Pumping').some(p => p.name === 'ImpellerDiameter')).toBe(true);
    expect(generateProfileFromDexpiXml(emitted, reloaded).declarations).toBe(0);
  });

  it('the generated Tennessee Eastman profile is valid against the official DEXPI 2.0 XSD', async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(TEP_BPMN, { processXml: PROCESS_XML, coreXml: CORE_XML });
    const reg = DexpiProcessClassRegistry.fromXmlSources(base());
    const { xml, classCount } = generateProfileFromDexpiXml(out, reg, { bpmnXml: TEP_BPMN });
    expect(classCount).toBeGreaterThan(0);
    const xsd = await validateDexpiOutputXsd(xml, join(SCHEMA_DIR, 'DEXPI_XML_Schema.xsd'));
    expect(xsd.errors, xsd.errors.slice(0, 5).join('\n')).toEqual([]);
    expect(xsd.valid).toBe(true);
  }, 60_000);
});

describe('exporter: profile imports', () => {
  const MINI_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
                  id="defs_1" targetNamespace="https://example.org/test">
  <bpmn:process id="proc_1">
    <bpmn:task id="task_1" name="Pump">
      <bpmn:extensionElements>
        <dexpi:element dexpiType="Pumping" identifier="P-101" uid="p101"/>
      </bpmn:extensionElements>
    </bpmn:task>
  </bpmn:process>
</bpmn:definitions>`;

  it('declares each profile after the Core and Process imports, with unique prefixes', async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(MINI_BPMN, {
      processXml: PROCESS_XML,
      coreXml: CORE_XML,
      profileImports: [
        { source: 'tep.profile.xml' },
        { prefix: 'Profile', source: 'other.profile.xml' },
        { prefix: 'my-site', source: 'https://example.org/site.xml' },
      ],
    });
    const core = out.indexOf('<Import prefix="Core"');
    const process = out.indexOf('<Import prefix="Process"');
    const profile = out.indexOf('<Import prefix="Profile" source="tep.profile.xml"/>');
    expect(core).toBeGreaterThan(-1);
    expect(process).toBeGreaterThan(core);
    expect(profile).toBeGreaterThan(process);
    expect(out).toContain('<Import prefix="Profile2" source="other.profile.xml"/>');
    expect(out).toContain('<Import prefix="my_site" source="https://example.org/site.xml"/>');
    // Still schema-valid with the extra imports.
    const xsd = await validateDexpiOutputXsd(out, join(SCHEMA_DIR, 'DEXPI_XML_Schema.xsd'));
    expect(xsd.valid, xsd.errors.slice(0, 3).join('\n')).toBe(true);
  });

  it('emits no profile import when none is requested', async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(MINI_BPMN, { processXml: PROCESS_XML, coreXml: CORE_XML });
    expect(out).not.toContain('prefix="Profile"');
  });
});
