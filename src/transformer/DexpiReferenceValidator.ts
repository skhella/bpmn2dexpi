/**
 * DexpiReferenceValidator
 *
 * Tier-4 validation: every `<References objects="#X"/>` and
 * `<ObjectReference object="#X"/>` must point at an object whose class
 * is the declared target class of the property — or a subclass thereof.
 *
 * Complements:
 *   - Tier 1: XSD                 (structural well-formedness, ID/IDREF integrity)
 *   - Tier 2: property-name+kind  (name presence on wrapping class, carrier kind)
 *   - Tier 3: data-type           (value-level Builtin / Enumeration conformance)
 *   - Tier 4: reference target    (this — class-of-target conformance)
 *   - Tier 5: cardinality         (lower/upper bounds — DexpiCardinalityValidator)
 *
 * What the XSD already enforces:
 *   - `objects="#X"` must point at SOME id="X" in the document (referential
 *     integrity at the XSD level).
 *
 * What the XSD does NOT enforce:
 *   - The CLASS of the referenced object. A `MaterialTemplateReference`
 *     pointing at a Stream gets through XSD validation. This validator
 *     catches that.
 *
 * Two carrier shapes are checked:
 *   - `<References property="X" objects="#a #b ..."/>`   (cross-object pointer)
 *   - `<Components property="X"><ObjectReference object="#X"/>...</Components>`
 *     (composition-via-shell — used by Port.SubReference)
 *
 * Inline `<Components ...><Object id="..." type="...">...</Object></Components>`
 * is NOT checked here — the type is right there on the inline Object, so
 * any class-of-target issue would be caught by the property-name+kind
 * validator's recursion.
 */

import type { DexpiProcessClassRegistry } from './DexpiProcessClassRegistry';

export interface ReferenceFailure {
  /** Free-text source label. */
  source: string;
  /** Wrapping class against which the property was looked up. */
  className: string;
  /** Property name (e.g. 'MaterialTemplateReference'). */
  propertyName: string;
  /** Declared target class (bare, e.g. 'MaterialTemplate'). */
  expectedClass: string;
  /** Actual class of the referenced object (bare, e.g. 'Stream'). */
  actualClass: string;
  /** ID of the offending target object. */
  targetId: string;
  /** Short context for diagnostic display. */
  context: string;
}

