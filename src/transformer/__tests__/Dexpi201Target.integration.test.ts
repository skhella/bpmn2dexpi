/**
 * DEXPI 2.0.1 as an export target.
 *
 * The bundled 2.0.1 models (dexpi-schema-files/2.0.1/) drive the export
 * through the registry: the document imports the 2.0.1 model URIs, the
 * Composition fraction vector is written under MoleFractions with a
 * RatioUnit literal, MaterialStateType is composed under MaterialState.State
 * and the Composition under MaterialStateType.Composition (the 2.0.0
 * ProcessModel.MaterialStateTypes / Compositions containers are gone), and
 * MeasuringProcessVariable.MeasuredVariable is written as a MeasuredQuantity
 * literal where the authored variable is one. The Tennessee Eastman export
 * passes the (shared) XSD and all five fidelity dimensions with its
 * generated profile, round-trips through the importer, and a 2.0.1 document
 * re-exports as 2.0.1. The 2.0.0 export is unchanged.
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
import { DexpiToBpmnTransformer } from '../DexpiToBpmnTransformer';
import { DexpiProcessClassRegistry } from '../DexpiProcessClassRegistry';
import { generateProfileFromDexpiXml } from '../DexpiProfileGenerator';
import { validateDexpiXml } from '../validateDexpiXml';
import { validateDexpiOutputXsd } from '../DexpiOutputValidator';
import { detectDexpiVersion, dexpiModelRelativePath } from '../dexpiVersions';

const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');
const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const XSD_PATH = join(SCHEMA_DIR, 'DEXPI_XML_Schema.xsd');
const read = (version: '2.0.0' | '2.0.1', model: 'Process' | 'Core' | 'Plant') =>
  readFileSync(join(SCHEMA_DIR, dexpiModelRelativePath(version, model)), 'utf-8');

const MODELS_201 = { processXml: read('2.0.1', 'Process'), coreXml: read('2.0.1', 'Core') };
const MODELS_200 = { processXml: read('2.0.0', 'Process'), coreXml: read('2.0.0', 'Core') };

const count = (xml: string, re: RegExp) => (xml.match(re) ?? []).length;

/** Per-object local content signature (order-free, id-free) — as in DexpiRoundTrip. */
function localSig(el: Element): string {
  const type = el.getAttribute('type') ?? '';
  const parts: string[] = [];
  for (const c of Array.from(el.children)) {
    if (c.tagName === 'Data') {
      const prop = c.getAttribute('property');
      if (prop === 'ExportDateTime') continue;
      const vals = Array.from(c.children).map(v =>
        v.tagName === 'DataReference'
          ? `ref:${v.getAttribute('data') ?? ''}`
          : v.tagName === 'AggregatedDataValue'
            ? `agg[${localSig(v as Element)}]`
            : `${v.tagName}:${(v.textContent ?? '').trim()}`).sort().join(',');
      parts.push(`D[${prop}=${vals}]`);
    } else if (c.tagName === 'References') {
      const n = (c.getAttribute('objects') ?? '').trim().split(/\s+/).filter(Boolean).length;
      parts.push(`R[${c.getAttribute('property')}#${n}]`);
    } else if (c.tagName === 'Components') {
      const kidTypes = Array.from(c.children)
        .map(k => (k as Element).getAttribute('type') ?? (k as Element).tagName)
        .sort().join(',');
      parts.push(`C[${c.getAttribute('property')}:${kidTypes}]`);
    }
  }
  return `${type}{${parts.sort().join(';')}}`;
}

function signatureMultiset(xml: string): Map<string, number> {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const m = new Map<string, number>();
  for (const obj of Array.from(doc.getElementsByTagName('Object'))) {
    const s = localSig(obj);
    m.set(s, (m.get(s) ?? 0) + 1);
  }
  return m;
}

