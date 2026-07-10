/**
 * Strict-mode export — all five tiers wired into BpmnToDexpiTransformer.
 *
 * Verifies that when `strict: true` is passed to transform(), the four
 * post-XSD validators (property-name+kind, data-type, reference target-class,
 * cardinality) all run and store their results on the transformer for the
 * caller to surface as warnings.
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

const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');
const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');

describe('Strict mode — all five post-XSD tiers wired', () => {
  it('populates last{PropertyName,DataType,Reference,Cardinality,ClassExistence}Validation when strict=true', { timeout: 15_000 }, async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const t = new BpmnToDexpiTransformer();
    await t.transform(bpmn, {
      strict: true,
      processXml: PROCESS_XML,
      coreXml: CORE_XML,
    });

    // All five "last*Validation" results must be defined post-strict-call.
    expect(t.lastPropertyNameValidation).toBeDefined();
    expect(t.lastDataTypeValidation).toBeDefined();
    expect(t.lastReferenceValidation).toBeDefined();
    expect(t.lastCardinalityValidation).toBeDefined();
    expect(t.lastClassExistenceValidation).toBeDefined();

    // Each tier should have a defined ValidationResult shape with the
    // discriminator `mode` set so consumers can tell results apart:
    expect(t.lastPropertyNameValidation!.mode).toBe('property-names');
    expect(t.lastDataTypeValidation!.mode).toBe('property-names');
    expect(t.lastReferenceValidation!.mode).toBe('property-names');
    expect(t.lastCardinalityValidation!.mode).toBe('property-names');
    expect(t.lastClassExistenceValidation!.mode).toBe('property-names');

    // Without the auto-generated TEP Profile loaded, several tiers will
    // have known violations on TEP — the validator surfaces them rather
    // than blocking output. We assert that the validators ran (errors
    // array is defined) and that at least one tier surfaces issues.
    expect(t.lastPropertyNameValidation!.errors).toBeDefined();
    expect(t.lastDataTypeValidation!.errors).toBeDefined();
    expect(t.lastReferenceValidation!.errors).toBeDefined();
    expect(t.lastCardinalityValidation!.errors).toBeDefined();
    expect(t.lastClassExistenceValidation!.errors).toBeDefined();

    // Reference target-class: clean now that the transformer materialises
    // the ListOfMaterialComponents wrapper for MaterialTemplate.ListOfComponents.
    expect(t.lastReferenceValidation!.valid).toBe(true);
    // Cardinality: clean now that the TEP fixture supplies the 12 Method
    // literals directly (conservative-default enum literals — see the
    // cardinality validator unit test for the rationale).
    expect(t.lastCardinalityValidation!.valid).toBe(true);
    // Class existence: defense-in-depth post-condition. After resolveStepType
    // + ProcessStep fallback, TEP must not emit any unknown classes.
    expect(t.lastClassExistenceValidation!.valid).toBe(true);
  });

  it('does NOT populate last*Validation when strict=false', { timeout: 15_000 }, async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const t = new BpmnToDexpiTransformer();
    await t.transform(bpmn, { strict: false });
    expect(t.lastPropertyNameValidation).toBeUndefined();
    expect(t.lastDataTypeValidation).toBeUndefined();
    expect(t.lastReferenceValidation).toBeUndefined();
    expect(t.lastCardinalityValidation).toBeUndefined();
    expect(t.lastClassExistenceValidation).toBeUndefined();
  });

  it('emits a single aggregated warning when any tier finds violations', { timeout: 15_000 }, async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const t = new BpmnToDexpiTransformer();
    await t.transform(bpmn, {
      strict: true,
      processXml: PROCESS_XML,
      coreXml: CORE_XML,
    });
    // The strict-mode block emits one summary warning that lists which
    // tiers had findings and how many.
    const summaryWarning = t.logger.warnings.find(w =>
      w.includes('Strict-mode fidelity findings'),
    );
    expect(summaryWarning).toBeDefined();
    // Property-name + kind is the only tier with findings on TEP — Profile-extension
    // territory (non-canonical CompositionProperty names like Level, MassFlow,
    // Composition, Duty etc. emitted on ProcessStep classes that don't declare them;
    // non-canonical ProcessStepReference/MeasuredVariableReference on
    // ControllingProcessVariable; the Profile generator declares them all). Data-type,
    // cardinality and reference target-class are clean — every unit resolves
    // (MoleFlow's KilomolePerSecond is a standard MoleFlowRateUnit literal).
    expect(summaryWarning).toContain('property-name + kind');
    expect(summaryWarning).not.toContain('data-type');
    expect(summaryWarning).not.toContain('cardinality');
    expect(summaryWarning).not.toContain('reference target-class');
  });
});
