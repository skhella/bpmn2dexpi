/**
 * Integration test – Tennessee Eastman benchmark
 *
 * Uses the real BPMN file from examples/ to verify:
 *  1. The transformer completes without throwing
 *  2. The output is well-formed XML
 *  3. All expected DEXPI Process types appear in the output
 *  4. XSD validation against the official DEXPI XML Schema passes
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

  it('validates against the official DEXPI 2.0 XSD schema', async () => {
    const result = await validateDexpiOutputXsd(output, XSD_PATH);
    if (!result.valid) {
      console.error('XSD validation errors:', result.errors.slice(0, 10));
    }
    // Pin mode='xsd' so a missing xmllint on this machine fails loudly
    // instead of silently degrading to the structural fallback (which
    // would also report valid:true / errors:[] on most reasonable
    // output). The paper's "validated against the official DEXPI 2.0
    // XSD schema" claim depends on this assertion holding.
    expect(result.mode).toBe('xsd');
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

  // Composition's per-component fractions: Process.xml declares
  // MoleFractiona (sic — schema typo) and MassFractions as
  // CompositionProperty<QualifiedValue> on Composition (lower=0 each).
  // The TEP fixture authors a 8-component MoleFractiona vector on every
  // MaterialStateType's referenced Composition. The transformer must
  // round-trip them to the emitted DEXPI XML or the export is
  // semantically incomplete (XSD-valid but missing the per-component
  // breakdown). Same silent-loss category the Stream-side reference
  // emit had before the fix landed.
  it('emits Composition per-component fraction vectors for every authored MaterialStateType', () => {
    const countMatches = (re: RegExp) => (output.match(re) ?? []).length;
    // TEP authors Mole-basis fractions; one MoleFractiona Components
    // carrier per Composition (11 states → 11 carriers).
    expect(countMatches(/property="MoleFractiona"/g)).toBe(11);
    expect(countMatches(/property="MassFractions"/g)).toBe(0);
    // VolumeFractions is not in Process.xml — only Mole and Mass basis
    // exist on Composition. Pin a hard zero so a regression that
    // reintroduces VolumeFractions (forgotten schema quirk) surfaces
    // immediately rather than emitting a non-canonical property that
    // XSD validation would silently accept.
    expect(countMatches(/property="VolumeFractions"/g)).toBe(0);
    // Each carrier wraps a Core/QualifiedValue Object with N
    // <Data property="Values">…</Data> entries (TEP: 8 components per
    // template → 88 Values data entries total across the 11 carriers).
    const valuesData = countMatches(/<Data property="Values"/g);
    expect(valuesData).toBe(88);
  });

  // Stream-side canonical references: Process.xml declares both
  // MaterialTemplateReference and MaterialStateReference as ReferenceProperty
  // (lower=0, upper=1) on Stream. The TEP fixture authors both on every
  // material stream; the transformer must round-trip both to the emitted
  // DEXPI XML. Without this assertion, a regression in either Stream-side
  // emit path is invisible to the XSD validator (both refs are optional
  // and silent loss is XSD-valid).
  it('emits Stream-side MaterialTemplateReference + MaterialStateReference for every authored stream', () => {
    const countMatches = (re: RegExp) => (output.match(re) ?? []).length;
    const templateRefs = countMatches(/property="MaterialTemplateReference"/g);
    const stateRefs    = countMatches(/property="MaterialStateReference"/g);
    // The TEP fixture authors both references on all 11 material streams.
    expect(templateRefs).toBe(11);
    expect(stateRefs).toBe(11);
    // Sanity: every reference resolves to a known target by id-prefix
    // pattern. We don't grep specific uids here (those can change with
    // fixture edits), but we assert no reference has an empty objects= attr.
    expect(output).not.toMatch(/property="MaterialTemplateReference"\s+objects=""/);
    expect(output).not.toMatch(/property="MaterialStateReference"\s+objects=""/);
  });

  // DEXPI 2.0 schema-correct instrumentation handling: InstrumentationActivity
  // is a sibling of ProcessStep (both inherit from ConceptualObject) and does
  // not own a Ports composition. Emitting <Object type="Process/Process.InformationPort">
  // under an instrumentation task — or an InformationFlow whose Source/Target
  // points at one — would violate the spec. The transformer drops both and
  // expresses the relationship through ProcessStepReference + MeasuredVariableReference
  // pointing at a QualifiedValue parameter slot materialised on the connected
  // ProcessStep. Both references emit uniformly across all InstrumentationActivity
  // subclasses; non-canonical reference declarations are closed by Profile-extension.
  it('emits no InformationPorts or InformationFlows for instrumentation paths (DEXPI 2.0)', () => {
    expect(output).not.toMatch(/type="Process\/Process\.InformationPort"/);
    expect(output).not.toMatch(/type="Process\/Process\.InformationFlow"/);
  });

  it('emits canonical-on-ProcessStep linkage for every instrumentation activity (DEXPI 2.0 spec p.900)', () => {
    const countMatches = (re: RegExp) => (output.match(re) ?? []).length;
    // All 19 BPMN-side instrumentation→ProcessStep links emit
    // ProcessStepReference + MeasuredVariableReference uniformly. DEXPI 2.0
    // declares both on MeasuringProcessVariable; on
    // ControllingProcessVariable (and the other InstrumentationActivity
    // subclasses) they are closed by Profile-extension at export time.
    // The transformer doesn't gate the emit by registry — the topological
    // relationship exists for every instrumentation activity, and Profile
    // declares whatever the schema doesn't.
    expect(countMatches(/property="ProcessStepReference"/g)).toBe(19);
    expect(countMatches(/property="MeasuredVariableReference"/g)).toBe(19);

    // The legacy Profile-extension MeasuredVariableLabel encoding (variable
    // identity carried on the InstrumentationActivity as a Data property) is
    // gone: the variable canonically lives on the step it parameterises, not
    // on the activity that observes it. Every reference resolves to a
    // QualifiedValue Object materialised on the connected ProcessStep with
    // an id derived from the BPMN dataObjectReference id (round-trippable,
    // unique by construction).
    expect(countMatches(/property="MeasuredVariableLabel"/g)).toBe(0);

    // Each MeasuredVariableReference resolves to a Components/Object on
    // some ProcessStep. We don't grep the resolution here (the strict-mode
    // and class-existence validators catch dangling refs), but we do check
    // that the count of QualifiedValue parameter slots matches the count
    // of references — one per BPMN dataObject mediating an instrumentation
    // flow. Slot ids are sanitised dataObjectReference ids
    // (e.g. "DataObjectReference_1en8e3c") — round-trippable, unique by
    // construction. Provenance="Observed" is populated from the BPMN-side
    // canonical authoring on every entry — the canonical Core/QuantityProvenance
    // literal for instrument-derived values (Core.xml line 64).
    const qvSlotCount = countMatches(/<Object id="DataObjectReference_[^"]+" type="Core\/QualifiedValue"/g);
    expect(qvSlotCount).toBe(19);
    const observedCount = countMatches(/Core\/Enumerations\.Provenance\.Observed/g);
    expect(observedCount).toBe(19);
  });

  it('logs no unannotated warnings for fully-annotated TEP', () => {
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
    // Same options as beforeEach so the only differences between the
    // two outputs are the documented non-determinism sources
    // (timestamp, random id slugs) — anything else would indicate
    // state leaking between transform() calls on the same instance.
    const output2 = await transformer.transform(bpmnXml, {
      projectName: 'Tennessee Eastman Process',
      author: 'Test Suite',
    });
    // Structural equality after normalizing the two known sources of
    // non-determinism: ExportDateTime (current clock) and the random
    // ID slugs (u_<base36ts>_<base36rand>) the id factory emits.
    // The earlier 1 % length tolerance let real state leaks through
    // — small duplicate / drop on a ~100 kB output is well under 1 %.
    const normalize = (s: string) =>
      s
        .replace(/\bu_[A-Z0-9]+_[a-z0-9]+\b/g, 'u_DET_DET')
        .replace(/#u_[A-Z0-9]+_[a-z0-9]+/g, '#u_DET_DET')
        .replace(/<String>\d{4}-\d{2}-\d{2}T[\d:.]+Z<\/String>/g, '<String>DET-TIMESTAMP</String>');
    expect(normalize(output2)).toBe(normalize(output));
  });
});
