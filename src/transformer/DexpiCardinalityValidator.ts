/**
 * DexpiCardinalityValidator
 *
 * Tier-5 validation: every property on every emitted Object satisfies its
 * declared cardinality bounds (lower / upper) on the wrapping class.
 *
 * Two kinds of violations:
 *   - Missing-required: a property with lower≥1 has fewer values
 *     than required (most commonly: not present at all, lower=1).
 *   - Exceeds-upper: a property has more values than `upper` allows
 *     (e.g. two `<Data property="Identifier">` carriers when upper=1).
 *
 * What's checked vs counted:
 *   - For each <Object>, count the VALUES of each declared property.
 *     Cardinality bounds constrain values, not carrier elements, and the
 *     DEXPI XML grammar allows one carrier to aggregate several values:
 *       - <Data>: each value element child (Double, String, DataReference,
 *         AggregatedDataValue, Undefined, …) is one value. The official
 *         Reference P&ID serializes e.g. PolyLine.Points (lower=2) as one
 *         <Data> holding N <AggregatedDataValue> children.
 *       - <Components>: each Object / ObjectReference child is one value.
 *       - <References>: carries no children — its `objects` attribute is a
 *         whitespace-separated list of targets; each token is one value.
 *     Values are summed across repeated carriers for the same property
 *     (this tool's own emitter writes one value per carrier; both styles
 *     are grammar-legal and count identically).
 *     A carrier with no values (empty <Data/>, empty objects="") counts 0 —
 *     that shape violates the XML Schema, which the XSD tier reports; an
 *     explicit <Undefined/> child counts 1 (the property is present, its
 *     value deliberately undefined).
 *   - Compare against the registered `lower` / `upper` bounds for that
 *     property on the Object's class (walking supertypes).
 *
 * What's intentionally out of scope:
 *   - Cross-Object cardinality (e.g. Source must occur exactly once per
 *     ProcessModel) — would require global-document state. Most DEXPI
 *     class-level cardinality is already per-Object, captured here.
 */

import type { DexpiProcessClassRegistry } from './DexpiProcessClassRegistry';

export interface CardinalityFailure {
  source: string;
  /** Wrapping class. */
  className: string;
  /** Property name. */
  propertyName: string;
  /** Declared lower bound. */
  expectedLower: number;
  /** Declared upper bound (null = unbounded; reported as "*"). */
  expectedUpper: number | null;
  /** Actual number of values observed on the offending Object. */
  actualCount: number;
  /** ID of the offending Object (or '(no id)' if none was present). */
  objectId: string;
  /** Diagnostic context. */
  context: string;
}

export function formatCardinalityFailures(failures: CardinalityFailure[]): string {
  if (failures.length === 0) return '';
  const grouped = new Map<string, CardinalityFailure[]>();
  for (const f of failures) {
    const key = `${f.source} :: ${f.className}.${f.propertyName} (declared [${f.expectedLower}..${f.expectedUpper ?? '*'}])`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(f);
  }
  const lines: string[] = [
    `${failures.length} cardinality violation(s) (${grouped.size} unique):`,
  ];
  for (const [key, items] of grouped) {
    lines.push(`  ✗ ${key}  (×${items.length})`);
    lines.push(`      e.g. ${items[0].context}`);
  }
  return lines.join('\n');
}

/**
 * Walk every <Object> in the emitted DEXPI XML, count the values of each
 * declared property, and flag deviations from the schema's `lower`/`upper`
 * bounds.
 */
export function validateEmittedDexpiCardinality(
  xml: string,
  source: string,
  registry: DexpiProcessClassRegistry,
): CardinalityFailure[] {
  const failures: CardinalityFailure[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  for (const obj of Array.from(doc.getElementsByTagName('Object'))) {
    const typeAttr = obj.getAttribute('type');
    if (!typeAttr) continue;
    const className = bareClassName(typeAttr);
    if (!registry.isValidClass(className)) continue;

    // Count values per property across this Object's direct carrier
    // children. Direct children only — descendant Objects (compositions)
    // are validated when the loop reaches them on their own iteration, and
    // value children of a carrier (e.g. AggregatedDataValue) are counted
    // here without recursing into them.
    const counts = new Map<string, number>();
    for (const child of Array.from(obj.children) as Element[]) {
      const tag = child.tagName;
      if (tag !== 'Data' && tag !== 'References' && tag !== 'Components') continue;
      const propName = child.getAttribute('property');
      if (!propName) continue;
      const values = tag === 'References'
        ? (child.getAttribute('objects') ?? '').trim().split(/\s+/).filter(Boolean).length
        : child.children.length;
      counts.set(propName, (counts.get(propName) ?? 0) + values);
    }

    // For each declared property on this class (incl. supertypes), check
    // that the observed count satisfies [lower, upper].
    const props = registry.getProperties(className);
    const objectId = obj.getAttribute('id') ?? '(no id)';
    for (const prop of props) {
      const actual = counts.get(prop.name) ?? 0;
      const lower = prop.lower;
      const upper = prop.upper; // null = unbounded

      if (actual < lower) {
        // Missing required (or below lower bound).
        failures.push({
          source,
          className,
          propertyName: prop.name,
          expectedLower: lower,
          expectedUpper: upper,
          actualCount: actual,
          objectId,
          context: `<Object id="${objectId}" type="${typeAttr}"> is missing required property "${prop.name}" ` +
            `(declared lower=${lower}, observed ${actual})`,
        });
        continue;
      }

      if (upper !== null && actual > upper) {
        failures.push({
          source,
          className,
          propertyName: prop.name,
          expectedLower: lower,
          expectedUpper: upper,
          actualCount: actual,
          objectId,
          context: `<Object id="${objectId}" type="${typeAttr}"> has ${actual} values of "${prop.name}" ` +
            `(declared upper=${upper})`,
        });
      }
    }
  }

  return failures;
}

function bareClassName(typeRef: string): string {
  let s = typeRef;
  const lastSlash = s.lastIndexOf('/');
  if (lastSlash >= 0) s = s.slice(lastSlash + 1);
  const lastDot = s.lastIndexOf('.');
  if (lastDot >= 0) s = s.slice(lastDot + 1);
  return s;
}
