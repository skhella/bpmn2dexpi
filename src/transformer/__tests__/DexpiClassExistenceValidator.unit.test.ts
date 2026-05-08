/**
 * Tier-6 class-existence validator — unit tests.
 *
 * Tier 6 is defense-in-depth: after the resolveStepType fallback chain,
 * the transformer should never emit an unknown class. These tests pin
 * that contract: for hand-crafted DEXPI XML with an unknown <Object type=>,
 * Tier 6 fires; for clean transformer output it stays silent.
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
import { validateEmittedDexpiClassExistence } from '../DexpiClassExistenceValidator';

const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');
const REGISTRY = DexpiProcessClassRegistry.fromXmlSources([
  { name: 'Process.xml', xml: PROCESS_XML },
  { name: 'Core.xml', xml: CORE_XML },
]);

describe('Tier 6: class-existence validator', () => {
  it('flags an Object whose declared type is unknown to the registry', () => {
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="o1" type="Process/Process.NotARealClass"/>
    </Model>`;
    const failures = validateEmittedDexpiClassExistence(xml, 'unit', REGISTRY);
    expect(failures).toHaveLength(1);
    expect(failures[0].className).toBe('NotARealClass');
    expect(failures[0].objectId).toBe('o1');
    expect(failures[0].typeRef).toBe('Process/Process.NotARealClass');
  });

  it('passes when every Object type is in the registry', () => {
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="o1" type="Process/Process.Stream"/>
      <Object id="o2" type="Core/QualifiedValue"/>
    </Model>`;
    expect(validateEmittedDexpiClassExistence(xml, 'unit', REGISTRY)).toEqual([]);
  });

  it('returns no failures when the registry is empty (caller bug, do not pretend)', () => {
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="o1" type="Process/Process.AnythingGoes"/>
    </Model>`;
    const empty = DexpiProcessClassRegistry.empty();
    expect(validateEmittedDexpiClassExistence(xml, 'unit', empty)).toEqual([]);
  });

  it('TEP regression: clean transformer output emits no unknown classes', async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(bpmn, {
      strict: true,
      processXml: PROCESS_XML,
      coreXml: CORE_XML,
    });
    const failures = validateEmittedDexpiClassExistence(out, 'TEP', REGISTRY);
    // After resolveStepType + ProcessStep fallback, no unknown classes should
    // make it into the output. Tier 6 is silent on a clean transformer run.
    expect(failures).toEqual([]);
    // And the strict-mode hook stores the same result.
    expect(t.lastClassExistenceValidation?.valid).toBe(true);
  });
});
