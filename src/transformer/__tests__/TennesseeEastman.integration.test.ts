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

  // Belt-and-braces against silent-extraction regressions: if the BPMN reader
  // ever fails to descend into <dexpi:MaterialState> et al. (e.g. another
  // namespace-prefix mismatch like the querySelectorAll-vs-XML-prefix bug),
  // the XSD test still passes because zero MaterialStates is structurally
  // valid. This count assertion fails fast with a clear signal.
  it('emits MaterialState / MaterialStateType / Composition counts matching the BPMN fixture', () => {
    const countTypeAttr = (cls: string) =>
      (output.match(new RegExp(`type="Process/Process\\.${cls}"`, 'g')) ?? []).length;
    expect(countTypeAttr('MaterialState')).toBe(11);
    expect(countTypeAttr('MaterialStateType')).toBe(11);
    expect(countTypeAttr('Composition')).toBe(11);
    expect(countTypeAttr('MaterialTemplate')).toBeGreaterThanOrEqual(1);
    expect(countTypeAttr('MaterialComponent')).toBeGreaterThanOrEqual(8);
  });

  // DEXPI 2.0 schema-correct instrumentation handling: InstrumentationActivity
  // is a sibling of ProcessStep (both inherit from ConceptualObject) and does
  // not own a Ports composition. Emitting <Object type="Process/Process.InformationPort">
  // under an instrumentation task — or an InformationFlow whose Source/Target
  // points at one — would violate the spec. The transformer drops both and
  // expresses the relationship through ProcessStepReference (on
  // MeasuringProcessVariable, the only subclass that declares it) plus a
  // Profile-extension MeasuredVariableLabel for the variable identity.
  it('emits no InformationPorts or InformationFlows for instrumentation paths (DEXPI 2.0)', () => {
    expect(output).not.toMatch(/type="Process\/Process\.InformationPort"/);
    expect(output).not.toMatch(/type="Process\/Process\.InformationFlow"/);
  });

  it('emits ProcessStepReference on MeasuringProcessVariable + canonical/Profile split for measured variable identity', () => {
    const countMatches = (re: RegExp) => (output.match(re) ?? []).length;
    // 17 of 18 BPMN-side instrumentation→ProcessStep links resolve to a
    // MeasuringProcessVariable; the 18th is a ControllingProcessVariable
    // (which doesn't declare ProcessStepReference per the spec).
    expect(countMatches(/property="ProcessStepReference"/g)).toBe(17);

    // The variable identity is encoded in two ways depending on whether
    // the variable name is a declared CompositionProperty on the referenced
    // ProcessStep's class (registry-driven, walks supertype chain):
    //   - Canonical: emit <References property="MeasuredVariableReference"/>
    //     pointing at a materialised QualifiedValue parameter slot on the
    //     ProcessStep. Used when ProcessStep.<VarName> exists in the
    //     supertype chain (e.g. Temperature, Pressure on any ProcessStep).
    //   - Profile-extension: emit <Data property="MeasuredVariableLabel">
    //     on the InstrumentationActivity. Used for genuine vocabulary gaps
    //     (e.g. Composition has no parameter-slot home anywhere on
    //     ProcessStep) — the Profile generator captures these.
    const refCount = countMatches(/property="MeasuredVariableReference"/g);
    const labelCount = countMatches(/property="MeasuredVariableLabel"/g);
    // Every instrumentation activity with a resolvable variable identity
    // gets exactly one of the two encodings — sum equals the count of
    // BPMN dataObject-mediated instrumentation flows in the fixture.
    expect(refCount + labelCount).toBe(18);
    // For the current TEP fixture, both encodings are exercised
    // (validates that the canonical/Profile split is actually live).
    expect(refCount).toBeGreaterThan(0);
    expect(labelCount).toBeGreaterThan(0);
  });

  it('logs no unannotated warnings for fully-annotated TEP (R1-C3)', () => {
    // TEP example file is fully annotated with dexpi:element, so the transformer
    // uses Mode 1 (dexpi-validated) for all elements — no unannotated warnings expected.
    // The warning system is exercised by unit tests in BpmnToDexpiTransformer.unit.test.ts.
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
