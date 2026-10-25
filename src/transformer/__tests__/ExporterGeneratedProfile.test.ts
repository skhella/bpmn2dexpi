/**
 * Self-describing export: transform() with the `generateProfile` option
 * runs the profile generator as part of the export.
 *
 *   - A model that uses extension properties gets an
 *     <Import prefix="Profile" source="…"/> after Core / Process, and the
 *     generated profile (lastGeneratedProfile) declares those properties.
 *   - A model that needs no profile gets no Import and no declarations.
 *   - The generated profile's prefix never collides with a profileImports
 *     prefix, and the import stays XSD-valid.
 *   - The profile is the same one `generateProfileFromDexpiXml` produces
 *     on the finished document, so the CLI, the UI and the library agree.
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
import { validateDexpiOutputXsd } from '../DexpiOutputValidator';

const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');
const TEP_BPMN = readFileSync(join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn'), 'utf-8');
const TEP_PROFILE = readFileSync(join(__dirname, '../../../examples/profiles/tep-generated.xml'), 'utf-8');

const bpmnWith = (extensionData: string) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
                  id="defs_1" targetNamespace="https://example.org/test">
  <bpmn:process id="proc_1">
    <bpmn:task id="task_1" name="Pump">
      <bpmn:extensionElements>
        <dexpi:element dexpiType="Pumping" identifier="P-101" uid="p101">${extensionData}</dexpi:element>
      </bpmn:extensionElements>
    </bpmn:task>
  </bpmn:process>
</bpmn:definitions>`;

const PLAIN_BPMN = bpmnWith('');
const EXTENDED_BPMN = bpmnWith('<dexpi:data property="ResidenceTime">120</dexpi:data>');

const schema = { processXml: PROCESS_XML, coreXml: CORE_XML };

describe('exporter: generateProfile option', () => {
  it('imports the generated profile when the model uses extension properties', async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(EXTENDED_BPMN, { ...schema, generateProfile: { source: 'pump.profile.xml' } });

    const process = out.indexOf('<Import prefix="Process"');
    const profile = out.indexOf('<Import prefix="Profile" source="pump.profile.xml"/>');
    expect(process).toBeGreaterThan(-1);
    expect(profile).toBeGreaterThan(process);

    const generated = t.lastGeneratedProfile;
    expect(generated).toBeDefined();
    expect(generated!.declarations).toBeGreaterThan(0);
    expect(generated!.xml).toContain('<ClassExtension name="PumpingExtension"');
    expect(generated!.xml).toContain('name="ResidenceTime"');

    const xsd = await validateDexpiOutputXsd(out, join(SCHEMA_DIR, 'DEXPI_XML_Schema.xsd'));
    expect(xsd.valid, xsd.errors.slice(0, 3).join('\n')).toBe(true);
  });

  it('imports nothing and declares nothing when the model needs no profile', async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(PLAIN_BPMN, { ...schema, generateProfile: { source: 'pump.profile.xml' } });
    expect(out).not.toContain('prefix="Profile"');
    expect(out).not.toContain('pump.profile.xml');
    expect(t.lastGeneratedProfile?.declarations).toBe(0);
  });

  it('is off unless asked for', async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(EXTENDED_BPMN, schema);
    expect(out).not.toContain('prefix="Profile"');
    expect(t.lastGeneratedProfile).toBeUndefined();
  });

  it('keeps its prefix unique next to profileImports', async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(EXTENDED_BPMN, {
      ...schema,
      profileImports: [{ source: 'site.profile.xml' }],
      generateProfile: { source: 'pump.profile.xml' },
    });
    const site = out.indexOf('<Import prefix="Profile" source="site.profile.xml"/>');
    const generated = out.indexOf('<Import prefix="Profile2" source="pump.profile.xml"/>');
    expect(site).toBeGreaterThan(-1);
    expect(generated).toBeGreaterThan(site);
  });

  it('produces the committed TEP profile, identical to a standalone generator run', async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(TEP_BPMN, { ...schema, generateProfile: { source: 'tep.profile.xml' } });
    expect(out).toContain('<Import prefix="Profile" source="tep.profile.xml"/>');
    expect(t.lastGeneratedProfile!.xml).toBe(TEP_PROFILE);

    // The document the consumer receives (with the Import) yields the same
    // profile again: the Import line is not a gap.
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: PROCESS_XML },
      { name: 'Core.xml', xml: CORE_XML },
    ]);
    const again = generateProfileFromDexpiXml(out, reg, { bpmnXml: TEP_BPMN });
    expect(again.xml).toBe(TEP_PROFILE);
    expect(again.declarations).toBe(t.lastGeneratedProfile!.declarations);
  }, 60_000); // two generator runs over the full TEP model, slow under a parallel suite
});

describe('exporter: strict mode validates against the generated profile', () => {
  it('extension properties the export declares are not strict findings', async () => {
    const t = new BpmnToDexpiTransformer();
    await t.transform(TEP_BPMN, { ...schema, strict: true, generateProfile: { source: 'tep.profile.xml' } });
    expect(t.lastGeneratedProfile?.declarations).toBeGreaterThan(0);
    expect(t.lastStrictVocabulary?.generatedProfileDeclarations).toBe(t.lastGeneratedProfile!.declarations);
    // Every tier is clean: the profile covers the vocabulary gaps, and the
    // model has no defect a profile cannot fix.
    expect(t.lastPropertyNameValidation?.valid, t.lastPropertyNameValidation?.errors.slice(0, 3).join('\n')).toBe(true);
    expect(t.lastDataTypeValidation?.valid).toBe(true);
    expect(t.lastReferenceValidation?.valid).toBe(true);
    expect(t.lastCardinalityValidation?.valid).toBe(true);
    expect(t.lastClassExistenceValidation?.valid).toBe(true);
  }, 60_000);

  it('without a generated profile the same model still reports its vocabulary gaps', async () => {
    const t = new BpmnToDexpiTransformer();
    await t.transform(TEP_BPMN, { ...schema, strict: true });
    expect(t.lastGeneratedProfile).toBeUndefined();
    expect(t.lastStrictVocabulary?.generatedProfileDeclarations).toBe(0);
    expect(t.lastPropertyNameValidation?.valid).toBe(false);
  }, 60_000);

  it('records no strict vocabulary when strict mode is off', async () => {
    const t = new BpmnToDexpiTransformer();
    await t.transform(EXTENDED_BPMN, { ...schema, generateProfile: { source: 'pump.profile.xml' } });
    expect(t.lastStrictVocabulary).toBeUndefined();
  });
});
