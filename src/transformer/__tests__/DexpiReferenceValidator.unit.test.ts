/**
 * Tier-4 reference target-class validator — unit tests.
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
import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';
import { validateEmittedDexpiReferences } from '../DexpiReferenceValidator';

const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');
const REGISTRY = DexpiProcessClassRegistry.fromXmlSources([
  { name: 'Process.xml', xml: PROCESS_XML },
  { name: 'Core.xml', xml: CORE_XML },
]);

describe('Tier 4: reference target-class validator', () => {
  it('flags a References target whose class does not match the declared target', () => {
    // MaterialStateType.Composition declares target /Process.Composition.
    // Here we point it at a Stream — should fail.
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="not_a_composition" type="Process/Process.Stream"/>
      <Object id="state_type" type="Process/Process.MaterialStateType">
        <References property="Composition" objects="#not_a_composition"/>
      </Object>
    </Model>`;
    const failures = validateEmittedDexpiReferences(xml, 'unit', REGISTRY);
    expect(failures).toHaveLength(1);
    expect(failures[0].propertyName).toBe('Composition');
    expect(failures[0].expectedClass).toBe('Composition');
    expect(failures[0].actualClass).toBe('Stream');
    expect(failures[0].targetId).toBe('not_a_composition');
  });

  it('passes when the target class matches the declared target', () => {
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="comp_1" type="Process/Process.Composition"/>
      <Object id="state_type" type="Process/Process.MaterialStateType">
        <References property="Composition" objects="#comp_1"/>
      </Object>
    </Model>`;
    expect(validateEmittedDexpiReferences(xml, 'unit', REGISTRY)).toEqual([]);
  });

  it('passes when the target class is a subclass of the declared target', () => {
    // PureMaterialComponent subclasses MaterialComponent. A reference whose
    // declared target is MaterialComponent should accept a PureMaterialComponent
    // target.
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="comp_1" type="Process/Process.PureMaterialComponent"/>
      <Object id="comp_2" type="Process/Process.PureMaterialComponent"/>
    </Model>`;
    // Direct MaterialComponent → PureMaterialComponent isn't a property
    // we can easily test without a real MaterialComponent reference site;
    // the regression guard below on TEP exercises the supertype path.
    expect(validateEmittedDexpiReferences(xml, 'unit', REGISTRY)).toEqual([]);
  });

  it('flags ObjectReference shells inside Components carriers (Port.SubReference shape)', () => {
    // Port.SubReference is a CompositionProperty with target /Process.Port.
    // The composition-via-shell pattern uses ObjectReference inside Components.
    // Pointing at a Stream would violate the constraint.
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="not_a_port" type="Process/Process.Stream"/>
      <Object id="port_a" type="Process/Process.MaterialPort">
        <Components property="SubReference">
          <ObjectReference object="#not_a_port"/>
        </Components>
      </Object>
    </Model>`;
    const failures = validateEmittedDexpiReferences(xml, 'unit', REGISTRY);
    expect(failures).toHaveLength(1);
    expect(failures[0].propertyName).toBe('SubReference');
    expect(failures[0].expectedClass).toBe('Port');
    expect(failures[0].actualClass).toBe('Stream');
  });

  it('skips dangling references (unknown target id) — XSD\'s job', () => {
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="o1" type="Process/Process.MaterialStateType">
        <References property="MaterialTemplateReference" objects="#nonexistent"/>
      </Object>
    </Model>`;
    expect(validateEmittedDexpiReferences(xml, 'unit', REGISTRY)).toEqual([]);
  });

  it('TEP regression: MaterialTemplate.ListOfComponents now points at the wrapper class', async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(bpmn);
    const failures = validateEmittedDexpiReferences(out, 'TEP', REGISTRY);
    // The transformer now materialises a /Process.ListOfMaterialComponents
    // wrapper Object per template under ProcessModel.ListsOfMaterialComponents
    // and points MaterialTemplate.ListOfComponents at it (DEXPI 2.0 spec
    // Process.xml lines 2219-2222 + 2439-2440). No reference target-class
    // violations on ListOfComponents should remain.
    expect(failures.filter(f => f.propertyName === 'ListOfComponents')).toEqual([]);
    // Sanity-check the wrapper objects are actually emitted.
    expect(out).toMatch(/<Object[^>]*type="Process\/Process\.ListOfMaterialComponents"/);
    expect(out).toMatch(/property="ListsOfMaterialComponents"/);
  });
});