/** Render a list of failures as a multi-line summary. */
export function formatReferenceFailures(failures: ReferenceFailure[]): string {
  if (failures.length === 0) return '';
  const grouped = new Map<string, ReferenceFailure[]>();
  for (const f of failures) {
    const key = `${f.source} :: ${f.className}.${f.propertyName} → expected ${f.expectedClass}, got ${f.actualClass}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(f);
  }
  const lines: string[] = [
    `${failures.length} reference target-class violation(s) (${grouped.size} unique):`,
  ];
  for (const [key, items] of grouped) {
    lines.push(`  ✗ ${key}  (×${items.length})`);
    lines.push(`      e.g. ${items[0].context}`);
  }
  return lines.join('\n');
}

/**
 * Walk the emitted DEXPI XML. For every `<References objects="..."/>` and
 * `<ObjectReference object="..."/>`, verify the referenced object's class
 * matches the declared target class on the wrapping property.
 *
 * Cross-object resolution requires a pre-pass building an id→class map
 * across the entire document; this validator runs that pass internally.
 */
export function validateEmittedDexpiReferences(
  xml: string,
  source: string,
  registry: DexpiProcessClassRegistry,
): ReferenceFailure[] {
  const failures: ReferenceFailure[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  // ── Build id→class index ─────────────────────────────────────────────
  // Walk every <Object> in the document, record id → bare class name.
  const idToClass = new Map<string, string>();
  for (const obj of Array.from(doc.getElementsByTagName('Object'))) {
    const id = obj.getAttribute('id');
    const typeAttr = obj.getAttribute('type');
    if (id && typeAttr) idToClass.set(id, bareClassName(typeAttr));
  }

  // ── Tier 4a: References carriers (objects="#X #Y ...") ───────────────
  for (const refsEl of Array.from(doc.getElementsByTagName('References'))) {
    const propName = refsEl.getAttribute('property');
    const targetsAttr = refsEl.getAttribute('objects');
    if (!propName || !targetsAttr) continue;

    const wrappingType = nearestEnclosingObjectType(refsEl);
    if (!wrappingType) continue;
    const wrappingClass = bareClassName(wrappingType);
    if (!registry.isValidClass(wrappingClass)) continue;

    const expectedTarget = expectedTargetClass(registry, wrappingClass, propName);
    if (!expectedTarget) continue; // unknown property or non-class targetType

    // Multi-value: targets are space-separated #-prefixed ids.
    const targets = targetsAttr.split(/\s+/).filter(Boolean).map(stripHash);
    for (const targetId of targets) {
      const actualClass = idToClass.get(targetId);
      if (!actualClass) {
        // Dangling reference. The official XSD cannot catch this — the
        // `objects` attribute is typed nameOrIdReferences, a pattern-checked
        // xsd:string, not xs:IDREFS — so unresolved ids are this
        // dimension's job.
        failures.push({
          source,
          className: wrappingClass,
          propertyName: propName,
          expectedClass: expectedTarget,
          actualClass: '(unresolved id)',
          targetId,
          context: `<References property="${propName}" objects="#${targetId}"/> inside <Object type="${wrappingType}"> — ` +
            `target id "${targetId}" does not resolve to any Object in the document`,
        });
        continue;
      }
      if (!isClassOrSubclass(registry, actualClass, expectedTarget)) {
        failures.push({
          source,
          className: wrappingClass,
          propertyName: propName,
          expectedClass: expectedTarget,
          actualClass,
          targetId,
          context: `<References property="${propName}" objects="#${targetId}"/> inside <Object type="${wrappingType}"> — ` +
            `target id "${targetId}" resolves to class "${actualClass}", expected "${expectedTarget}" (or subclass)`,
        });
      }
    }
  }

  // ── Tier 4b: ObjectReference shells inside <Components> ──────────────
  for (const objRefEl of Array.from(doc.getElementsByTagName('ObjectReference'))) {
    const targetIdAttr = objRefEl.getAttribute('object');
    if (!targetIdAttr) continue;
    const targetId = stripHash(targetIdAttr);

    // The ObjectReference is inside a <Components property="X">.
    let parent: Element | null = objRefEl.parentElement;
    while (parent && parent.tagName !== 'Components') parent = parent.parentElement;
    if (!parent) continue;
    const propName = parent.getAttribute('property');
    if (!propName) continue;

    const wrappingType = nearestEnclosingObjectType(parent);
    if (!wrappingType) continue;
    const wrappingClass = bareClassName(wrappingType);
    if (!registry.isValidClass(wrappingClass)) continue;

    const expectedTarget = expectedTargetClass(registry, wrappingClass, propName);
    if (!expectedTarget) continue;

    const actualClass = idToClass.get(targetId);
    if (!actualClass) {
      failures.push({
        source,
        className: wrappingClass,
        propertyName: propName,
        expectedClass: expectedTarget,
        actualClass: '(unresolved id)',
        targetId,
        context: `<Components property="${propName}"><ObjectReference object="#${targetId}"/></Components> inside <Object type="${wrappingType}"> — ` +
          `target id "${targetId}" does not resolve to any Object in the document`,
      });
      continue;
    }
    if (!isClassOrSubclass(registry, actualClass, expectedTarget)) {
      failures.push({
        source,
        className: wrappingClass,
        propertyName: propName,
        expectedClass: expectedTarget,
        actualClass,
        targetId,
        context: `<Components property="${propName}"><ObjectReference object="#${targetId}"/></Components> inside <Object type="${wrappingType}"> — ` +
          `target id "${targetId}" resolves to class "${actualClass}", expected "${expectedTarget}" (or subclass)`,
      });
    }
  }

  return failures;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function bareClassName(typeRef: string): string {
  let s = typeRef;
  const lastSlash = s.lastIndexOf('/');
  if (lastSlash >= 0) s = s.slice(lastSlash + 1);
  const lastDot = s.lastIndexOf('.');
  if (lastDot >= 0) s = s.slice(lastDot + 1);
  return s;
}

function stripHash(s: string): string {
  return s.startsWith('#') ? s.slice(1) : s;
}

function nearestEnclosingObjectType(el: Element): string | null {
  let p: Element | null = el.parentElement;
  while (p && p.tagName !== 'Object') p = p.parentElement;
  return p?.getAttribute('type') ?? null;
}

/**
 * Look up the declared target class of a property on a wrapping class
 * (walking the supertype chain). Returns the bare class name or null
 * when the property's targetType isn't a class reference (Builtin, etc).
 */
function expectedTargetClass(
  registry: DexpiProcessClassRegistry,
  wrappingClass: string,
  propertyName: string,
): string | null {
  const props = registry.getProperties(wrappingClass);
  const prop = props.find(p => p.name === propertyName);
  if (!prop || !prop.targetType) return null;
  // Only reference + composition properties have class targets.
  if (prop.kind === 'data') return null;
  // Skip if the targetType is a Core/QualifiedValue or similar
  // generic-wrapper that carries diverse content — we don't want false
  // positives on legitimate composition slots whose contents are
  // verified by the property-name+kind validator instead.
  // Bare class name extraction from the typeRef handles common forms:
  //   '/Process.MaterialTemplate'  → 'MaterialTemplate'
  //   'Core/QualifiedValue'        → 'QualifiedValue'
  //   '/Process.Port'              → 'Port'
  return bareClassName(prop.targetType);
}

/**
 * Test whether `actualClass` IS-A `expectedClass` — either equal, or a
 * subclass via the registry's supertype chain.
 */
function isClassOrSubclass(
  registry: DexpiProcessClassRegistry,
  actualClass: string,
  expectedClass: string,
): boolean {
  if (actualClass === expectedClass) return true;
  // Use registry.hasAncestor if available; otherwise walk ourselves.
  if (typeof (registry as unknown as { hasAncestor?: (c: string, a: string) => boolean }).hasAncestor === 'function') {
    return registry.hasAncestor(actualClass, expectedClass);
  }
  // Defensive fallback (shouldn't be reached — registry exposes hasAncestor).
  return false;
}
