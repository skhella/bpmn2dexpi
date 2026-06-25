/**
 * Unit-vocabulary gaps close through the SAME validate → generate → reload loop
 * as missing-property gaps — and placement is SCHEMA-DRIVEN, not a name heuristic.
 *
 * The generator finds an authored unit the registry can't resolve and places it
 * on the unit enum the DEXPI schema BINDS to the carrying property (the
 * property's <DataTypeBinding ... PhysicalQuantity.UnitType> chain, read by
 * getUnitEnumRefForProperty). A bound literal folds into that Core enum, so its
 * DataReference uses the imported Core prefix and validates.
 *
 * A property with NO declared unit binding — like the custom
 * MaterialStateType.MoleFlow here — cannot be placed on an importable Core
 * quantity, and a profile-namespaced enum would emit an unimported (invalid)
 * DataReference. So the generator does NOT guess: it WARNS to bind the property
 * to a quantity (the explicit user choice) and emits no unit extension. MoleFlow
 * stays fail-closed; the output remains valid.
 */
import { describe, it, expect } from 'vitest';
import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';
import { DexpiProcessClassRegistry } from '../DexpiProcessClassRegistry';
import { generateProfileFromDexpiXml } from '../DexpiProfileGenerator';

const MOLEFLOW_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
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
          <dexpi:components property="MoleFlow">
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

describe('Unit-vocabulary gap — schema-driven placement, no heuristics', () => {
  it('unbound property: generator warns to bind a quantity and emits no (invalid) unit extension', async () => {
    const emitted = await new BpmnToDexpiTransformer().transform(MOLEFLOW_BPMN);
    const baseReg = await DexpiProcessClassRegistry.loadDefault();
    const profile = generateProfileFromDexpiXml(emitted, baseReg, { bpmnXml: MOLEFLOW_BPMN });

    // MoleFlow declares no unit binding → cannot be placed on an importable Core
    // quantity, so the generator warns (bind it) and does NOT emit a unit enum.
    expect(
      profile.warnings.some(w => /quantity/i.test(w) && /bind/i.test(w)),
      `expected a "bind the property" warning; got: ${profile.warnings.join(' | ')}`,
    ).toBe(true);
    expect(profile.xml, 'no unit extension emitted for an unbindable unit').not.toMatch(
      /<Package name="PhysicalQuantities">/,
    );

    // Reload stays valid: MoleFlow remains fail-closed (bare Double), with no
    // unresolved/unimported unit DataReference.
    const closed = await new BpmnToDexpiTransformer().transform(MOLEFLOW_BPMN, {
      profileXmls: [{ name: 'GeneratedProfile.xml', xml: profile.xml }],
    });
    expect(closed, 'value preserved').toMatch(/<Double>11\.2<\/Double>/);
    expect(closed, 'no invalid unit DataReference').not.toMatch(/\.KilomolePerHour"/);
  });
});