function expectSameContent(d1: string, d2: string): void {
  const s1 = signatureMultiset(d1);
  const s2 = signatureMultiset(d2);
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  expect(total(s2)).toBe(total(s1));
  const missing: string[] = [];
  for (const [sig, n1] of s1) {
    const n2 = s2.get(sig) ?? 0;
    if (n2 !== n1) missing.push(`×${n1}→×${n2}  ${sig.slice(0, 200)}`);
  }
  expect(missing, `content lost or altered:\n${missing.join('\n')}`).toEqual([]);
}

describe('DEXPI 2.0.1 — registry built from the bundled 2.0.1 models', () => {
  const reg = DexpiProcessClassRegistry.fromXmlSources([
    { name: 'Process.xml', xml: MODELS_201.processXml },
    { name: 'Core.xml', xml: MODELS_201.coreXml },
  ]);
  const reg200 = DexpiProcessClassRegistry.fromXmlSources([
    { name: 'Process.xml', xml: MODELS_200.processXml },
    { name: 'Core.xml', xml: MODELS_200.coreXml },
  ]);

  it('recognises its release from the models\' own URIs', () => {
    expect(reg.dexpiVersion).toBe('2.0.1');
    expect(reg.modelUri('Process')).toBe('https://data.dexpi.org/models/2.0.1/Process.xml');
    expect(reg.modelUri('Core')).toBe('https://data.dexpi.org/models/2.0.1/Core.xml');
    expect(reg200.dexpiVersion).toBe('2.0.0');
  });

  it('loads the Plant model of the release too (standalone validation vocabulary)', () => {
    const full = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: MODELS_201.processXml },
      { name: 'Plant.xml', xml: read('2.0.1', 'Plant') },
      { name: 'Core.xml', xml: MODELS_201.coreXml },
    ], { strictSupertypes: true });
    expect(full.isValidClass('ProcessSafetyFunction')).toBe(true); // added in 2.0.1
    expect(full.dexpiVersion).toBe('2.0.1');
  });

  it('still declares every class the Tennessee Eastman model uses, with the ancestry walk intact', () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const used = new Set([...bpmn.matchAll(/dexpiType="([^"]+)"/g)].map(m => m[1]));
    expect(used.size).toBeGreaterThan(10);
    for (const cls of used) {
      expect(reg.isValidClass(cls), cls).toBe(true);
      expect(reg200.isValidClass(cls), cls).toBe(true);
    }
    // Re-parented in 2.0.1 through the new abstract classes.
    expect(reg.hasAncestor('SupplyingElectricalEnergy', 'SupplyingEnergy')).toBe(true);
    expect(reg.hasAncestor('SupplyingElectricalEnergy', 'ProcessStep')).toBe(true);
    expect(reg.hasAncestor('TransportingFluids', 'TransportingMaterial')).toBe(true);
    expect(reg.hasAncestor('TransportingFluids', 'ProcessStep')).toBe(true);
    expect(reg.hasAncestor('SeparatingByFlash', 'SeparatingByThermalProcess')).toBe(true);
    expect(reg.hasAncestor('SeparatingByFlash', 'Separating')).toBe(true);
    // Instrumentation classification and port typing resolve as before.
    expect(reg.hasAncestor('MeasuringProcessVariable', 'InstrumentationActivity')).toBe(true);
    expect(reg.hasAncestor('ControllingProcessVariable', 'InstrumentationActivity')).toBe(true);
    expect(reg.hasAncestor('MaterialPort', 'Port')).toBe(true);
    // Properties removed from the subclasses are inherited from the new parents.
    expect(reg.getProperties('TransportingFluids').some(p => p.name === 'Flow')).toBe(true);
    expect(reg.getProperties('SupplyingSolids').some(p => p.name === 'Capacity')).toBe(true);
    for (const cls of ['SelectingProcessVariable', 'StoringMechanicalEnergy', 'TransportingThermalEnergy', 'PortNodePosition']) {
      expect(reg.isValidClass(cls), cls).toBe(true);
      expect(reg200.isValidClass(cls), cls).toBe(false);
    }
  });

  it('reads the renamed carriers, enumerations and property kinds from the model', () => {
    expect(reg.compositionFractionProperty('Mole')).toBe('MoleFractions');
    expect(reg.compositionFractionProperty('Mass')).toBe('MassFractions');
    expect(reg200.compositionFractionProperty('Mole')).toBe('MoleFractiona');
    expect(reg.getUnitEnumRefForProperty('Composition', 'MoleFractions')).toBe('Core/PhysicalQuantities.RatioUnit');
    expect(reg.getQualifiedEnumLiterals('Core/PhysicalQuantities.RatioUnit')).toEqual(
      expect.arrayContaining(['Percent', 'Fraction', 'PartsPerMillion']));
    expect(reg.getQualifiedEnumLiterals('Core/PhysicalQuantities.PercentageUnit')).toBeNull();
    expect(reg.getQualifiedEnumLiterals('Process/Enumerations.CompositionBasis')).toBeNull();
    expect(reg200.getQualifiedEnumLiterals('Process/Enumerations.CompositionBasis')).toEqual(['Mass', 'Mole']);
    const kind = (r: DexpiProcessClassRegistry, cls: string, prop: string) =>
      r.getProperties(cls).find(p => p.name === prop)?.kind;
    expect(kind(reg, 'MaterialStateType', 'Composition')).toBe('composition');
    expect(kind(reg200, 'MaterialStateType', 'Composition')).toBe('reference');
    expect(kind(reg, 'MaterialState', 'State')).toBe('composition');
    expect(kind(reg, 'MaterialState', 'Phases')).toBe('composition');
    expect(kind(reg200, 'MaterialState', 'Phase')).toBe('reference');
    expect(kind(reg, 'ProcessModel', 'MaterialStateTypes')).toBeUndefined();
    expect(kind(reg, 'ProcessModel', 'Compositions')).toBeUndefined();
    expect(kind(reg, 'MeasuringProcessVariable', 'MeasuredVariable')).toBe('data');
    expect(reg.getEnumReferencePathForProperty('MeasuringProcessVariable', 'MeasuredVariable'))
      .toBe('Process/Enumerations.MeasuredQuantity');
    expect(kind(reg200, 'MeasuringProcessVariable', 'MeasuredVariable')).toBe('composition');
    expect(kind(reg, 'InstrumentationActivity', 'InformationPorts')).toBe('composition');
  });
});

