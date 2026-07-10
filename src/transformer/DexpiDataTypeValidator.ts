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
  /**
   * True when this finding is an extension-closeable VOCABULARY gap rather than a
   * value-conformance error: a unit `<DataReference>` whose literal is missing
   * from its `PhysicalQuantities` enumeration, which the Profile generator closes
   * by adding the literal. This is a cross-cutting ATTRIBUTE, not a separate
   * validation level — it lets a consumer distinguish, within the data-type
   * findings, the gaps the generator auto-closes (units) from the authoring
   * errors it cannot (a typoed Double or a non-member of a closed enum like
   * QuantityProvenance). Property-name and class-existence findings are wholly
   * closeable in the same sense.
   */
  closeable?: boolean;
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
 *   'Core/DataTypes.QuantityRange'     → 'QuantityRange'
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
 * Walk the emitted DEXPI XML. This tier validates two things, both of which
 * the reference paper folds into the single "data type" dimension ("data
 * values are validated against their declared types — built-in primitives or
 * enumeration literals"):
 *
 *   1. Inline `<Data property="X">value</Data>` text whose declared type on the
 *      wrapping class is a Builtin primitive or an Enumeration. The wrapping
 *      class is the nearest enclosing <Object type="…"> OR <AggregatedDataValue
 *      type="…"> — so a nested PhysicalQuantity's Value validates as a Double
 *      against PhysicalQuantity (not against the outer QualifiedValue). No
 *      QualifiedValue inlining table is needed any more: the AggregatedDataType
 *      classes are real classes in the registry now, so their Unit / Value /
 *      Values resolve directly.
 *   2. Enumeration `<DataReference data="Model/Package.Enum.Literal"/>` targets
 *      (D9). The XSD checks only the reference STRING shape, never whether the
 *      target exists; nothing else in the pipeline did either — which is why
 *      every stale `Core/Enumerations.*` / `PortDirectionClassification.*`
 *      target slipped through. Here each reference is split, its model prefix
 *      checked against the file's <Import>s, and its enum + literal resolved
 *      against the real imported enumerations. Unresolvable targets fail.
 *
 * Failures are returned as DataTypeFailure[]; an empty array means the model is
 * data-type-clean.
 */
export function validateEmittedDexpiDataTypes(
  xml: string,
  source: string,
  registry: DexpiProcessClassRegistry,
): DataTypeFailure[] {
  const failures: DataTypeFailure[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  // ── 1. Inline Data-value type conformance ───────────────────────────────
  const dataElements = Array.from(doc.getElementsByTagName('Data')) as Element[];
  for (const el of dataElements) {
    const propName = el.getAttribute('property');
    if (!propName) continue;

    // Nearest enclosing carrier that names a class — <Object> or
    // <AggregatedDataValue> (so nested PhysicalQuantity(Vector) properties
    // resolve against PhysicalQuantity, not the outer QualifiedValue).
    const carrier = nearestEnclosingTypedCarrier(el);
    if (!carrier) continue;
    const typeAttr = carrier.getAttribute('type');
    if (!typeAttr) continue;

    const className = bareClassName(typeAttr);
    if (!registry.isValidClass(className)) continue; // unknown class — skip

    const prop = registry.getProperties(className).find(p => p.name === propName);
    const declaredType = prop?.targetType;
    if (!declaredType) continue; // unknown property or unannotated kind — skip

    // Value text — DataReference-valued Data carries no text and is handled
    // by the reference pass below.
    const value = (el.textContent ?? '').trim();
    if (value === '') continue; // empty / placeholder — permitted

    const verdict = validateValueAgainstType(value, declaredType, registry);
    if (verdict === false) {
      failures.push({
        source,
        className,
        propertyName: propName,
        declaredType,
        actualValue: value,
        context: `<Data property="${propName}">${value}</Data> inside <${carrier.tagName} type="${typeAttr}"> — declared ${declaredType}`,
      });
    }
  }

  // ── 2. Enumeration DataReference target resolution (D9) ──────────────────
  // Map each <Import prefix="P" source="…/X.xml"/> to its model basename so a
  // reference's prefix resolves to the right imported model — keyed off the
  // file's own imports, never a hardcoded model name.
  const prefixToModel = new Map<string, string>();
  for (const imp of Array.from(doc.getElementsByTagName('Import'))) {
    const prefix = imp.getAttribute('prefix');
    if (!prefix) continue;
    const base = (imp.getAttribute('source') ?? '').split(/[\\/]/).pop() ?? '';
    prefixToModel.set(prefix, base.replace(/\.xml$/i, '') || prefix);
  }

  for (const ref of Array.from(doc.getElementsByTagName('DataReference'))) {
    const data = ref.getAttribute('data');
    if (!data) continue;

    const enclosingData = nearestEnclosing(ref, 'Data');
    const refPropName = enclosingData?.getAttribute('property') ?? '(reference)';
    const carrier = nearestEnclosingTypedCarrier(ref);
    const refClassName = carrier ? bareClassName(carrier.getAttribute('type') ?? '') : '(unknown)';
    // A unit reference (target enumeration in the PhysicalQuantities package) is
    // an extension-closeable vocabulary gap — the Profile generator adds the
    // missing literal — as opposed to a typoed closed-enum literal, which is an
    // authoring error. Tag it so a consumer can tell the two apart within the
    // data-type tier (read from the ref path's package segment, so it classifies
    // even when the enum/prefix doesn't resolve).
    const afterModel = data.includes('/') ? data.slice(data.indexOf('/') + 1) : data;
    const closeable = afterModel.split('.')[0] === 'PhysicalQuantities';
    const fail = (reason: string) => failures.push({
      source,
      className: refClassName,
      propertyName: refPropName,
      declaredType: 'DataReference (enumeration literal)',
      actualValue: data,
      context: `<DataReference data="${data}"/> on ${refClassName}.${refPropName} — ${reason}`
        + (closeable ? ' (auto-closeable by Profile extension)' : ''),
      closeable,
    });

    // Expect Model/Package.Enum.Literal. Relative refs ('/Package.Enum.Literal')
    // resolve against the current model and are not emitted by this exporter;
    // skip rather than false-flag.
    const slash = data.indexOf('/');
    if (slash <= 0) continue;
    const prefix = data.slice(0, slash);
    const rest = data.slice(slash + 1); // Package.Enum.Literal
    const lastDot = rest.lastIndexOf('.');
    if (lastDot <= 0) { fail('not of the form Model/Package.Enum.Literal'); continue; }
    const literal = rest.slice(lastDot + 1);
    const packageEnum = rest.slice(0, lastDot);

    const model = prefixToModel.get(prefix);
    if (!model) { fail(`model prefix "${prefix}" is not a declared <Import>`); continue; }

    const enumPath = `${model}/${packageEnum}`;
    const literals = registry.getQualifiedEnumLiterals(enumPath);
    if (!literals) { fail(`enumeration "${enumPath}" does not exist in the imported models`); continue; }
    if (!literals.includes(literal)) {
      fail(`literal "${literal}" is not a member of "${enumPath}" (members: ${literals.join(', ')})`);
    }
  }

  return failures;
}

/** Nearest enclosing element with the given tagName, or null. */
function nearestEnclosing(el: Element, tagName: string): Element | null {
  let p: Element | null = el.parentElement;
  while (p && p.tagName !== tagName) p = p.parentElement;
  return p;
}

/**
 * Nearest enclosing carrier that names a class via its `type` attribute — an
 * <Object> or an <AggregatedDataValue>. Returns null if neither is found.
 */
function nearestEnclosingTypedCarrier(el: Element): Element | null {
  let p: Element | null = el.parentElement;
  while (p && p.tagName !== 'Object' && p.tagName !== 'AggregatedDataValue') p = p.parentElement;
  return p;
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
