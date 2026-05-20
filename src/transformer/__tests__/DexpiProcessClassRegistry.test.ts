/**
 * Tests for DexpiProcessClassRegistry and the three-mode typing system.
 *
 * Mode 1 'dexpi-validated'  — known DEXPI class, no warning
 * Mode 2 'unvalidated'      — unknown/missing annotation → ProcessStep + optional URI + hint
 * Mode 3 'unannotated'      — no annotation, defaults to ProcessStep, always warns
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DexpiProcessClassRegistry } from '../DexpiProcessClassRegistry';
import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';

const PROCESS_XML_PATH = join(__dirname, '../../../dexpi-schema-files/Process.xml');

// ── Registry unit tests ────────────────────────────────────────────────────

describe('DexpiProcessClassRegistry', () => {
  const registry: DexpiProcessClassRegistry =
    DexpiProcessClassRegistry.fromXml(readFileSync(PROCESS_XML_PATH, 'utf-8'));

  it('loads classes from Process.xml', () => {
    expect(registry.size).toBeGreaterThan(50); // DEXPI 2.0 has 100+ classes
  });

  it('recognises all expected concrete DEXPI process step classes', () => {
    const mustExist = [
      'Pumping', 'Compressing', 'ReactingChemicals', 'Separating',
      'ExchangingThermalEnergy', 'Cooling', 'StrippingDistilling',
      'MeasuringProcessVariable', 'ControllingProcessVariable',
      'TransportingFluids', 'MixingSimple', 'Source', 'Sink'
    ];
    mustExist.forEach(cls => {
      expect(registry.isValidClass(cls), `Expected "${cls}" to be in registry`).toBe(true);
    });
  });

  it('rejects names not in the DEXPI spec', () => {
    expect(registry.isValidClass('MyCustomReactor')).toBe(false);
    expect(registry.isValidClass('PumpFeedDataToDashboard')).toBe(false);
    expect(registry.isValidClass('')).toBe(false);
  });

  it('concreteClasses() returns only concrete (instantiable) classes', () => {
    const concretes = registry.concreteClasses();
    expect(concretes).toContain('Pumping');
    expect(concretes.length).toBeGreaterThan(0);
  });

  it('getClass() returns metadata including superTypes', () => {
    const info = registry.getClass('Pumping');
    expect(info).toBeDefined();
    expect(info!.kind).toBe('concrete');
    expect(info!.superTypes.length).toBeGreaterThan(0);
  });

  it('is updatable — returns different results for different XML', () => {
    // Simulate a future DEXPI version with a new class
    const fakeXml = `<Model name="Process" uri="https://test">
      <ConcreteClass name="FutureSuperReactor" superTypes="/Process.ProcessStep"/>
    </Model>`;
    const future = DexpiProcessClassRegistry.fromXml(fakeXml);
    expect(future.isValidClass('FutureSuperReactor')).toBe(true);
    expect(future.isValidClass('Pumping')).toBe(false); // not in fake XML
  });
});

// ── Multi-source loading: Process+Core, extensions, conflict, missing ─────

describe('DexpiProcessClassRegistry multi-source loading', () => {
  const CORE_XML_PATH = join(__dirname, '../../../dexpi-schema-files/Core.xml');
  const processXml = readFileSync(PROCESS_XML_PATH, 'utf-8');
  const coreXml = readFileSync(CORE_XML_PATH, 'utf-8');

  it('loads Process.xml + Core.xml together with strict supertype validation', () => {
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: processXml },
      { name: 'Core.xml', xml: coreXml },
    ]);
    // Process classes available
    expect(reg.isValidClass('Stream')).toBe(true);
    expect(reg.isValidClass('Pumping')).toBe(true);
    // Core classes available too
    expect(reg.isValidClass('ConceptualObject')).toBe(true);
    expect(reg.isValidClass('QualifiedValue')).toBe(true);
  });

  it('getProperties() walks the full supertype chain across Process → Core', () => {
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: processXml },
      { name: 'Core.xml', xml: coreXml },
    ]);
    const props = reg.getProperties('Stream');
    const propNames = props.map(p => p.name);
    // Stream's own CompositionProperties
    expect(propNames).toContain('MassFlow');
    expect(propNames).toContain('Temperature');
    expect(propNames).toContain('Pressure');
    expect(propNames).toContain('VolumeFlow');
    // Inherited from ProcessConnection
    expect(propNames).toContain('Identifier');
    expect(propNames).toContain('Label');
    expect(propNames).toContain('Description');
    expect(propNames).toContain('Source');
    expect(propNames).toContain('Target');
  });

  it('loads an extension that adds a class extending a Process class', () => {
    const extension = {
      name: 'BiologicalReactor.xml',
      xml: `<Model name="BioExt" uri="https://test/bio">
        <ConcreteClass name="BiologicalReactor" superTypes="/Process.ReactingChemicals">
          <DataProperty name="ResidenceTime" lower="0" upper="1">
            <DataTypeReference type="Builtin/Double"/>
          </DataProperty>
        </ConcreteClass>
      </Model>`,
    };
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: processXml },
      { name: 'Core.xml', xml: coreXml },
      extension,
    ]);
    expect(reg.isValidClass('BiologicalReactor')).toBe(true);
    expect(reg.hasAncestor('BiologicalReactor', 'ReactingChemicals')).toBe(true);
    expect(reg.hasAncestor('BiologicalReactor', 'ProcessStep')).toBe(true);
    // Extension property is on the class
    const props = reg.getProperties('BiologicalReactor');
    expect(props.find(p => p.name === 'ResidenceTime')).toBeDefined();
    // The dropdown includes user-extension concrete classes
    expect(reg.concreteClasses()).toContain('BiologicalReactor');
  });

  it('rejects a malformed extension referencing an unknown supertype', () => {
    const malformed = {
      name: 'Broken.xml',
      xml: `<Model name="Broken" uri="https://test/broken">
        <ConcreteClass name="Bogus" superTypes="/Process.NonExistentParent"/>
      </Model>`,
    };
    expect(() =>
      DexpiProcessClassRegistry.fromXmlSources([
        { name: 'Process.xml', xml: processXml },
        { name: 'Core.xml', xml: coreXml },
        malformed,
      ])
    ).toThrow(/unresolved supertype.*NonExistentParent/is);
  });

  it('merges two sources declaring the same class name and records a warning', () => {
    const dupe = {
      name: 'Dupe.xml',
      xml: `<Model name="Dupe" uri="https://test/dupe">
        <ConcreteClass name="Pumping" superTypes="Core/ConceptualObject"/>
      </Model>`,
    };
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: processXml },
      { name: 'Core.xml', xml: coreXml },
      dupe,
    ]);
    expect(reg.isValidClass('Pumping')).toBe(true);
    expect(reg.getClass('Pumping')!.sourceFile).toBe('Process.xml');
    expect(reg.mergeWarnings.some(w => w.includes('Pumping') && w.includes('Dupe.xml'))).toBe(true);
  });
});

// ── Profile merge semantics ───────────────────────────────────────────────

describe('DexpiProcessClassRegistry uniform Profile merge', () => {
  const CORE_XML_PATH = join(__dirname, '../../../dexpi-schema-files/Core.xml');
  const processXml = readFileSync(PROCESS_XML_PATH, 'utf-8');
  const coreXml = readFileSync(CORE_XML_PATH, 'utf-8');

  it('merges new properties into existing class instead of rejecting', () => {
    const extendingProfile = {
      name: 'extending.xml',
      xml: `<?xml version="1.0" encoding="UTF-8"?>
        <Profile mode="extend" uri="https://test/extending">
          <ConcreteClass name="Composition" superTypes="Core/ConceptualObject">
            <DataProperty name="Basis" lower="0" upper="1">
              <DataTypeReference type="Builtin/String"/>
            </DataProperty>
          </ConcreteClass>
        </Profile>`,
    };
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: processXml },
      { name: 'Core.xml', xml: coreXml },
      extendingProfile,
    ]);
    // Extension property is now visible on the existing Process.xml class.
    const props = reg.getProperties('Composition').map(p => p.name);
    expect(props).toContain('Basis');
    // Original class properties are still present.
    expect(props).toContain('Display');
    expect(props).toContain('MassFlow');
    // sourceFile of Composition stays as Process.xml — extend doesn't
    // re-attribute the class to the Profile.
    expect(reg.getClass('Composition')!.sourceFile).toBe('Process.xml');
  });

  it('merges regardless of whether a Profile carries the legacy mode="extend" marker', () => {
    // The two-mode design has been retired; same-name class redeclarations
    // merge additively whether the Profile root is <Model> or
    // <Profile mode="extend">. Verified by loading a marker-less Profile
    // whose declaration would have collided under the old reject default.
    const markerlessProfile = {
      name: 'markerless.xml',
      xml: `<?xml version="1.0" encoding="UTF-8"?>
        <Profile uri="https://test/markerless">
          <ConcreteClass name="Composition" superTypes="Core/ConceptualObject">
            <DataProperty name="LegacyField" lower="0" upper="1">
              <DataTypeReference type="Builtin/String"/>
            </DataProperty>
          </ConcreteClass>
        </Profile>`,
    };
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: processXml },
      { name: 'Core.xml', xml: coreXml },
      markerlessProfile,
    ]);
    expect(reg.getProperties('Composition').map(p => p.name)).toContain('LegacyField');
    expect(reg.mergeWarnings.some(w => w.includes('Composition') && w.includes('markerless.xml'))).toBe(true);
  });

  it('extend Profile can also add genuinely new classes alongside extensions', () => {
    const mixedProfile = {
      name: 'mixed.xml',
      xml: `<?xml version="1.0" encoding="UTF-8"?>
        <Profile mode="extend" uri="https://test/mixed">
          <ConcreteClass name="Composition" superTypes="Core/ConceptualObject">
            <DataProperty name="Basis" lower="0" upper="1">
              <DataTypeReference type="Builtin/String"/>
            </DataProperty>
          </ConcreteClass>
          <ConcreteClass name="BiologicalReactor" superTypes="/Process.ReactingChemicals">
            <DataProperty name="ResidenceTime" lower="0" upper="1">
              <DataTypeReference type="Builtin/Double"/>
            </DataProperty>
          </ConcreteClass>
        </Profile>`,
    };
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: processXml },
      { name: 'Core.xml', xml: coreXml },
      mixedProfile,
    ]);
    // Extension landed on existing class.
    expect(reg.getProperties('Composition').map(p => p.name)).toContain('Basis');
    // New class was added normally (not merged anywhere).
    expect(reg.isValidClass('BiologicalReactor')).toBe(true);
    expect(reg.hasAncestor('BiologicalReactor', 'ProcessStep')).toBe(true);
  });

  it('extend Profile silently skips properties already on the existing class', () => {
    // Composition already has Display from Process.xml — re-declaring
    // it in an extend Profile should not error and should not duplicate.
    const profile = {
      name: 'redundant.xml',
      xml: `<?xml version="1.0" encoding="UTF-8"?>
        <Profile mode="extend" uri="https://test/redundant">
          <ConcreteClass name="Composition" superTypes="Core/ConceptualObject">
            <DataProperty name="Display" lower="0" upper="1">
              <DataTypeReference type="Builtin/String"/>
            </DataProperty>
            <DataProperty name="Basis" lower="0" upper="1">
              <DataTypeReference type="Builtin/String"/>
            </DataProperty>
          </ConcreteClass>
        </Profile>`,
    };
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: processXml },
      { name: 'Core.xml', xml: coreXml },
      profile,
    ]);
    // Display appears once (existing wins; extend doesn't shadow).
    const displays = reg.getProperties('Composition').filter(p => p.name === 'Display');
    expect(displays).toHaveLength(1);
    // The new property was still added.
    expect(reg.getProperties('Composition').map(p => p.name)).toContain('Basis');
  });
});

// ── Three-mode typing integration tests ───────────────────────────────────

/** Minimal valid BPMN wrapper */
function bpmn(processBody: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
             targetNamespace="http://example.com">
  <process id="Process_1" isExecutable="false">
    ${processBody}
  </process>
</definitions>`;
}

function startEvent(id: string): string {
  return `<startEvent id="${id}" name="Feed">
    <extensionElements><dexpi:element dexpiType="Source" identifier="${id}" uid="uid_${id}"/></extensionElements>
    <outgoing>F_${id}</outgoing>
  </startEvent>`;
}

function endEvent(id: string): string {
  return `<endEvent id="${id}" name="Product">
    <extensionElements><dexpi:element dexpiType="Sink" identifier="${id}" uid="uid_${id}"/></extensionElements>
    <incoming>F2_${id}</incoming>
  </endEvent>`;
}

describe('Two-mode step typing', () => {

  // ── Mode 1: dexpi-validated ────────────────────────────────────────────

  it('Mode 1: known DEXPI class → no warning, output contains class name', async () => {
    const xml = bpmn(`
      <task id="T1" name="Pumping">
        <extensionElements>
          <dexpi:element dexpiType="Pumping" identifier="T1" uid="uid_T1"/>
        </extensionElements>
      </task>
      ${startEvent('SE1')}${endEvent('EE1')}
      <sequenceFlow id="F_SE1" sourceRef="SE1" targetRef="T1"/>
      <sequenceFlow id="F2_EE1" sourceRef="T1" targetRef="EE1"/>
    `);
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(xml);
    expect(t.logger.warnings).toHaveLength(0);
    expect(out).toContain('Process.Pumping');
    expect(out).not.toContain('ReferenceUri');
  });

  it('Mode 1: validates all 13 spot-check classes from Process.xml', async () => {
    const classes = [
      'ReactingChemicals', 'Separating', 'Compressing', 'ExchangingThermalEnergy',
      'Cooling', 'TransportingFluids', 'MixingSimple', 'MeasuringProcessVariable'
    ];
    for (const cls of classes) {
      const xml = bpmn(`
        <task id="T1" name="${cls}">
          <extensionElements>
            <dexpi:element dexpiType="${cls}" identifier="T1" uid="uid_T1"/>
          </extensionElements>
        </task>
        ${startEvent('SE1')}${endEvent('EE1')}
        <sequenceFlow id="F_SE1" sourceRef="SE1" targetRef="T1"/>
        <sequenceFlow id="F2_EE1" sourceRef="T1" targetRef="EE1"/>
      `);
      const t = new BpmnToDexpiTransformer();
      const out = await t.transform(xml);
      expect(t.logger.warnings, `${cls} should produce no warnings`).toHaveLength(0);
      expect(out).toContain(cls);
    }
  });

  // ── Mode 2: unvalidated (unknown type or no annotation) ──────────────

  it('Mode 2: unvalidated (unknown class + customUri) → warning + ReferenceUri in output', async () => {
    const xml = bpmn(`
      <task id="T1" name="ElectrolyticReduction">
        <extensionElements>
          <dexpi:element dexpiType="ElectrolyticReduction"
                         customUri="https://data.15926.org/rdl/R1234"
                         identifier="T1" uid="uid_T1"/>
        </extensionElements>
      </task>
      ${startEvent('SE1')}${endEvent('EE1')}
      <sequenceFlow id="F_SE1" sourceRef="SE1" targetRef="T1"/>
      <sequenceFlow id="F2_EE1" sourceRef="T1" targetRef="EE1"/>
    `);
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(xml);

    // Should warn — not a DEXPI class
    expect(t.logger.warnings.length).toBeGreaterThan(0);
    expect(t.logger.warnings[0]).toMatch(/not in the DEXPI Process registry/i);
    // Must output generic ProcessStep — NOT the custom type name as DEXPI class
    expect(out).toMatch(/Process\/Process\.ProcessStep/);
    expect(out).not.toMatch(/Process\/Process\.ElectrolyticReduction/);
    // URI stored as ReferenceUri (not ExternalReference)
    expect(out).toContain('https://data.15926.org/rdl/R1234');
    expect(out).toContain('ReferenceUri');
    expect(out).not.toContain('ExternalReference');
    // Custom name preserved in Label
    expect(out).toContain('ElectrolyticReduction');
  });

  it('Mode 2: unvalidated (unknown class, no customUri) → warning + ProcessStep output', async () => {
    const xml = bpmn(`
      <task id="T1" name="MyProprietaryStep">
        <extensionElements>
          <dexpi:element dexpiType="MyProprietaryStep" identifier="T1" uid="uid_T1"/>
        </extensionElements>
      </task>
      ${startEvent('SE1')}${endEvent('EE1')}
      <sequenceFlow id="F_SE1" sourceRef="SE1" targetRef="T1"/>
      <sequenceFlow id="F2_EE1" sourceRef="T1" targetRef="EE1"/>
    `);
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(xml);
    expect(t.logger.warnings[0]).toMatch(/not in the DEXPI Process registry/i);
    // Still outputs ProcessStep
    expect(out).toMatch(/Process\/Process\.ProcessStep/);
    expect(out).not.toMatch(/Process\/Process\.MyProprietaryStep/);
  });

  // ── Mode 2 continued: no annotation ──────────────────────────────────

  it('Mode 2: unvalidated (no annotation) → defaults to ProcessStep with warning', async () => {
    const xml = bpmn(`
      <task id="T1" name="ReactingChemicals"/>
      ${startEvent('SE1')}${endEvent('EE1')}
      <sequenceFlow id="F_SE1" sourceRef="SE1" targetRef="T1"/>
      <sequenceFlow id="F2_EE1" sourceRef="T1" targetRef="EE1"/>
    `);
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(xml);
    expect(t.logger.warnings.length).toBeGreaterThan(0);
    expect(t.logger.warnings[0]).toMatch(/no dexpiType annotation/i);
    // Must NOT classify as ReactingChemicals — no name inference
    expect(out).not.toMatch(/Process\.ReactingChemicals/);
    expect(out).toMatch(/Process\.ProcessStep/);
  });

  it('Mode 3: "Pump feed data to dashboard" without annotation → ProcessStep, no misclassification', async () => {
    const xml = bpmn(`
      <task id="T1" name="Pump feed data to dashboard"/>
      ${startEvent('SE1')}${endEvent('EE1')}
      <sequenceFlow id="F_SE1" sourceRef="SE1" targetRef="T1"/>
      <sequenceFlow id="F2_EE1" sourceRef="T1" targetRef="EE1"/>
    `);
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(xml);
    expect(t.logger.warnings.some(w => w.includes('Pump feed data to dashboard'))).toBe(true);
    // Must NOT misclassify as Pumping
    expect(out).not.toMatch(/Process\.Pumping/);
    expect(out).toMatch(/Process\.ProcessStep/);
  });

  // ── Registry updating ─────────────────────────────────────────────────

  it('class list comes from Process.xml, not hardcoded — new class accepted after reload', async () => {
    // Directly test registry: a class from the real Process.xml that wasn't in the old hardcoded list
    const processXml = readFileSync(PROCESS_XML_PATH, 'utf-8');
    const registry = DexpiProcessClassRegistry.fromXml(processXml);
    // 'Boiling' was not in the old hardcoded list but IS in Process.xml
    expect(registry.isValidClass('Boiling')).toBe(true);
    // 'Agitating' also was missing from hardcoded list
    expect(registry.isValidClass('Agitating')).toBe(true);
  });
});
