import React, { useState } from 'react';
import { DexpiProcessClassRegistry } from '../transformer/DexpiProcessClassRegistry';

/**
 * Quantity (unit-enum) picker for a measurement whose authored unit token does
 * NOT resolve against the standard `PhysicalQuantities` vocabulary.
 *
 * This is the unit-world analog of the "Custom (Profile-extension)" property /
 * basis dropdowns: when a user authors a unit the schema doesn't know, the
 * Profile generator can only close the gap if it knows WHICH quantity (unit
 * enumeration) the missing literal belongs to. That placement is never guessed
 * from the unit's or property's name — it comes from exactly two non-heuristic
 * sources, mirroring the generator's own `collectUnresolvedUnits` logic:
 *
 *   1. **Declared measurement** — the schema already binds the property to a
 *      `PhysicalQuantity` with a concrete `UnitType` (e.g. `MassFlow` ->
 *      `MassFlowRateUnit`). No choice is required; the generator folds the new
 *      literal into that bound enum. The picker shows this as an info chip.
 *   2. **Custom measurement** — no schema binding exists (e.g. a user-invented
 *      `MoleFlow`). The user must pick the quantity; the choice is persisted as
 *      the `unitEnum` attribute on the `<dexpi:components>` carrier and the
 *      generator declares the property BOUND to that enum and adds the literal.
 *
 * With NO binding and NO choice, the unit is unplaceable: the picker surfaces a
 * warning (the value is still exported — DEXPI 2.0's permissive philosophy — but
 * the unit stays a strict-mode finding until a quantity is chosen).
 *
 * Rendering is conditional: the picker returns `null` when there is no unit, or
 * when the unit already resolves (nothing to place). So adding it to an editor
 * row is inert for the common case and only appears when a real gap exists.
 */
export interface QuantityPickerProps {
  /** Carrier class the measurement sits on (MaterialStateType, PureMaterialComponent, …). */
  className: string;
  /** The measurement property name (MoleFlow, MassFlow, …). */
  propName: string;
  /** The authored unit token (KilomolePerHour, Kelvin, …). */
  unit: string | undefined;
  /** The explicit quantity (unit-enum) choice currently stored, if any. */
  unitEnum: string | undefined;
  registry: DexpiProcessClassRegistry | null;
  /** Persist the chosen quantity (bare enum name), or `undefined` to clear it. */
  onChange: (unitEnum: string | undefined) => void;
}

const CUSTOM = '__custom__';

/** Bare enum name from a qualified ref (Core/PhysicalQuantities.X -> X). */
function bareEnumName(ref: string): string {
  return ref.split(/[./]/).pop() ?? ref;
}

export const QuantityPicker: React.FC<QuantityPickerProps> = ({
  className, propName, unit, unitEnum, registry, onChange,
}) => {
  const enumNames = registry?.unitEnumNames() ?? [];
  // Custom mode is implied when the stored choice isn't one of the schema's
  // known enums (a brand-new quantity the user is typing). Seed local state
  // from that so re-opening an editor row shows the text input.
  const hasCustomValue = unitEnum != null && unitEnum !== '' && !enumNames.includes(unitEnum);
  const [customMode, setCustomMode] = useState(hasCustomValue);

  const token = (unit ?? '').trim();
  // Inert unless there's a real gap: no unit, registry unavailable, or the unit
  // already resolves against the standard vocabulary -> nothing to place.
  if (!registry || token === '' || registry.resolveUnitGlobal(token)) return null;

  // Declared measurement? The schema's DataTypeBinding names the quantity; no
  // choice required. This is the "custom unit on a declared property" path.
  const boundRef = propName ? registry.getUnitEnumRefForProperty(className, propName) : null;
  if (boundRef) {
    return (
      <div style={{ fontSize: '0.8em', color: '#555', marginTop: '3px' }}>
        Custom unit <code>{token}</code> → added to{' '}
        <code>{bareEnumName(boundRef)}</code> (the quantity{' '}
        <code>{propName || 'this property'}</code> is bound to in the schema).
      </div>
    );
  }

  // Custom measurement: the user must pick the quantity. Same Custom-extension
  // dropdown pattern as the property / basis pickers.
  const showCustom = customMode || hasCustomValue;
  const isKnownEnum = unitEnum != null && unitEnum !== '' && enumNames.includes(unitEnum);
  const selectValue = showCustom ? CUSTOM : (isKnownEnum ? unitEnum : '');

  return (
    <div style={{ marginTop: '3px' }}>
      <label style={{ fontSize: '0.8em', display: 'flex', flexDirection: 'column' }}>
        <span style={{ color: '#666' }}>Quantity (unit enum) *</span>
        <select
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '') { setCustomMode(false); onChange(undefined); }
            else if (v === CUSTOM) { setCustomMode(true); onChange(hasCustomValue ? unitEnum : ''); }
            else { setCustomMode(false); onChange(v); }
          }}
        >
          <option value="">— choose a quantity —</option>
          {enumNames.map(n => <option key={n} value={n}>{n}</option>)}
          <option value={CUSTOM}>Custom (new quantity) …</option>
        </select>
      </label>
      {showCustom && (
        <input
          type="text"
          value={unitEnum ?? ''}
          placeholder="e.g. MoleFlowRateUnit"
          onChange={(e) => onChange(e.target.value)}
          style={{ marginTop: '2px', width: '100%' }}
        />
      )}
      {(unitEnum == null || unitEnum === '') && (
        <div style={{ fontSize: '0.78em', color: '#a60', marginTop: '2px' }}>
          ⚠ No quantity chosen — <code>{token}</code> can't be placed on a
          standard unit enum, so it stays a strict-mode finding (the value is
          still exported).
        </div>
      )}
    </div>
  );
};
