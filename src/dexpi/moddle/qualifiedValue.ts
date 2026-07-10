/**
 * Canonical Core/QualifiedValue carrier helpers for the BPMN authoring side.
 *
 * "Canonical everywhere": a unit-bearing measurement is serialised in the
 * DEXPI 2.0 information-model shape — the numeric Value(s) and the Unit live
 * inside a nested
 *   <dexpi:data property="Value">
 *     <dexpi:aggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity(Vector)">
 *       <dexpi:data property="Unit">…</dexpi:data>
 *       <dexpi:data property="Value">…</dexpi:data>      (scalar)
 *       <dexpi:data property="Values">…</dexpi:data> …   (vector)
 *     </dexpi:aggregatedDataValue>
 *   </dexpi:data>
 * rather than as flat <dexpi:data property="Unit"> siblings. The homegrown
 * <UnitReference> Data child is never emitted (D6).
 *
 * Building and reading that shape lives here so every panel emits and parses
 * it identically (no per-panel drift), and the transformer's readQvScalar /
 * composition reader consume it unchanged.
 */

/** Minimal structural view of a moddle element (moddle itself is untyped). */
export interface ModdleElement {
  $type?: string;
  $body?: string;
  $children?: ModdleElement[];
  $attrs?: Record<string, string>;
  property?: string;
  body?: string;
  type?: string;
  data?: ModdleElement[];
  aggregatedDataValue?: ModdleElement;
}

/** moddle's element factory: create(descriptorName, props). */
export interface ModdleFactory {
  create(type: string, props?: Record<string, unknown>): ModdleElement;
}

const PHYSICAL_QUANTITY = 'Core/PhysicalQuantities.PhysicalQuantity';
const PHYSICAL_QUANTITY_VECTOR = 'Core/PhysicalQuantities.PhysicalQuantityVector';

/**
 * Build the `Value` Data child of a Core/QualifiedValue scalar. With a unit
 * the value is wrapped in the canonical nested PhysicalQuantity carrier; with
 * no unit it is a flat `<dexpi:data property="Value">v</dexpi:data>`. No flat
 * Unit sibling, no UnitReference.
 */
export function buildCanonicalScalarValue(
  moddle: ModdleFactory,
  value: string,
  unit?: string,
): ModdleElement {
  if (unit && unit.trim()) {
    return moddle.create('dexpi:Data', {
      property: 'Value',
      aggregatedDataValue: moddle.create('dexpi:AggregatedDataValue', {
        type: PHYSICAL_QUANTITY,
        data: [
          moddle.create('dexpi:Data', { property: 'Unit', body: unit }),
          moddle.create('dexpi:Data', { property: 'Value', body: value }),
        ],
      }),
    });
  }
  return moddle.create('dexpi:Data', { property: 'Value', body: value });
}

/**
 * Build the `Value` Data child of a Core/QualifiedValue vector — a nested
 * PhysicalQuantityVector carrier holding the Unit (when present) and one
 * `<dexpi:data property="Values">` per component. The vector carrier is how
 * the transformer's composition reader recognises a fraction vector, so it is
 * always emitted; an absent unit simply omits the Unit Data child.
 */
export function buildCanonicalVectorValue(
  moddle: ModdleFactory,
  values: string[],
  unit?: string,
): ModdleElement {
  const advData: ModdleElement[] = [];
  if (unit && unit.trim()) {
    advData.push(moddle.create('dexpi:Data', { property: 'Unit', body: unit }));
  }
  for (const v of values) {
    advData.push(moddle.create('dexpi:Data', { property: 'Values', body: v }));
  }
  return moddle.create('dexpi:Data', {
    property: 'Value',
    aggregatedDataValue: moddle.create('dexpi:AggregatedDataValue', {
      type: PHYSICAL_QUANTITY_VECTOR,
      data: advData,
    }),
  });
}

const childProp = (el: ModdleElement): string | undefined =>
  el.property ?? el.$attrs?.property;

const childBody = (el: ModdleElement): string =>
  (el.body ?? el.$body ?? '').toString().trim();

/** The nested <aggregatedDataValue> under a `Value` Data child, if any. */
function aggregatedChild(dataChild: ModdleElement): ModdleElement | undefined {
  if (dataChild.aggregatedDataValue) return dataChild.aggregatedDataValue;
  return (dataChild.$children ?? []).find(
    c => (c.$type || '').toLowerCase().includes('aggregateddatavalue'),
  );
}

/**
 * Read `{ value, unit }` out of a QualifiedValue Object's Data children,
 * preferring the canonical nested PhysicalQuantity carrier and falling back to
 * the legacy flat Value + sibling Unit so pre-canonical saves still load. The
 * nested form wins when both are present.
 */
export function readCanonicalScalar(
  qvDataChildren: ModdleElement[],
): { value: string; unit?: string } {
  let value = '';
  let unit: string | undefined;
  for (const dc of qvDataChildren) {
    const dp = childProp(dc);
    if (dp === 'Value') {
      const adv = aggregatedChild(dc);
      if (adv) {
        for (const ad of adv.data ?? adv.$children ?? []) {
          const adp = childProp(ad);
          if (adp === 'Value') value = childBody(ad);
          else if (adp === 'Unit') unit = childBody(ad);
        }
      } else {
        value = childBody(dc);
      }
    } else if (dp === 'Unit' && unit === undefined) {
      // Legacy flat unit (pre-canonical save). Nested wins when both present.
      const b = childBody(dc);
      if (b) unit = b;
    }
  }
  return unit ? { value, unit } : { value };
}

/**
 * Read `{ values, unit }` for a vector QualifiedValue, preferring the nested
 * PhysicalQuantityVector carrier and falling back to flat Values + Unit.
 */
export function readCanonicalVector(
  qvDataChildren: ModdleElement[],
): { values: string[]; unit?: string } {
  const values: string[] = [];
  let unit: string | undefined;
  let container = qvDataChildren;
  const valueChild = qvDataChildren.find(dc => childProp(dc) === 'Value');
  if (valueChild) {
    const adv = aggregatedChild(valueChild);
    if (adv) container = adv.data ?? adv.$children ?? [];
  }
  for (const c of container) {
    const p = childProp(c);
    if (p === 'Values') values.push(childBody(c));
    else if (p === 'Unit') {
      const b = childBody(c);
      if (b) unit = b;
    }
  }
  return unit ? { values, unit } : { values };
}
