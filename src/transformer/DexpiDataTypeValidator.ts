/**
 * DexpiDataTypeValidator
 *
 * Third-tier validation pass over emitted DEXPI XML. Complements:
 *   - DexpiOutputValidator      (XSD: structural well-formedness)
 *   - DexpiPropertyNameValidator (information model: property names + carrier kinds)
 *   - DexpiDataTypeValidator    (this: value-level data-type conformance)
 *
 * For each `<Data property="X">value</Data>` whose declared type is a
 * Builtin primitive or an Enumeration, this validator checks that `value`
 * conforms:
 *
 *   - Builtin/Boolean    → value ∈ {'true','false','0','1'}
 *   - Builtin/Integer    → /^-?\d+$/
 *   - Builtin/Double     → finite float (parseFloat result)
 *   - Builtin/UnsignedByte → 0–255 integer
 *   - Builtin/DateTime   → ISO-8601 parseable (Date.parse not NaN)
 *   - Builtin/AnyURI     → URI shape (cheap regex; full RFC 3986 is overkill)
 *   - Builtin/String     → always valid (any text)
 *   - Builtin/Undefined  → always valid (placeholder for unknown union members)
 *   - Enumeration ref    → value ∈ literal names from registry.getEnumerationLiterals
 *   - Other class refs   → not validated here (out of scope: target-class checking)
 *
 * The XSD does not perform these checks because `<Data>` content is a
 * generic xsd:string in the DEXPI XSD; the data type lives in the
 * information model (Process.xml + Core.xml), separate from the XSD.
 *
 * As with the property-name validator, classes not in the registry are
 * skipped silently (could be loaded elsewhere). Properties whose declared
 * targetType resolves to an unknown enum or non-Builtin/Enum class
 * reference are also skipped — this validator is intentionally narrow.
 */

import type { DexpiProcessClassRegistry } from './DexpiProcessClassRegistry';

export interface DataTypeFailure {
  /** Free-text label identifying the source XML (e.g. filename). */
  source: string;
  /** Wrapping class against which the property was looked up. */
  className: string;
  /** Property name (e.g. 'Provenance', 'NumberOfPhases'). */
  propertyName: string;
  /** Declared data type (e.g. 'Builtin/Double', '/Enumerations.PortDirection'). */
  declaredType: string;
  /** Actual value emitted in the XML. */
  actualValue: string;
  /** Short context for diagnostic display. */
  context: string;
}

/** Internal: render a list of failures as a multi-line summary. */
export function formatDataTypeFailures(failures: DataTypeFailure[]): string {
  if (failures.length === 0) return '';
  const grouped = new Map<string, DataTypeFailure[]>();
  for (const f of failures) {
    const key = `${f.source} :: ${f.className}.${f.propertyName} (declared ${f.declaredType})`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(f);
  }
  const lines: string[] = [
    `${failures.length} data-type fidelity violation(s) (${grouped.size} unique):`,
  ];
  for (const [key, items] of grouped) {
    lines.push(`  ✗ ${key}  (×${items.length})`);
    lines.push(`      e.g. ${items[0].context}`);
  }
  return lines.join('\n');
}

// ── Type-classification helpers ────────────────────────────────────────────

/** Return true if `s` parses as an ISO-8601 date that JS recognises. */
function isIsoDateTime(s: string): boolean {
  if (!s.match(/^\d{4}-\d{2}-\d{2}/)) return false;
  return !Number.isNaN(Date.parse(s));
}

/**
 * Cheap URI shape check — "scheme:something" with at least a few chars.
 * Full RFC 3986 is overkill for our purposes; we just want to flag
 * obviously-wrong strings (e.g. plain numbers passed as URIs).
 */
function isUriShape(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\S+/.test(s);
}

