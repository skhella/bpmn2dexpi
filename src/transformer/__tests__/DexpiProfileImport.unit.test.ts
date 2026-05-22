/**
 * DEXPI Profile import — integration coverage.
 *
 * Profiles let users extend the bundled Process.xml + Core.xml registry
 * with project-specific class declarations at runtime, without rebuilding
 * the tool. This suite covers the round-trip:
 *
 *   1. Positive: a small BPMN annotates a task with a Profile-defined
 *      class. With the Profile loaded, transform() recognizes the class,
 *      emits it in DEXPI XML output, and the strict-mode property-name
 *      validator accepts the Profile-declared property names.
 *
 *   2. Negative: the same BPMN without the Profile loaded triggers the
 *      existing Mode-2 fallback — transformer warns, falls back to abstract
 *      ProcessStep, and output stays canonically valid.
 *
 *   3. Conflict / unresolved-supertype: malformed Profiles (clashing
 *      with Process.xml's class names, or referencing non-existent
 *      supertypes) are rejected at transform time with named errors.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { JSDOM } from 'jsdom';
import {
  BpmnToDexpiTransformer,
  validateDexpiPropertyNames,
} from '../BpmnToDexpiTransformer';
import { DexpiProcessClassRegistry } from '../DexpiProcessClassRegistry';

const dom = new JSDOM('<!DOCTYPE html>');
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
  Document: dom.window.Document,
  Element: dom.window.Element,
});

const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const PROFILE_PATH = join(__dirname, '../../../examples/profiles/sample-extension.xml');

const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');
const SAMPLE_PROFILE_XML = readFileSync(PROFILE_PATH, 'utf-8');

/**
 * Minimal BPMN fixture: one source → one task annotated with the Profile's
 * BiologicalReactor → one sink. Inline rather than another fixture file
 * since the test is its sole consumer.
 */
const BIOREACTOR_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
             targetNamespace="http://example.com/bio">
  <process id="Process_1" isExecutable="false">
    <startEvent id="SE1" name="Substrate Feed">
      <extensionElements>
        <dexpi:element dexpiType="Source" identifier="SE1" uid="uid_SE1"/>
      </extensionElements>
      <outgoing>F1</outgoing>
    </startEvent>
    <task id="T1" name="BiologicalReactor">
      <extensionElements>
        <dexpi:element dexpiType="BiologicalReactor" identifier="T1" uid="uid_T1"/>
      </extensionElements>
      <incoming>F1</incoming>
      <outgoing>F2</outgoing>
    </task>
    <endEvent id="EE1" name="Effluent">
      <extensionElements>
        <dexpi:element dexpiType="Sink" identifier="EE1" uid="uid_EE1"/>
      </extensionElements>
      <incoming>F2</incoming>
    </endEvent>
    <sequenceFlow id="F1" sourceRef="SE1" targetRef="T1"/>
    <sequenceFlow id="F2" sourceRef="T1" targetRef="EE1"/>
  </process>