describe('DEXPI 2.0.1 — Tennessee Eastman export', () => {
  const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');

  it('writes the 2.0.1 shape and passes the XSD plus all five fidelity dimensions with its generated profile', { timeout: 60_000 }, async () => {
    const t = new BpmnToDexpiTransformer();
    const xml = await t.transform(bpmn, {
      ...MODELS_201,
      projectName: 'Tennessee Eastman Process',
      generateProfile: { source: 'tep.profile.xml' },
      strict: true,
    });

    // Imports name the 2.0.1 models (and the profile).
    expect(xml).toContain('<Import prefix="Core" source="https://data.dexpi.org/models/2.0.1/Core.xml"/>');
    expect(xml).toContain('<Import prefix="Process" source="https://data.dexpi.org/models/2.0.1/Process.xml"/>');
    expect(xml).not.toContain('models/2.0.0/');
    expect(detectDexpiVersion(xml).version).toBe('2.0.1');

    // Changelog items that touch the emitted shape.
    expect(count(xml, /property="MoleFractions"/g)).toBe(12);
    expect(count(xml, /property="MoleFractiona"/g)).toBe(0);
    expect(count(xml, /RatioUnit\.Percent/g)).toBe(12);
    expect(xml).not.toContain('PercentageUnit');
    expect(xml).not.toContain('CompositionBasis');
    expect(count(xml, /property="MaterialStateTypes"/g)).toBe(0);
    expect(count(xml, /property="Compositions"/g)).toBe(0);
    // Every MaterialState composes its MaterialStateType, which composes its Composition.
    expect(count(xml, /<Components property="State">\s*<Object id="[^"]+" type="Process\/Process\.MaterialStateType"/g)).toBe(12);
    expect(count(xml, /<Components property="Composition">\s*<Object id="[^"]+" type="Process\/Process\.Composition"/g)).toBe(12);
    expect(count(xml, /<References property="State"/g)).toBe(0);
    expect(count(xml, /<References property="Composition"/g)).toBe(0);
    expect(count(xml, /type="Process\/Process\.MaterialStateType"/g)).toBe(12);
    expect(count(xml, /type="Process\/Process\.Composition"/g)).toBe(12);
    // MoleFlow still sits on Composition; the vector values are all there.
    expect(count(xml, /<Data property="Values"/g)).toBe(96);
    expect(xml).toContain('MoleFlowRateUnit.KilomolePerSecond');
    // MeasuredVariable as a MeasuredQuantity literal, only where the authored
    // variable is one (Flow ×3, Level ×3, Pressure ×2 on TEP; Temperature is
    // not a MeasuredQuantity literal and is left out).
    expect(count(xml, /<Data property="MeasuredVariable">\s*<DataReference data="Process\/Enumerations\.MeasuredQuantity\.(Flow|Level|Pressure)"\/>\s*<\/Data>/g)).toBe(8);
    expect(count(xml, /property="MeasuredVariable"/g)).toBe(8);
    // The canonical references are untouched.
    expect(count(xml, /property="ProcessStepReference"/g)).toBe(19);
    expect(count(xml, /property="MeasuredVariableReference"/g)).toBe(19);

    // Shared XSD.
    const xsd = await validateDexpiOutputXsd(xml, XSD_PATH);
    expect(xsd.mode).toBe('xsd');
    expect(xsd.errors).toEqual([]);
    expect(xsd.valid).toBe(true);

    // Strict-mode tiers other than property-name are clean without a profile …
    expect(t.lastDataTypeValidation!.valid).toBe(true);
    expect(t.lastReferenceValidation!.valid).toBe(true);
    expect(t.lastCardinalityValidation!.valid).toBe(true);
    expect(t.lastClassExistenceValidation!.valid).toBe(true);

    // … and the generated profile closes the property-name tier, with the
    // same complete-vocabulary registry the CLI's --validate builds.
    const generated = t.lastGeneratedProfile!;
    expect(generated.declarations).toBeGreaterThan(0);
    expect(generated.xml).toContain('source="https://data.dexpi.org/models/2.0.1/Core.xml"');
    expect(generated.xml).toContain('source="https://data.dexpi.org/models/2.0.1/Process.xml"');
    expect(generated.xml).not.toContain('MoleFractiona');
    expect(xml).toContain('<Import prefix="Profile" source="tep.profile.xml"/>');
    const full = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: MODELS_201.processXml },
      { name: 'Plant.xml', xml: read('2.0.1', 'Plant') },
      { name: 'Core.xml', xml: MODELS_201.coreXml },
      { name: 'tep.profile.xml', xml: generated.xml },
    ], { strictSupertypes: true });
    const result = validateDexpiXml(xml, full, 'tep-2.0.1', ['tep.profile.xml']);
    expect(result.prefixWarnings).toEqual([]);
    for (const tier of result.tiers) expect(tier.errors, tier.tier).toEqual([]);
    expect(result.totalFindings).toBe(0);
  });

  it('loads the bundled 2.0.1 models from disk when asked for the version without model strings', { timeout: 60_000 }, async () => {
    const t = new BpmnToDexpiTransformer();
    const xml = await t.transform(bpmn, { dexpiVersion: '2.0.1' });
    expect(xml).toContain('https://data.dexpi.org/models/2.0.1/Process.xml');
    expect(count(xml, /property="MoleFractions"/g)).toBe(12);
    expect(count(xml, /property="MaterialStateTypes"/g)).toBe(0);
  });

  it('keeps the 2.0.0 export as it was (default target)', { timeout: 60_000 }, async () => {
    const t = new BpmnToDexpiTransformer();
    const xml = await t.transform(bpmn, { ...MODELS_200, strict: true });
    expect(xml).toContain('https://data.dexpi.org/models/2.0.0/Process.xml');
    expect(detectDexpiVersion(xml).version).toBe('2.0.0');
    expect(count(xml, /property="MoleFractiona"/g)).toBe(12);
    expect(count(xml, /PercentageUnit\.Percent/g)).toBe(12);
    expect(count(xml, /property="MaterialStateTypes"/g)).toBe(1);
    expect(count(xml, /property="Compositions"/g)).toBe(1);
    expect(count(xml, /<References property="State"/g)).toBe(12);
    expect(count(xml, /<References property="Composition"/g)).toBe(12);
    expect(count(xml, /property="MeasuredVariable"/g)).toBe(0);
    const byDefault = await new BpmnToDexpiTransformer().transform(bpmn, {});
    expect(byDefault).toContain('https://data.dexpi.org/models/2.0.0/Process.xml');
    expect(count(byDefault, /property="MoleFractiona"/g)).toBe(12);
  });

  it('validating a 2.0.1 document against the 2.0.0 vocabulary is reported as a release mismatch', { timeout: 60_000 }, async () => {
    const xml = await new BpmnToDexpiTransformer().transform(bpmn, MODELS_201);
    const reg200 = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: MODELS_200.processXml },
      { name: 'Core.xml', xml: MODELS_200.coreXml },
    ]);
    const result = validateDexpiXml(xml, reg200);
    expect(result.prefixWarnings.some(w => w.includes('imports DEXPI 2.0.1 models but the loaded vocabulary is 2.0.0'))).toBe(true);
    // The release differences show up as findings (MoleFractions, RatioUnit, the nested compositions).
    expect(result.totalFindings).toBeGreaterThan(0);
  });
});

