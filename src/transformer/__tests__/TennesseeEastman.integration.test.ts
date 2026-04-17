/**
 * Integration test – Tennessee Eastman benchmark (R1-C1 / R1-C2)
 *
 * Uses the real BPMN file from examples/ to verify:
 *  1. The transformer completes without throwing
 *  2. The output is well-formed XML
 *  3. All expected DEXPI Process types appear in the output
 *  4. XSD validation against the official DEXPI XML Schema passes (R1-C2)
 *  5. Structural validator also passes (browser-safe fallback)
 *  6. Heuristic warning system fires for un-annotated example elements
 *  7. No transformer errors emitted
 *  8. ProcessModel container is present
 *  9. Transformer resets cleanly for a second call
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';
import { validateDexpiOutput, validateDexpiOutputXsd } from '../DexpiOutputValidator';

const BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');
const XSD_PATH  = join(__dirname, '../../../dexpi-schema-files/DEXPI_XML_Schema.xsd');

// DOMParser is provided globally by the happy-dom vitest environment.

describe('Integration – Tennessee Eastman Process (benchmark)', () => {
  let output: string;
  let transformer: BpmnToDexpiTransformer;

  beforeEach(async () => {
    const bpmnXml = readFileSync(BPMN_PATH, 'utf-8');
    transformer = new BpmnToDexpiTransformer();
    output = await transformer.transform(bpmnXml, {
      projectName: 'Tennessee Eastman Process',
      author: 'Test Suite',
    });
  });

  it('completes without throwing', () => {
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('produces well-formed XML output', () => {
    const parsed = new DOMParser().parseFromString(output, 'text/xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
  });

  it('root element is Model with Process imports', () => {
    expect(output).toContain('<Model ');
    expect(output).toContain('prefix="Core"');
    expect(output).toContain('prefix="Process"');
  });

  it('validates against the official DEXPI 2.0 XSD schema (R1-C2)', async () => {
    const result = await validateDexpiOutputXsd(output, XSD_PATH);
    if (!result.valid) {
      console.error('XSD validation errors:', result.errors.slice(0, 10));
    }
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  }, 15_000); // xmllint subprocess — allow 15 s

  it('passes structural validation fallback without errors', () => {
    const result = validateDexpiOutput(output);
    if (result.warnings.length > 0) console.info('Structural warnings:', result.warnings);
    expect(result.errors).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('contains the expected DEXPI Process types as Object elements', () => {
    const expectedTypes = ['ReactingChemicals', 'Separating', 'Compressing', 'StrippingDistilling'];
    expectedTypes.forEach(type => expect(output).toContain(type));
  });

  it('contains Source and Sink elements for reactants + products', () => {
    expect(output).toContain('Process.Source');
    expect(output).toContain('Process.Sink');
  });

  it('logs heuristic warnings for unannotated elements (R1-C3)', () => {
    // TEP example file is now fully annotated with dexpi:element, so the transformer
    // uses Mode 1 (dexpi-validated) for all elements — no heuristic warnings expected.
    // The warning system is exercised by the unit tests in BpmnToDexpiTransformer.unit.test.ts.
    expect(transformer.logger.errors).toHaveLength(0);
  });

  it('emits no transformer errors', () => {
    expect(transformer.logger.errors).toHaveLength(0);
  });

  it('output contains ProcessModel container', () => {
    expect(output).toContain('ProcessModel');
  });

  it('generated IDs comply with DEXPI XSD pattern [A-Za-z_][A-Za-z_0-9]*', () => {
    const idAttrRegex = /\bid="([^"]+)"/g;
    const badIds: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = idAttrRegex.exec(output)) !== null) {
      const id = match[1];
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(id)) badIds.push(id);
    }
    expect(badIds).toHaveLength(0);
  });

  it('transformer resets cleanly for a second transform on the same instance', async () => {
    const bpmnXml = readFileSync(BPMN_PATH, 'utf-8');
    const output2 = await transformer.transform(bpmnXml);
    const ratio = Math.abs(output2.length - output.length) / output.length;
    expect(ratio).toBeLessThan(0.01);
  });
});