</definitions>`;

describe('DEXPI Profile import', () => {
  it('positive: Profile-defined class is recognized + emitted + strict-validated', async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(BIOREACTOR_BPMN, {
      processXml: PROCESS_XML,
      coreXml: CORE_XML,
      profileXmls: [{ name: 'sample-extension.xml', xml: SAMPLE_PROFILE_XML }],
      strict: true,
    });

    // No 'not a recognised DEXPI class' warnings — the Profile is loaded.
    expect(
      t.logger.warnings.filter(w => /not in the DEXPI Process registry/i.test(w))
    ).toHaveLength(0);

    // Output emits the Profile's class (qualified to its declaring model
    // name 'SampleExtension', or as a bare-namespaced reference; the only
    // hard requirement is that the class name BiologicalReactor appears).
    expect(out).toContain('BiologicalReactor');
    // It must NOT have fallen back to ProcessStep with a customUri pointer.
    expect(out).not.toContain('ReferenceUri');

    // Strict-mode property-name validation passes against the merged
    // Process+Core+Profile registry.
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: PROCESS_XML },
      { name: 'Core.xml', xml: CORE_XML },
      { name: 'sample-extension.xml', xml: SAMPLE_PROFILE_XML },
    ]);
    const failures = validateDexpiPropertyNames(out, 'positive-profile-test', reg);
    expect(failures, JSON.stringify(failures.slice(0, 3), null, 2)).toEqual([]);
  });

  it('negative: same BPMN without Profile falls back to ProcessStep with a warning', async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(BIOREACTOR_BPMN, {
      processXml: PROCESS_XML,
      coreXml: CORE_XML,
      // No profileXmls — registry has only Process + Core.
      strict: true,
    });

    // Warning surfaces — BiologicalReactor isn't in Process.xml.
    expect(
      t.logger.warnings.some(w =>
        /not in the DEXPI Process registry/i.test(w) && /BiologicalReactor/.test(w)
      ),
      JSON.stringify(t.logger.warnings, null, 2)
    ).toBe(true);

    // Output uses ProcessStep, not BiologicalReactor.
    expect(out).toContain('Process/Process.ProcessStep');
    expect(out).not.toContain('Process/Process.BiologicalReactor');
    // The original class name is preserved as Label.
    expect(out).toContain('BiologicalReactor');

    // Strict-mode validation against just Process+Core still passes (the
    // emitted XML uses canonical names; ProcessStep is the fallback).
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: PROCESS_XML },
      { name: 'Core.xml', xml: CORE_XML },
    ]);
    const failures = validateDexpiPropertyNames(out, 'negative-no-profile-test', reg);
    expect(failures, JSON.stringify(failures.slice(0, 3), null, 2)).toEqual([]);
  });

  it('merges a Profile whose class name overlaps with Process.xml (uniform additive merge)', async () => {
    // Additive merge: same supertypes (supertype divergence throws — see
    // the divergence test below). Profile adds a new property to the
    // standard Pumping class; merge succeeds with a non-blocking warning
    // surfaced via the transformer logger.
    const overlappingProfile = `<?xml version="1.0" encoding="UTF-8"?>
      <Profile uri="https://test/overlap">
        <ConcreteClass name="Pumping" superTypes="/Process.GeneratingFlow">
          <DataProperty name="ProfileAddedField" lower="0" upper="1">
            <DataTypeReference type="Builtin/String"/>
          </DataProperty>
        </ConcreteClass>
      </Profile>`;
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(BIOREACTOR_BPMN, {
      processXml: PROCESS_XML,
      coreXml: CORE_XML,
      profileXmls: [{ name: 'overlap.xml', xml: overlappingProfile }],
    });
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    // The merge surfaced as a logger warning prefixed with "Profile merge:"
    // (BpmnToDexpiTransformer pipes registry.mergeWarnings through logger.warn
    // so every consumer — CLI, App.tsx export, Generate Profile — sees them).
    expect(
      t.logger.warnings.some(w => /Profile merge:.*Pumping.*overlap\.xml/.test(w))
    ).toBe(true);
  });

  it('rejects a Profile that overlaps with a Process.xml class but with divergent supertypes', async () => {
    // Supertype divergence is unsafe to merge silently — the additive
    // merge can't represent two different supertype lists. Throws with
    // a named-source diagnostic so the author can fix the Profile.
    const divergentProfile = `<?xml version="1.0" encoding="UTF-8"?>
      <Profile uri="https://test/divergent">
        <ConcreteClass name="Pumping" superTypes="Core/ConceptualObject"/>
      </Profile>`;
    const t = new BpmnToDexpiTransformer();
    await expect(
      t.transform(BIOREACTOR_BPMN, {
        processXml: PROCESS_XML,
        coreXml: CORE_XML,
        profileXmls: [{ name: 'divergent.xml', xml: divergentProfile }],
      })
    ).rejects.toThrow(/Pumping.*supertype divergence/is);
  });

  it('rejects a Profile that references an unknown supertype', async () => {
    const badProfile = `<?xml version="1.0" encoding="UTF-8"?>
      <Model name="BadSupertype" uri="https://test/badsuper">
        <ConcreteClass name="MyReactor" superTypes="/Process.NonExistentParent"/>
      </Model>`;
    const t = new BpmnToDexpiTransformer();
    await expect(
      t.transform(BIOREACTOR_BPMN, {
        processXml: PROCESS_XML,
        coreXml: CORE_XML,
        profileXmls: [{ name: 'bad.xml', xml: badProfile }],
      })
    ).rejects.toThrow(/unresolved supertype.*NonExistentParent/is);
  });
});
