/**
 * Unit-vocabulary gaps close through the SAME validate → generate → reload loop
 * as missing-property gaps — and placement is SCHEMA/CHOICE-driven, never a name
 * heuristic.
 *
 * A custom unit-bearing property carries an explicit `unitEnum` quantity choice
 * (authored by the user — the analog of choosing a custom class's supertype).
 * The generator then emits a COHERENT extension:
 *   - the property declared BOUND to that quantity (the full QualifiedValue ->
 *     PhysicalQuantity -> UnitType DataTypeBinding, exactly as Core declares
 *     MassFlow), and
 *   - the missing literal added to that (Core) unit enum.
 * Both reference the always-imported Core prefix, so the output validates, and on
 * reload the unit resolves to Core/PhysicalQuantities.<Enum>.<Literal> — value
 * unchanged.
 *
 * With NO quantity choice and no schema binding, the unit can't be placed on an
 * importable Core quantity, so the generator warns (bind it) and emits nothing —
 * no guessing, no invalid (unimported) reference.
 */
import { describe, it, expect } from 'vitest';
import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';
import { DexpiProcessClassRegistry } from '../DexpiProcessClassRegistry';
import { generateProfileFromDexpiXml } from '../DexpiProfileGenerator';

function moleFlowBpmn(opts: { quantity?: string } = {}): string {
  const unitEnumAttr = opts.quantity ? ` unitEnum="${opts.quantity}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
             targetNamespace="http://example.com/bpmn">
  <process id="P1">
    <dataObjectReference id="DOR" name="Base Case MaterialStates" dataObjectRef="DO1">
      <extensionElements>
        <dexpi:MaterialState uid="uuid_MS">
          <dexpi:data property="Identifier">1</dexpi:data>
          <dexpi:references property="State" uidRef="uuid_MST"/>
        </dexpi:MaterialState>
        <dexpi:MaterialStateType uid="uuid_MST">
          <dexpi:data property="Identifier">1-State</dexpi:data>
          <dexpi:components property="MoleFlow"${unitEnumAttr}>
            <dexpi:object type="Core/QualifiedValue">
              <dexpi:data property="Value">
                <dexpi:aggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity">
                  <dexpi:data property="Unit">KilomolePerHour</dexpi:data>
                  <dexpi:data property="Value">11.2</dexpi:data>
                </dexpi:aggregatedDataValue>
              </dexpi:data>
            </dexpi:object>
          </dexpi:components>
        </dexpi:MaterialStateType>
      </extensionElements>
    </dataObjectReference>
    <dataObject id="DO1"/>
  </process>
</definitions>`;
}

describe('Unit-vocabulary gap — schema/choice-driven placement, no heuristics', () => {
  it('explicit quantity: generator emits a bound MoleFlow + extends Core MoleFlowRateUnit; reload resolves', async () => {
    const bpmn = moleFlowBpmn({ quantity: 'MoleFlowRateUnit' });
    const emitted = await new BpmnToDexpiTransformer().transform(bpmn);
    const baseReg = await DexpiProcessClassRegistry.loadDefault();
    const profile = generateProfileFromDexpiXml(emitted, baseReg, { bpmnXml: bpmn });

    // (a) MoleFlow is declared BOUND to MoleFlowRateUnit — the full UnitType chain,
    //     referenced on the always-imported Core prefix. Not guessed: from the
    //     authored `unitEnum` choice.
    expect(profile.xml, 'MoleFlow bound via DataTypeBinding').toMatch(
      /<DataTypeBinding parameter="Core\/PhysicalQuantities\.PhysicalQuantity\.UnitType">/,
    );
    expect(profile.xml, 'bound to MoleFlowRateUnit on the Core prefix').toMatch(
      /<DataTypeReference type="Core\/PhysicalQuantities\.MoleFlowRateUnit"\/>/,
    );
    // (b) The literal is added to MoleFlowRateUnit (folds into Core's enum).
    expect(profile.xml, 'MoleFlowRateUnit extended').toMatch(/<Enumeration name="MoleFlowRateUnit"/);
    expect(profile.xml, 'with KilomolePerHour').toMatch(/<EnumerationLiteral name="KilomolePerHour"\/>/);
    // Placed cleanly — no "bind the property" warning.
    expect(profile.warnings.filter(w => /bind/i.test(w)), profile.warnings.join(' | ')).toHaveLength(0);

    // Reload: MoleFlow resolves on the canonical Core path; value unchanged.
    const closed = await new BpmnToDexpiTransformer().transform(bpmn, {
      profileXmls: [{ name: 'GeneratedProfile.xml', xml: profile.xml }],
    });
    expect(closed, 'resolves on DEXPI MoleFlowRateUnit').toMatch(
      /Core\/PhysicalQuantities\.MoleFlowRateUnit\.KilomolePerHour/,
    );
    expect(closed, 'value never rescaled').toMatch(/<Double>11\.2<\/Double>/);
  });

  it('no quantity choice: generator warns to bind, emits no (invalid) unit extension', async () => {
    const bpmn = moleFlowBpmn(); // no unitEnum attribute
    const emitted = await new BpmnToDexpiTransformer().transform(bpmn);
    const baseReg = await DexpiProcessClassRegistry.loadDefault();
    const profile = generateProfileFromDexpiXml(emitted, baseReg, { bpmnXml: bpmn });

    expect(
      profile.warnings.some(w => /quantity/i.test(w) && /bind/i.test(w)),
      `expected a "bind the property" warning; got: ${profile.warnings.join(' | ')}`,
    ).toBe(true);
    expect(profile.xml, 'no unit extension for an unbindable unit').not.toMatch(
      /<Package name="PhysicalQuantities">/,
    );

    const closed = await new BpmnToDexpiTransformer().transform(bpmn, {
      profileXmls: [{ name: 'GeneratedProfile.xml', xml: profile.xml }],
    });
    expect(closed, 'value preserved (fail-closed)').toMatch(/<Double>11\.2<\/Double>/);
    expect(closed, 'no invalid unit DataReference').not.toMatch(/\.KilomolePerHour"/);
  });
});