function checkBuiltin(typeRef: string, value: string): boolean | null {
  // Strip common prefixes; inputs are like 'Builtin/Boolean'.
  const bare = typeRef.replace(/^Builtin\//, '');
  switch (bare) {
    case 'Boolean':       return /^(true|false|0|1)$/.test(value);
    case 'Integer':       return /^-?\d+$/.test(value);
    case 'Double':        return value !== '' && Number.isFinite(parseFloat(value));
    case 'UnsignedByte': {
      if (!/^\d+$/.test(value)) return false;
      const n = parseInt(value, 10);
      return n >= 0 && n <= 255;
    }
    case 'DateTime':      return isIsoDateTime(value);
    case 'AnyURI':        return isUriShape(value);
    case 'String':        return true;
    case 'Undefined':     return true;
    default:              return null; // unknown builtin: don't claim a verdict
  }
}

/**
 * Strip a typeRef path down to its bare type name.
 *   '/Enumerations.PortDirection'      → 'PortDirection'
 *   'Core/Enumerations.QuantityRange'  → 'QuantityRange'
 *   '/DataTypes.MultiLanguageString'   → 'MultiLanguageString'
 *   'Builtin/Double'                   → 'Double' (caller usually handles Builtin/ separately)
 */
function bareTypeName(typeRef: string): string {
  // Take last segment after '/' or '.'; drop namespace prefix.
  const lastSlash = typeRef.lastIndexOf('/');
  const tail = lastSlash >= 0 ? typeRef.slice(lastSlash + 1) : typeRef;
  const lastDot = tail.lastIndexOf('.');
  return lastDot >= 0 ? tail.slice(lastDot + 1) : tail;
}

/**
 * Validate one Data value against a declared targetType. Returns:
 *   - true  → value conforms (or type is out of scope; no failure)
 *   - false → value does not conform (caller emits a failure)
 *   - null  → type unknown / not a checkable kind; skip
 */
function validateValueAgainstType(
  value: string,
  declaredType: string,
  registry: DexpiProcessClassRegistry,
): boolean | null {
  // 1. Builtin types — direct check.
  if (declaredType.startsWith('Builtin/')) {
    return checkBuiltin(declaredType, value);
  }
  // 2. Enumeration types — bare name must match a literal in the registry.
  const bare = bareTypeName(declaredType);
  const literals = registry.getEnumerationLiterals(bare);
  if (literals) {
    return literals.includes(value);
  }
  // 3. Other type refs (DataTypes, class refs) — out of scope here.
  return null;
}

// ── Main validator ──────────────────────────────────────────────────────────

/**
 * Walk the emitted DEXPI XML. For every `<Data property="X">value</Data>`
 * whose declared type on the wrapping class is a checkable kind (Builtin
 * or Enumeration), validate `value` against the type. Failures are
 * returned as DataTypeFailure[]; an empty array means the model is
 * data-type-clean.
 *
 * Aggregated DataType inlining (PhysicalQuantity Value/Unit, Vector
 * Values/Unit) is honored: `Value`/`Values`/`Unit` inside a
 * `<Object type="Core/QualifiedValue">` are mapped to Double/String
 * respectively. The full set of inlined names lives in
 * QUALIFIED_VALUE_INLINED_DATATYPES below.
 */
const QUALIFIED_VALUE_INLINED_DATATYPES: Map<string, string> = new Map([
  // QualifiedValue's own DataProperties (Process.xml-declared) include
  // Provenance / Range / Scope / Case / CaseUID — those are reachable via
  // the registry's property lookup so we don't list them here. The
  // entries below are the AggregatedDataType-inlined ones the registry
  // can't see (PhysicalQuantity contributes Value+Unit; Vector
  // contributes Values+Unit) — sourced from DEXPI's Core schema.
  ['Value',  'Builtin/Double'],
  ['Values', 'Builtin/Double'],
  ['Unit',   'Builtin/String'],
]);

export function validateEmittedDexpiDataTypes(
  xml: string,
  source: string,
  registry: DexpiProcessClassRegistry,
): DataTypeFailure[] {
  const failures: DataTypeFailure[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  // Walk every <Data property="X"> in the document.
  const dataElements = Array.from(doc.getElementsByTagName('Data')) as Element[];
  for (const el of dataElements) {
    const propName = el.getAttribute('property');
    if (!propName) continue;

    // Find nearest enclosing <Object type="...">.
    let parent: Element | null = el.parentElement;
    while (parent && parent.tagName !== 'Object') parent = parent.parentElement;
    if (!parent) continue;
    const typeAttr = parent.getAttribute('type');
    if (!typeAttr) continue;

    // Bare class name (e.g. 'Process/Process.Stream' → 'Stream').
    const className = bareClassName(typeAttr);
    if (!registry.isValidClass(className)) continue; // unknown class — skip

    // Resolve the property's declared targetType. For QualifiedValue's
    // Value/Values/Unit, prefer the AggregatedDataType-inlined types over
    // whatever the registry may surface — Core.xml declares these with
    // UnionDataType (Undefined|String) which is too loose to be useful;
    // the actual semantics come from PhysicalQuantity/Vector binding.
    let declaredType: string | undefined;
    if (className === 'QualifiedValue' && QUALIFIED_VALUE_INLINED_DATATYPES.has(propName)) {
      declaredType = QUALIFIED_VALUE_INLINED_DATATYPES.get(propName);
    } else {
      const props = registry.getProperties(className);
      const prop = props.find(p => p.name === propName);
      declaredType = prop?.targetType;
    }

    if (!declaredType) continue; // unknown property or unannotated kind — skip

    // Extract value text — use textContent, trim whitespace.
    const value = (el.textContent ?? '').trim();
    if (value === '') continue; // empty value (placeholder; permitted)

    const verdict = validateValueAgainstType(value, declaredType, registry);
    if (verdict === false) {
      failures.push({
        source,
        className,
        propertyName: propName,
        declaredType,
        actualValue: value,
        context: `<Data property="${propName}">${value}</Data> inside <Object type="${typeAttr}"> — declared ${declaredType}`,
      });
    }
  }

  return failures;
}

/** Bare class name extraction (mirrors DexpiPropertyNameValidator's helper). */
function bareClassName(typeRef: string): string {
  // Strip namespace prefix and package prefix:
  //   'Core/EngineeringModel'              → 'EngineeringModel'
  //   'Core/QualifiedValue'                → 'QualifiedValue'
  //   'Process/Process.ReactingChemicals'  → 'ReactingChemicals'
  //   '/Process.MaterialState'             → 'MaterialState'
  let s = typeRef;
  const lastSlash = s.lastIndexOf('/');
  if (lastSlash >= 0) s = s.slice(lastSlash + 1);
  const lastDot = s.lastIndexOf('.');
  if (lastDot >= 0) s = s.slice(lastDot + 1);
  return s;
}
