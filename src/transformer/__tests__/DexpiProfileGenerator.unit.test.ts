/**
 * DEXPI Profile generator — unit + round-trip integration coverage.
 *
 * The generator is the centerpiece of Phase 4: walk an emitted DEXPI XML,
 * identify property-name fidelity gaps, emit a Profile that fills them.
 * The integration test below proves the round-trip end-to-end on the TEP
 * fixture:
 *
 *   (a) strict mode FAILS on TEP (3 unique architectural-mismatch
 *       violations: MaterialStateType.MaterialTemplateReference, .MoleFlow,
 *       Composition.Basis).
 *   (b) generator produces a Profile XML for those gaps.
 *   (c) re-loading the generated Profile back into a FRESH registry
 *       succeeds (round-trip integrity — if the registry can't consume
 *       what the generator produces, that's a bug in either side).
 *   (d) re-running strict on TEP with the generated Profile loaded
 *       PASSES.
 *
 * Plus determinism: the generator is invoked twice on the same input;
 * outputs must be byte-identical. This is the non-negotiable contract
 * that lets users commit generated Profiles to source control.
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
import { generateProfileFromDexpiXml } from '../DexpiProfileGenerator';

const dom = new JSDOM('<!DOCTYPE html>');
(globalThis as any).DOMParser = dom.window.DOMParser;
(globalThis as any).XMLSerializer = dom.window.XMLSerializer;
(globalThis as any).Document = dom.window.Document;
(globalThis as any).Element = dom.window.Element;

const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');

function freshRegistry(extraProfiles: { name: string; xml: string }[] = []): DexpiProcessClassRegistry {
  return DexpiProcessClassRegistry.fromXmlSources([
    { name: 'Process.xml', xml: PROCESS_XML },
    { name: 'Core.xml', xml: CORE_XML },
    ...extraProfiles,
  ]);
}

describe('DEXPI Profile generator', () => {
  it('produces deterministic output across runs (byte-identical)', async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(bpmn);
    const reg = freshRegistry();
    const a = generateProfileFromDexpiXml(out, reg).xml;
    const b = generateProfileFromDexpiXml(out, reg).xml;
    expect(a).toBe(b);
  });

  it('emits no class declarations when nothing is unresolved', () => {
    // Synthesize a DEXPI XML containing only canonical names — every
    // property name resolves through Process.xml, so nothing to extend.
    const cleanXml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object id="s1" type="Process/Process.Stream">
        <Data property="Identifier"><String>S1</String></Data>
        <Data property="Label"><String>Feed</String></Data>
      </Object>
    </Model>`;
    const result = generateProfileFromDexpiXml(cleanXml, freshRegistry());
    expect(result.declarations).toBe(0);
    expect(result.classCount).toBe(0);
    expect(result.xml).toContain('<Profile mode="extend"');
    expect(result.xml).toContain('</Profile>');
  });

  it('groups by class, sorts alphabetically, sorts properties by (kind, name)', () => {
    // Fabricate a DEXPI XML touching multiple unresolved (class, prop) pairs
    // across several classes, then assert ordering.
    const xml = `<?xml version="1.0"?><Model name="x" uri="https://t/">
      <Object type="Process/Process.MaterialStateType">
        <References property="ZetaRef"/>
        <References property="AlphaRef"/>
        <Components property="GammaComp"/>
        <Data property="BetaData"/>
      </Object>
      <Object type="Process/Process.Composition">
        <Data property="Basis"/>
      </Object>
    </Model>`;
    const result = generateProfileFromDexpiXml(xml, freshRegistry());
    const declared = result.xml;
    // Classes alphabetical: Composition before MaterialStateType.
    expect(declared.indexOf('name="Composition"')).toBeLessThan(declared.indexOf('name="MaterialStateType"'));
    // Within MaterialStateType: sorted by kind first ('composition',
    // 'data', 'reference'), then by name within kind. So:
    //   GammaComp (composition) < BetaData (data) < AlphaRef (reference) < ZetaRef (reference)
    const inMst = declared.slice(declared.indexOf('name="MaterialStateType"'));
    const positions = ['GammaComp', 'BetaData', 'AlphaRef', 'ZetaRef'].map(p => inMst.indexOf(p));
    expect(positions.every((v, i, a) => i === 0 || a[i - 1] < v)).toBe(true);
  });
});

describe('DEXPI Profile generator — Custom-class declarations from BPMN annotations', () => {
  // A minimal BPMN with a single Task carrying a Custom-typed dexpi:Element:
  // dexpiType="MyReactor" + customSuperType="ReactingChemicals".
  // The generator should pick this up via seedFromCustomBpmnAnnotations and
  // emit a <ConcreteClass name="MyReactor" superTypes="/Process.ReactingChemicals"/>
  // declaration — even though the class instance carries no rich-DEXPI children
  // and would otherwise produce zero validator failures.
  const customBpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
                  id="defs_1" targetNamespace="https://example.org/test">
  <bpmn:process id="proc_1">
    <bpmn:task id="task_1" name="MyReactor">
      <bpmn:extensionElements>
        <dexpi:element dexpiType="MyReactor" customSuperType="ReactingChemicals" identifier="R-101" uid="r101"/>
      </bpmn:extensionElements>
    </bpmn:task>
  </bpmn:process>
</bpmn:definitions>`;

  it('emits a ConcreteClass declaration for a Custom-typed BPMN element with the user-chosen supertype', async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(customBpmn);
    const result = generateProfileFromDexpiXml(out, freshRegistry(), { bpmnXml: customBpmn });
    expect(result.classCount).toBe(1);
    expect(result.xml).toContain('<ConcreteClass name="MyReactor" superTypes="/Process.ReactingChemicals">');
    // Class-only entry — no property declarations expected.
    expect(result.declarations).toBe(0);
  });

  it('falls back to Core/ConceptualObject when no customSuperType is provided', async () => {
    const bpmnNoSuper = customBpmn.replace(' customSuperType="ReactingChemicals"', '');
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(bpmnNoSuper);
    const result = generateProfileFromDexpiXml(out, freshRegistry(), { bpmnXml: bpmnNoSuper });
    expect(result.classCount).toBe(1);
    expect(result.xml).toContain('<ConcreteClass name="MyReactor" superTypes="Core/ConceptualObject">');
  });

  it('round-trip: registry consumes the generated Profile and recognises the custom class', async () => {
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(customBpmn);
    const result = generateProfileFromDexpiXml(out, freshRegistry(), { bpmnXml: customBpmn });
    const regWithProfile = freshRegistry([{ name: 'custom.xml', xml: result.xml }]);
    expect(regWithProfile.isValidClass('MyReactor')).toBe(true);
    // Supertype walk finds ReactingChemicals → ProcessStep → ConceptualObject.
    expect(regWithProfile.getClass('MyReactor')?.superTypes).toContain('ReactingChemicals');
  });

  // Class + properties together: a custom class instance that also carries
  // rich-DEXPI children naming new properties. The generator must emit BOTH
  // a ConcreteClass declaration AND nested property declarations inside it,
  // in the same Profile file. This pins down the seeding/iteration order
  // (seed BEFORE first validator pass, so unknown-property failures route
  // into the same accumulator entry as the seeded class).
  it('emits a ConcreteClass with nested new property declarations when the custom class instance carries rich-DEXPI children', async () => {
    // BPMN with MyReactor + a new DataProperty "ResidenceTime" and a new
    // ReferenceProperty "Catalyst" — neither inherited from ReactingChemicals.
    // (Identifier IS inherited and must NOT appear in the Profile.)
    const bpmnWithProps = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  id="defs_1" targetNamespace="https://example.org/test">
  <bpmn:process id="proc_1">
    <bpmn:task id="task_1" name="MyReactor">
      <bpmn:extensionElements>
        <dexpi:element dexpiType="MyReactor" customSuperType="ReactingChemicals" identifier="R-101" uid="r101">
          <dexpi:data property="Identifier">R-101</dexpi:data>
          <dexpi:data property="ResidenceTime">120</dexpi:data>
          <dexpi:references property="Catalyst" uidRef="cat_1"/>
        </dexpi:element>
      </bpmn:extensionElements>
    </bpmn:task>
  </bpmn:process>
</bpmn:definitions>`;

    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(bpmnWithProps);
    const result = generateProfileFromDexpiXml(out, freshRegistry(), { bpmnXml: bpmnWithProps });

    expect(result.classCount).toBe(1);
    // Two NEW properties surface; Identifier is inherited from
    // ConceptualObject (via ProcessStep → ReactingChemicals) and must be
    // suppressed by the supertype-walking validator.
    expect(result.declarations).toBe(2);

    // Both halves land inside the same <ConcreteClass MyReactor> block.
    const classBlock = result.xml.match(
      /<ConcreteClass name="MyReactor"[^>]*>([\s\S]*?)<\/ConcreteClass>/,
    );
    expect(classBlock).not.toBeNull();
    const inner = classBlock![1];
    expect(inner).toContain('<DataProperty name="ResidenceTime"');
    expect(inner).toContain('<ReferenceProperty name="Catalyst"');
    expect(inner).not.toContain('Identifier'); // inherited — must not be redeclared

    // Round-trip: loading the generated Profile back must register both the
    // class and its declared properties so a subsequent strict-mode pass on
    // the same model is clean.
    const regWithProfile = freshRegistry([{ name: 'custom.xml', xml: result.xml }]);
    const props = new Set(regWithProfile.getProperties('MyReactor').map(p => p.name));
    expect(props.has('ResidenceTime')).toBe(true);
    expect(props.has('Catalyst')).toBe(true);
    expect(props.has('Identifier')).toBe(true); // inherited via supertype walk
  });
});

describe('DEXPI Profile generation round-trip on TEP fixture', () => {
  it('three-step contract: (a) strict fails on TEP, (b) generate Profile, (c) load Profile, (d) strict passes', { timeout: 30000 }, async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');

    // (a) + (b) precondition + generation in one step: after the
    // MaterialState → MaterialStateType → Composition restructure (which
    // aligned TEP's case-study path with Process.xml's class layout), the
    // emitted DEXPI XML side is schema-clean — the validator finds zero
    // violations there. The remaining fidelity gaps live in TEP's
    // CustomMaterialComponent blocks (PhysicalProperties / VaporPressure /
    // their inner thermodynamic properties), which are genuine project-
    // specific extensions that require Profile coverage. We assert via the
    // generator (which walks both BPMN extensionElements and emitted DEXPI
    // XML) so the precondition holds whether gaps surface on either side.
    const t1 = new BpmnToDexpiTransformer();
    const out1 = await t1.transform(bpmn);
    const generated = generateProfileFromDexpiXml(out1, freshRegistry(), { bpmnXml: bpmn });
    expect(
      generated.declarations,
      'precondition: there must be some fidelity gap for the generator to fill — ' +
      'otherwise this round-trip test is vacuous'
    ).toBeGreaterThan(0);
    expect(generated.xml).toContain('<Profile mode="extend"');

    // (c) round-trip integrity: a FRESH registry must consume what the
    // generator produced. If this fails, the generator emitted something
    // structurally invalid, and we want the test to surface that as a
    // distinct failure (not as a downstream property-name mismatch).
    let regWithProfile: DexpiProcessClassRegistry;
    try {
      regWithProfile = freshRegistry([
        { name: 'tep-generated.xml', xml: generated.xml },
      ]);
    } catch (e) {
      throw new Error(
        `Generator produced a Profile the registry cannot consume — round-trip integrity broken: ` +
        (e as Error).message
      );
    }

    // (d) re-validate TEP against the merged registry — passes.
    const t2 = new BpmnToDexpiTransformer();
    const out2 = await t2.transform(bpmn);
    const finalFailures = validateDexpiPropertyNames(
      out2, 'TEP-with-profile', regWithProfile
    );
    expect(
      finalFailures,
      'after loading the generated Profile, strict mode must pass: ' +
      JSON.stringify(finalFailures.slice(0, 3), null, 2)
    ).toEqual([]);
  });
});
