/**
 * Unit tests for DexpiOutputValidator (R1-C2)
 * Uses the actual DEXPI 2.0 output schema produced by BpmnToDexpiTransformer.
 */

import { describe, it, expect } from 'vitest';
import { validateDexpiOutput } from '../DexpiOutputValidator';

// A minimal valid DEXPI 2.0 output (matches transformer output shape)
const VALID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Model name="process-model" uri="http://example.org">
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
  <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
  <Object type="Core/EngineeringModel">
    <Components property="ConceptualModel">
      <Object id="uid-pm-1" type="Process/ProcessModel">
        <Components property="ProcessSteps">
          <Object id="uid-1" type="Process/Process.ReactingChemicals">
            <Data property="Identifier"><String>T1</String></Data>
          </Object>
          <Object id="uid-2" type="Process/Process.Source">
            <Data property="Identifier"><String>SE1</String></Data>
          </Object>
        </Components>
        <Components property="ProcessConnections">
          <Object id="uid-s1" type="Process/MaterialFlow"/>
        </Components>
      </Object>
    </Components>
  </Object>
</Model>`;

describe('DexpiOutputValidator', () => {

  it('accepts valid DEXPI 2.0 XML without errors', () => {
    const result = validateDexpiOutput(VALID_XML);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects malformed XML', () => {
    const result = validateDexpiOutput('<unclosed>');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('errors when root element is not Model', () => {
    const xml = `<NotModel><Import prefix="Core" source="x"/><Import prefix="Process" source="y"/>
      <Object id="a" type="Process/ProcessModel"/></NotModel>`;
    const result = validateDexpiOutput(xml);
    expect(result.errors.some(e => /Root element/i.test(e))).toBe(true);
  });

  it('errors when no Object elements are present', () => {
    const xml = `<Model name="x" uri="y">
      <Import prefix="Core" source="x"/>
      <Import prefix="Process" source="y"/>
    </Model>`;
    const result = validateDexpiOutput(xml);
    expect(result.errors.some(e => /No.*Object/i.test(e))).toBe(true);
  });

  it('errors when a ProcessStep Object is missing id', () => {
    const xml = `<Model name="x" uri="y">
      <Import prefix="Core" source="x"/>
      <Import prefix="Process" source="y"/>
      <Object type="Core/EngineeringModel">
        <Components property="ConceptualModel">
          <Object id="pm1" type="Process/ProcessModel">
            <Components property="ProcessSteps">
              <Object type="Process/Process.Pumping"/>
            </Components>
          </Object>
        </Components>
      </Object>
    </Model>`;
    const result = validateDexpiOutput(xml);
    expect(result.errors.some(e => /missing required 'id'/i.test(e))).toBe(true);
  });

  it('warns when no ProcessStep Objects are present', () => {
    const xml = `<Model name="x" uri="y">
      <Import prefix="Core" source="x"/>
      <Import prefix="Process" source="y"/>
      <Object type="Core/EngineeringModel">
        <Components property="ConceptualModel">
          <Object id="pm1" type="Process/ProcessModel"/>
        </Components>
      </Object>
    </Model>`;
    const result = validateDexpiOutput(xml);
    expect(result.warnings.some(w => /No ProcessStep/i.test(w))).toBe(true);
  });

  it('warns when Core import is missing', () => {
    const xml = `<Model name="x" uri="y">
      <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
      <Object id="a" type="Process/ProcessModel"/>
    </Model>`;
    const result = validateDexpiOutput(xml);
    expect(result.warnings.some(w => /Core/i.test(w))).toBe(true);
  });

  it('warns when Process import is missing', () => {
    const xml = `<Model name="x" uri="y">
      <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
      <Object id="a" type="Process/ProcessModel"/>
    </Model>`;
    const result = validateDexpiOutput(xml);
    expect(result.warnings.some(w => /Process/i.test(w))).toBe(true);
  });

  it('validates a ProcessModel container is present', () => {
    const xml = `<Model name="x" uri="y">
      <Import prefix="Core" source="x"/>
      <Import prefix="Process" source="y"/>
      <Object type="Core/EngineeringModel">
        <Object id="o1" type="Process/Process.Pumping"/>
      </Object>
    </Model>`;
    const result = validateDexpiOutput(xml);
    expect(result.warnings.some(w => /ProcessModel/i.test(w))).toBe(true);
  });
});
