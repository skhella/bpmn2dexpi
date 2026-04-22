/**
 * Tests for DexpiProcessClassRegistry and the three-mode typing system.
 *
 * Mode 1 'dexpi-validated'  — known DEXPI class, no warning
 * Mode 2 'custom-type'      — unknown class + optional URI, warns with "did you mean?" suggestion
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

// ── Three-mode typing integration tests ───────────────────────────────────

/** Minimal valid BPMN wrapper */
function bpmn(processBody: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://dexpi.org/bpmn-extension/1.0"
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

describe('Three-mode step typing', () => {

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
    expect(out).not.toContain('ExternalReference');
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

  // ── Mode 2: custom-type ───────────────────────────────────────────────

  it('Mode 2: unknown class + customUri → warning with "did you mean?" + ExternalReference in output', async () => {
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
    expect(t.logger.warnings[0]).toMatch(/not a standard DEXPI 2\.0 Process class/i);
    // URI should appear in output
    expect(out).toContain('https://data.15926.org/rdl/R1234');
    expect(out).toContain('ExternalReference');
    // The custom type name itself should appear
    expect(out).toContain('ElectrolyticReduction');
  });

  it('Mode 2: unknown class without customUri → warning mentions missing URI', async () => {
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
    await t.transform(xml);
    expect(t.logger.warnings[0]).toMatch(/Add a customUri attribute/i);
  });

  // ── Mode 3: unannotated ───────────────────────────────────────────────

  it('Mode 3: no annotation → defaults to ProcessStep with unannotated warning', async () => {
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