describe('DEXPI 2.0.1 — round trip and re-export', () => {
  const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');

  it('BPMN → DEXPI 2.0.1 → BPMN → DEXPI 2.0.1 carries identical content', { timeout: 120_000 }, async () => {
    const d1 = await new BpmnToDexpiTransformer().transform(bpmn, MODELS_201);
    const importer = new DexpiToBpmnTransformer();
    const b2 = await importer.transform(d1, MODELS_201);
    expect(importer.lastDetectedVersion).toBe('2.0.1');
    // The importer reads the nested state types and the 2.0.1 carriers.
    expect(count(b2, /<dexpi:MaterialStateType /g)).toBe(12);
    expect(count(b2, /<dexpi:Composition /g)).toBe(12);
    expect(count(b2, /property="MoleFractions"/g)).toBe(12);
    const d2 = await new BpmnToDexpiTransformer().transform(b2, { ...MODELS_201, dexpiVersion: importer.lastDetectedVersion! });
    expectSameContent(d1, d2);
    expect(d2).toContain('https://data.dexpi.org/models/2.0.1/Process.xml');
    expect(count(d2, /property="MoleFractions"/g)).toBe(12);
    expect(count(d2, /RatioUnit\.Percent/g)).toBe(12);
    expect(count(d2, /property="MeasuredVariable"/g)).toBe(8);
    expect(count(d2, /<Components property="State">\s*<Object id="[^"]+" type="Process\/Process\.MaterialStateType"/g)).toBe(12);
  });

  it('a 2.0.1 document imports and re-exports as 2.0.1 through the Node disk loader (CLI-style flow)', { timeout: 120_000 }, async () => {
    const d1 = await new BpmnToDexpiTransformer().transform(bpmn, { dexpiVersion: '2.0.1' });
    const importer = new DexpiToBpmnTransformer();
    const b2 = await importer.transform(d1); // no model strings: picks the release from the imports
    expect(importer.lastDetectedVersion).toBe('2.0.1');
    const d2 = await new BpmnToDexpiTransformer().transform(b2, { dexpiVersion: importer.lastDetectedVersion! });
    expect(d2).toContain('https://data.dexpi.org/models/2.0.1/Core.xml');
    expectSameContent(d1, d2);
  });

  it('a 2.0.1 document read with the 2.0.0 models still imports (both shapes are read)', { timeout: 120_000 }, async () => {
    const d1 = await new BpmnToDexpiTransformer().transform(bpmn, MODELS_201);
    const b2 = await new DexpiToBpmnTransformer().transform(d1, MODELS_200);
    expect(count(b2, /<dexpi:MaterialStateType /g)).toBe(12);
    expect(count(b2, /<dexpi:Composition /g)).toBe(12);
  });

  it('the 2.0.0 round trip still closes and its import is recognised as 2.0.0', { timeout: 120_000 }, async () => {
    const d1 = await new BpmnToDexpiTransformer().transform(bpmn, MODELS_200);
    const importer = new DexpiToBpmnTransformer();
    const b2 = await importer.transform(d1, MODELS_200);
    expect(importer.lastDetectedVersion).toBe('2.0.0');
    const d2 = await new BpmnToDexpiTransformer().transform(b2, MODELS_200);
    expectSameContent(d1, d2);
    expect(d2).toContain('property="MoleFractiona"');
  });

  it('a 2.0.0 export converts to 2.0.1 by importing it and re-exporting with the 2.0.1 target', { timeout: 120_000 }, async () => {
    const d200 = await new BpmnToDexpiTransformer().transform(bpmn, MODELS_200);
    const b = await new DexpiToBpmnTransformer().transform(d200, MODELS_200);
    const t = new BpmnToDexpiTransformer();
    const d201 = await t.transform(b, { ...MODELS_201, generateProfile: { source: 'p.xml' }, strict: true });
    expect(count(d201, /property="MoleFractions"/g)).toBe(12);
    expect(count(d201, /property="MaterialStateTypes"/g)).toBe(0);
    // The generated profile carries no stale 2.0.0 names.
    expect(t.lastGeneratedProfile!.xml).not.toContain('MoleFractiona');
    expect(t.lastGeneratedProfile!.xml).not.toContain('PercentageUnit');
    const xsd = await validateDexpiOutputXsd(d201, XSD_PATH);
    expect(xsd.valid).toBe(true);
  });
});

describe('DEXPI 2.0.1 — importer on hand-written documents', () => {
  const DOC_201 = `<?xml version="1.0" encoding="UTF-8"?>
<Model name="t" uri="urn:test">
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.1/Core.xml"/>
  <Import prefix="Process" source="https://data.dexpi.org/models/2.0.1/Process.xml"/>
  <Object type="Core/EngineeringModel">
    <Components property="ConceptualModel">
      <Object id="pm" type="Process/ProcessModel">
        <Components property="ProcessSteps">
          <Object id="s1" type="Process/Process.Pumping">
            <Data property="Identifier"><String>P-1</String></Data>
            <Data property="Label"><String>Pump</String></Data>
          </Object>
        </Components>
        <Components property="InstrumentationSystemActivities">
          <Object id="sys" type="Process/Process.InstrumentationSystemActivity">
            <Data property="Identifier"><String>SYS</String></Data>
            <Data property="Label"><String>SYS</String></Data>
            <Components property="InstrumentationActivities">
              <Object id="pi1" type="Process/Process.MeasuringProcessVariable">
                <Data property="Identifier"><String>PI-1</String></Data>
                <Data property="Label"><String>PI-1</String></Data>
                <Data property="MeasuredVariable"><DataReference data="Process/Enumerations.MeasuredQuantity.Pressure"/></Data>
                <References property="ProcessStepReference" objects="#s1"/>
              </Object>
            </Components>
          </Object>
        </Components>
        <Components property="MaterialStates">
          <Object id="ms1" type="Process/Process.MaterialState">
            <Data property="Identifier"><String>MS-1</String></Data>
            <Data property="Label"><String>Feed</String></Data>
            <Data property="Description"><String>Feed state</String></Data>
            <Components property="State">
              <Object id="mst1" type="Process/Process.MaterialStateType">
                <Data property="Identifier"><String>MST-1</String></Data>
                <Data property="Label"><String>Feed type</String></Data>
                <Components property="Composition">
                  <Object id="c1" type="Process/Process.Composition">
                    <Data property="Display"><String>Percent</String></Data>
                    <Components property="MoleFractions">
                      <Object type="Core/QualifiedValue">
                        <Data property="DisplayText"><Undefined/></Data>
                        <Data property="Value">
                          <AggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantityVector">
                            <Data property="Values"><Double>60</Double></Data>
                            <Data property="Values"><Double>40</Double></Data>
                            <Data property="Unit"><DataReference data="Core/PhysicalQuantities.RatioUnit.Percent"/></Data>
                          </AggregatedDataValue>
                        </Data>
                      </Object>
                    </Components>
                  </Object>
                </Components>
              </Object>
            </Components>
            <Components property="Phases">
              <Object id="mst1v" type="Process/Process.MaterialStateType">
                <Data property="Identifier"><String>MST-1-vapour</String></Data>
                <Data property="Label"><String>Vapour phase</String></Data>
              </Object>
            </Components>
          </Object>
        </Components>
      </Object>
    </Components>
  </Object>
</Model>`;

  it('reads the nested State / Phases state types, the inline Composition and the MeasuredVariable literal', { timeout: 30_000 }, async () => {
    const importer = new DexpiToBpmnTransformer();
    const bpmn = await importer.transform(DOC_201, MODELS_201);
    expect(importer.lastDetectedVersion).toBe('2.0.1');
    expect(importer.lastDeclaredVersion).toBe('2.0.1');
    // The State type is carried into BPMN with its state; a type composed
    // under Phases is read (parse) but the BPMN authoring links a state to
    // one type only, so it has no slot there (documented gap).
    expect(count(bpmn, /<dexpi:MaterialStateType /g)).toBe(1);
    expect(bpmn).toContain('uid="mst1"');
    expect(bpmn).toContain('uidRef="mst1"'); // the state links to its State type
    expect(bpmn).not.toContain('MST-1-vapour');
    expect(count(bpmn, /<dexpi:Composition /g)).toBe(1);
    expect(bpmn).toContain('property="MoleFractions"');
    expect(bpmn).toContain('>60<');
    expect(bpmn).toContain('>40<');
    // The MeasuredQuantity literal names the instrument's data object.
    expect(bpmn).toMatch(/<bpmn:dataObjectReference [^>]*name="Pressure"/);
  });

  it('reports a document from a release this build does not bundle', async () => {
    const doc = DOC_201.replace(/models\/2\.0\.1\//g, 'models/2.1.0/');
    expect(detectDexpiVersion(doc)).toEqual({ version: null, declared: '2.1.0' });
    const importer = new DexpiToBpmnTransformer();
    await importer.transform(doc, MODELS_201);
    expect(importer.lastDetectedVersion).toBeNull();
    expect(importer.lastDeclaredVersion).toBe('2.1.0');
  });

  it('generates a 2.0.1 profile for a 2.0.1 document (imports the 2.0.1 models)', async () => {
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: MODELS_201.processXml },
      { name: 'Core.xml', xml: MODELS_201.coreXml },
    ]);
    const generated = generateProfileFromDexpiXml(DOC_201, reg);
    expect(generated.xml).toContain('source="https://data.dexpi.org/models/2.0.1/Core.xml"');
    expect(generated.xml).toContain('source="https://data.dexpi.org/models/2.0.1/Process.xml"');
    expect(generated.declarations).toBe(0); // nothing beyond the 2.0.1 vocabulary
  });
});
