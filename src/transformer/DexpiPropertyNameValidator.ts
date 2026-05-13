/**
 * DexpiPropertyNameValidator
 *
 * Strict-mode metamodel-fidelity check that complements the XSD validator
 * (DexpiOutputValidator). The XSD treats every Data / Components /
 * References `property=` attribute as an opaque string and accepts canonical-
 * name violations like property="ListOfMaterialComponents" silently. This
 * module asserts that every property name actually exists on the wrapping
 * class as declared in Process.xml + Core.xml, with optional DEXPI Profile
 * extensions loaded into the same registry.
 *
 * The check has two paths, sharing the same registry:
 *   - validateEmittedDexpiXml(): walks DEXPI XML output, finding every
 *     <Data property="...">, <Components property="...">, <References
 *     property="..."> element and resolving the wrapping class via the
 *     nearest enclosing <Object type="...">.
 *   - validateBpmnExtensionElements(): walks <bpmn:extensionElements> rich
 *     DEXPI children. <dexpi:element dexpiType="X"> uses X as the wrapping
 *     class; bare-tag <Stream>, <MaterialTemplate>, <MaterialState>, ... use
 *     the tag itself; xsi:type subtype discriminator wins when present.
 *
 * Mode 1 (XSD-only, default) reflects DEXPI 2.0's permissive design: any
 * structurally valid output is exchangeable. Mode 2 (strict, opt-in) layers
 * this property-name check on top — useful for users wanting metamodel
 * fidelity, papers / reference implementations, or to drive the Phase 4
 * Profile-generation feature.
 */

import type { DexpiProcessClassRegistry, PropertyKind } from './DexpiProcessClassRegistry';
import type { ValidationResult } from './types';

export type { PropertyKind };

// ── Framework-attribute allowlist ──────────────────────────────────────────
//
// Attributes that ride on our dexpi: namespaced moddle elements but have no
// counterpart in Process.xml. These are out-of-band BPMN-side hints, not
// DEXPI properties; the validator must skip them rather than report them as
// unknown property names.
//
// Adding entries here is allowed only with an explicit per-entry justification.
// If a new candidate appears, surface it in the PR description for human
// review before extending this list.
//
// Justification per entry:
//   dexpiType     — Selects the wrapping class for <dexpi:element>; routed
//                   into the validator as the lookup key, not validated as a
//                   property of any class.
//   uid           — Stable XML id used to round-trip object identity through
//                   bpmn-js; not a DEXPI property.
//   id            — bpmn-js's own element-id attribute on <dexpi:port>, kept
//                   for moddle-side referential integrity.
//   anchorSide    — Pure layout hint (which BPMN edge the port docks against).
//   anchorOffset  — Pure layout hint (fractional position along that edge).
//   anchorX       — Pure layout hint (legacy absolute X anchor).
//   anchorY       — Pure layout hint (legacy absolute Y anchor).
export const FRAMEWORK_ATTRS = new Set<string>([
  'dexpiType',
  'uid',
  'id',
  'anchorSide',
  'anchorOffset',
  'anchorX',
  'anchorY',
]);

// QualifiedValue + AggregatedDataType inlining: when a CompositionProperty's
// target is Core/QualifiedValue, the runtime serialization may also inline
// children from the AggregatedDataType bound to QualifiedValue.Type
// (e.g. PhysicalQuantity contributes Value + Unit; PhysicalQuantityVector
// contributes Values + Unit). The registry parses ConcreteClass /
// AbstractClass only, so it doesn't surface these AggregatedDataType
// properties; we list them here so the validator accepts the canonical
// flattened form.
const QUALIFIED_VALUE_INLINED = new Set<string>(['Unit', 'Values']);

export interface PropertyFailure {
  /** Free-text label identifying the source XML (e.g. filename). */
  source: string;
  /** Wrapping class against which the property name was looked up. */
  className: string;
  /** Property name. */
  propertyName: string;
  /**
   * Property kind inferred from the carrier element ('Data' → 'data',
   * 'Components' → 'composition', 'References' → 'reference').
   */
  kind?: PropertyKind;
  /**
   * Set ONLY when the property name resolves on the wrapping class but the
   * carrier element disagrees with the declared kind (e.g. property is
   * declared as DataProperty but is being emitted under a `<References>`
   * carrier). When set, the failure represents a kind-mismatch — the
   * property is already declared in the active vocabulary, just with a
   * different kind, so it is NOT a candidate for an extension declaration
   * and the Profile generator skips it.
   */
  declaredKind?: PropertyKind;
  /** Short context string for diagnostic display. */
  context: string;
}


/**
 * Render a list of failures as a multi-line summary, grouping repeats so the
 * unique-violation count is visible. Suitable for both test assertion output
 * and CLI / UI surface.
 */
export function formatFailures(failures: PropertyFailure[]): string {
  if (failures.length === 0) return '';
  const grouped = new Map<string, PropertyFailure[]>();
  for (const f of failures) {
    const key = `${f.source} :: ${f.className}.${f.propertyName}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(f);
  }
  const lines: string[] = [
    `${failures.length} property-name fidelity violation(s) (${grouped.size} unique):`,
  ];
  for (const [key, items] of grouped) {
    lines.push(`  ✗ ${key}  (×${items.length})`);
    lines.push(`      e.g. ${items[0].context}`);
  }
  return lines.join('\n');
}

/**
 * Convert the raw failure list into the harness-wide ValidationResult shape
 * so callers can treat property-name fidelity uniformly with XSD validation.
 * Failures become entries in `errors`; the `mode` discriminator is
 * 'property-names' so consumers can tell the two validators apart.
 */
export function failuresToValidationResult(failures: PropertyFailure[]): ValidationResult {
  return {
    valid: failures.length === 0,
    errors: failures.map(f => `${f.className}.${f.propertyName}: ${f.context}`),
    warnings: [],
    mode: 'property-names' as ValidationResult['mode'],
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Infer property kind from a BPMN-extensionElements rich-DEXPI element.
 *
 * Rules (in priority order):
 *   - Element has `uidRef` attribute → reference (DEXPI's ReferenceProperty
 *     serializes as <X uidRef="..."/>).
 *   - Element has any child elements → composition (CompositionProperty
 *     serializes as a wrapping element with nested structure).
 *   - Otherwise (plain text / empty) → data.
 *
 * Used by the Profile generator to know which kind of declaration to emit
 * for BPMN-side gaps. Inference is heuristic but matches DEXPI 2.0's
 * canonical serialization conventions on every property kind seen in
 * Process.xml + Core.xml.
 */
function inferKindFromBpmnElement(el: Element): PropertyKind {
  if (el.hasAttribute('uidRef')) return 'reference';
  if (Array.from(el.children).length > 0) return 'composition';
  return 'data';
}

/** Bare class name extraction from a type-ref string. */
function bareClassName(typeRef: string): string {
  // Examples:
  //   'Core/EngineeringModel'              → 'EngineeringModel'
  //   'Core/QualifiedValue'                → 'QualifiedValue'
  //   'Process/ProcessModel'               → 'ProcessModel'
  //   'Process/Process.ReactingChemicals'  → 'ReactingChemicals'
  //   '/Process.MaterialState'             → 'MaterialState'
  //   '/ConceptualObject'                  → 'ConceptualObject'
  const stripped = typeRef.replace(/^\//, '');
  const last = stripped.split(/[./]/).pop() ?? '';
  return last;
}

/**
 * Pick the wrapping class for a rich DEXPI element. xsi:type wins when
 * present (DEXPI subtype discriminator); otherwise the element's tag name.
 * The xsi:type value is itself a bare class name in our schemas
 * (e.g. 'CustomMaterialComponent'), no further parsing needed.
 */
function resolveWrappingClass(el: Element): string {
  const xsiType =
    el.getAttribute('xsi:type') ??
    el.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type');
  if (xsiType) return xsiType;
  return el.localName;
}

// Lazily access DOMParser. In Node tests / CLI environments callers must set
// it on globalThis (jsdom). In browsers it's already available. We don't
// import jsdom here so the module stays browser-bundleable.
function getParser(): DOMParser {
  const Ctor = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  if (!Ctor) {
    throw new Error(
      'DexpiPropertyNameValidator: DOMParser is not available. ' +
      'In Node, install jsdom and assign globalThis.DOMParser = new JSDOM().window.DOMParser.'
    );
  }
  return new Ctor();
}

// ── Validator: DEXPI XML output side ──────────────────────────────────────

/**
 * Walk the emitted DEXPI XML. For every <Data>, <Components>, <References>
 * element with a `property=` attribute, find the nearest enclosing
 * <Object type="...">, extract the bare class name, and check that the
 * property name is declared on that class (via supertype walking).
 *
 * Classes not in the registry are skipped silently — caller may have loaded
 * an extension we don't have here, and treating that as an error would be
 * over-strict.
 */
export function validateEmittedDexpiXml(
  xml: string,
  source: string,
  registry: DexpiProcessClassRegistry,
): PropertyFailure[] {
  const doc = getParser().parseFromString(xml, 'text/xml');
  const failures: PropertyFailure[] = [];

  const carrierToKind: Record<string, PropertyKind> = {
    Data: 'data',
    Components: 'composition',
    References: 'reference',
  };
  const all = Array.from(doc.getElementsByTagName('*')) as Element[];
  for (const el of all) {
    const kind = carrierToKind[el.tagName];
    if (!kind) continue;
    const propName = el.getAttribute('property');
    if (!propName) continue;

    // Walk up to nearest <Object type="...">
    let p: Element | null = el.parentElement;
    while (p && p.tagName !== 'Object') p = p.parentElement;
    if (!p) continue;
    const typeAttr = p.getAttribute('type');
    if (!typeAttr) continue;
    const className = bareClassName(typeAttr);

    if (!registry.isValidClass(className)) {
      // Wrapping class not in loaded registry — skip without flagging.
      // (Could be an unknown extension class; not this validator's scope.)
      continue;
    }

    const declared = new Map<string, PropertyKind>();
    for (const p of registry.getProperties(className)) declared.set(p.name, p.kind);
    // QualifiedValue accepts inlined AggregatedDataType properties too —
    // these are always carried as data (the value's String/Number content),
    // so flag them as 'data' for the kind check.
    if (className === 'QualifiedValue') {
      for (const inlined of QUALIFIED_VALUE_INLINED) declared.set(inlined, 'data');
    }
    const declaredKind = declared.get(propName);
    if (declaredKind === undefined) {
      // Property not declared on the class chain at all — name fidelity gap.
      failures.push({
        source,
        className,
        propertyName: propName,
        kind,
        context: `<${el.tagName} property="${propName}"/> inside <Object type="${typeAttr}">`,
      });
    } else if (declaredKind !== kind) {
      // Property IS declared, but on a different carrier kind — authoring bug,
      // not an extension candidate.
      failures.push({
        source,
        className,
        propertyName: propName,
        kind,
        declaredKind,
        context:
          `<${el.tagName} property="${propName}"/> inside <Object type="${typeAttr}"> ` +
          `— declared as ${declaredKind} on ${className}, emitted as ${kind}`,
      });
    }
  }
  return failures;
}

// ── Validator: BPMN extensionElements side ────────────────────────────────

/**
 * Walk a BPMN file's <bpmn:extensionElements> blocks. For each child:
 *   - <dexpi:element dexpiType="X">  → wrapping class is X. Validate
 *                                       non-framework, non-dexpi-namespaced
 *                                       descendants against X's properties.
 *   - <Stream>, <MaterialTemplate>, etc. (bare-name)  → tag IS the class
 *                                       (or xsi:type discriminator wins).
 *
 * Descent: when we see a property element <Y> on a wrapping class X, we look
 * up X's "Y" property and use its targetType (resolved to a bare class name
 * via the registry) as the new wrapping class for <Y>'s own children. If
 * targetType is QualifiedValue, descent uses the QualifiedValue allowlist
 * augmented with QUALIFIED_VALUE_INLINED.
 */
export function validateBpmnExtensionElements(
  bpmnXml: string,
  source: string,
  registry: DexpiProcessClassRegistry,
): PropertyFailure[] {
  const doc = getParser().parseFromString(bpmnXml, 'text/xml');
  const failures: PropertyFailure[] = [];

  // Find every extensionElements element regardless of how the namespace is
  // declared (tagName might be 'bpmn:extensionElements' or with a different
  // prefix). localName comparison covers all cases.
  const all = Array.from(doc.getElementsByTagName('*')) as Element[];
  const extElems = all.filter(e => e.localName === 'extensionElements');

  for (const ext of extElems) {
    for (const child of Array.from(ext.children) as Element[]) {
      const ns = child.namespaceURI;
      const inDexpiNs = ns?.includes('dexpi.org') ?? false;

      if (inDexpiNs) {
        // <dexpi:element dexpiType="X"> hosts a DEXPI class lookup via
        // the dexpiType attribute (this is our flat-shape ProcessStep
        // marker, not a class instance directly).
        if (child.localName === 'element') {
          const dexpiType = child.getAttribute('dexpiType');
          if (dexpiType && registry.isValidClass(dexpiType)) {
            walkRichElement(child, dexpiType, source, registry, failures);
          }
          continue;
        }
        // Class-named dexpi-prefixed wrappers: <dexpi:MaterialState>,
        // <dexpi:MaterialTemplate>, <dexpi:MaterialComponent>,
        // <dexpi:MaterialStateType>, <dexpi:Composition>, <dexpi:Stream>,
        // ... — when the localName matches a registered class, walk it as
        // a class instance. xsi:type wins for subclass discriminators
        // (e.g. CustomMaterialComponent on MaterialComponent).
        const wrappedClass = resolveWrappingClass(child);
        if (registry.isValidClass(wrappedClass)) {
          walkRichElement(child, wrappedClass, source, registry, failures);
          continue;
        }
        // Other dexpi: framework markers (<dexpi:port>, <dexpi:stream>
        // binding-only with no class semantics) — skip.
        continue;
      }

      // Bare-name (unprefixed) class-instance wrapper — kept as a
      // legacy fallback for fixtures saved before the dexpi: prefix
      // migration. Tag IS the class — unless an xsi:type attribute
      // selects a more specific subclass.
      const className = resolveWrappingClass(child);
      if (!registry.isValidClass(className)) {
        failures.push({
          source,
          className: '(unknown)',
          propertyName: className,
          context: `top-level <${className}> in <bpmn:extensionElements> — not a DEXPI class`,
        });
        continue;
      }
      walkRichElement(child, className, source, registry, failures);
    }
  }
  return failures;
}

/**
 * Recursively walk a rich DEXPI element. The first call is on the wrapper
 * itself (e.g. <Stream>). For each child element, validate that its tag
 * name is a property of `wrappingClass`, then descend using the property's
 * targetType as the new wrapping class.
 */
function walkRichElement(
  el: Element,
  wrappingClass: string,
  source: string,
  registry: DexpiProcessClassRegistry,
  failures: PropertyFailure[],
): void {
  const props = registry.getProperties(wrappingClass);
  const propByName = new Map(props.map(p => [p.name, p]));
  const validNames = new Set(propByName.keys());
  const declaredKindByName = new Map<string, PropertyKind>();
  for (const p of props) declaredKindByName.set(p.name, p.kind);
  // Special-case QualifiedValue inlining (PhysicalQuantity Value/Unit, etc.)
  // Inlined names are always carried as 'data' (string content of the
  // QualifiedValue's Value/Unit child).
  if (wrappingClass === 'QualifiedValue') {
    for (const inlined of QUALIFIED_VALUE_INLINED) {
      validNames.add(inlined);
      declaredKindByName.set(inlined, 'data');
    }
  }

  for (const child of Array.from(el.children) as Element[]) {
    const inDexpiNs = child.namespaceURI?.includes('dexpi.org') ?? false;
    const ll = (child.localName || '').toLowerCase();

    // ── Carrier-wrapped form (preferred — kind explicit) ────────────────
    // Carriers must be in the dexpi: namespace per BPMN 2.0's `xsd:any
    // namespace="##other"` rule (strict reading); we recognize them by
    // localName regardless of which prefix the document declares.
    if (inDexpiNs && (ll === 'data' || ll === 'references' || ll === 'components')) {
      const propName = child.getAttribute('property') || '';
      if (!propName) continue;
      const kind: PropertyKind =
        ll === 'data' ? 'data' :
        ll === 'references' ? 'reference' :
        'composition';

      if (FRAMEWORK_ATTRS.has(propName)) continue;

      const declaredKind = declaredKindByName.get(propName);
      if (declaredKind === undefined) {
        failures.push({
          source,
          className: wrappingClass,
          propertyName: propName,
          kind,
          context: `<${child.localName} property="${propName}"/> inside <${wrappingClass}>`,
        });
        continue;
      }
      if (declaredKind !== kind) {
        failures.push({
          source,
          className: wrappingClass,
          propertyName: propName,
          kind,
          declaredKind,
          context:
            `<${child.localName} property="${propName}"/> inside <${wrappingClass}> ` +
            `— declared as ${declaredKind} on ${wrappingClass}, used as ${kind}`,
        });
        // Don't `continue` here; fall through to descend into the (mis-kinded)
        // composition child, so deeper authoring bugs still surface. The
        // mismatched-kind failure is recorded once at this level.
      }

      // For Components carriers, descend into the inner <dexpi:object>
      // using its type attribute (e.g. "Core/QualifiedValue") as the new
      // wrapping class. The `property` field's targetType from the
      // registry is a sanity-check fallback when the inner Object lacks
      // an explicit type attr.
      if (kind === 'composition') {
        const inner = Array.from(child.children).find((o: Element) =>
          (o.localName || '').toLowerCase() === 'object'
        );
        if (inner) {
          const typeAttr = inner.getAttribute('type');
          let nextWrap: string | undefined;
          if (typeAttr) {
            const t = bareClassName(typeAttr);
            if (registry.isValidClass(t)) nextWrap = t;
          }
          if (!nextWrap) {
            const prop = propByName.get(propName);
            if (prop?.targetType) {
              const t = bareClassName(prop.targetType);
              if (registry.isValidClass(t)) nextWrap = t;
            }
          }
          if (nextWrap) walkRichElement(inner, nextWrap, source, registry, failures);
        }
      }
      // Data and References carriers don't have child elements to descend
      // into; their content is the body text or the uidRef attribute.
      continue;
    }

    // ── <dexpi:port> ─────────────────────────────────────────────────────
    // Ports carry their own DEXPI attributes since the port-attribute
    // editor PR (#38) — `<dexpi:data property="X">v</dexpi:data>` and
    // `<dexpi:components property="X">…</dexpi:components>` children of
    // the `<dexpi:port>` element. Validate them under the port's portType
    // (MaterialPort, ThermalEnergyPort, …) so port-attribute property
    // names get the same strict-mode coverage ProcessStep + Stream
    // attributes do. The registry walks supertypes through Port →
    // Core/ConceptualObject so PersistentIdentifiers / Identifier /
    // Label resolve naturally.
    //
    // Missing-portType handling: the rest of the codebase (UI addPort,
    // legacy migration, transformer port reader) already defaults to
    // 'MaterialPort' when portType is absent (see
    // BpmnToDexpiTransformer.ts:1662 + DexpiPropertiesPanel.ts:863). We
    // align with that convention here — default to MaterialPort, run
    // property-name validation against it, AND emit a structural
    // PropertyFailure noting the default was applied so the user sees
    // it in strict-mode warnings. Surfacing the warning rather than
    // skipping (or hard-failing) matches DEXPI 2.0's permissive
    // philosophy: still produce output, just inform the author.
    if (inDexpiNs && ll === 'port') {
      const portType = child.getAttribute('portType');
      const portIdLabel = child.getAttribute('portId') || child.getAttribute('id') || child.getAttribute('name') || '(unnamed)';
      const effectivePortType = portType && registry.isValidClass(portType)
        ? portType
        : 'MaterialPort';
      if (!portType) {
        // Structural warning — emitted as a PropertyFailure so it
        // surfaces in the same strict-mode failures list. Distinguished
        // by the "(missing portType)" propertyName + an explanatory
        // context. The walker still runs against the MaterialPort
        // default below, so any property-name typos on this port are
        // caught against MaterialPort rather than going unvalidated.
        failures.push({
          source,
          className: 'Port',
          propertyName: '(missing portType)',
          context: `<dexpi:port portId="${portIdLabel}"> is missing portType — defaulting to MaterialPort for property-name validation. Set portType explicitly to remove this warning.`,
        });
      } else if (!registry.isValidClass(portType)) {
        // portType is present but the value isn't a registered class.
        // Distinct warning so the user sees the typo'd discriminator
        // separately from the missing-discriminator case.
        failures.push({
          source,
          className: 'Port',
          propertyName: '(unknown portType)',
          context: `<dexpi:port portId="${portIdLabel}" portType="${portType}"> — portType "${portType}" is not a registered class; defaulting to MaterialPort for property-name validation.`,
        });
      }
      walkRichElement(child, effectivePortType, source, registry, failures);
      continue;
    }

    // ── Other dexpi: namespaced framework markers — skip. ───────────────
    // <dexpi:object> only appears inside <dexpi:components> (handled above),
    // so a stray <dexpi:object> as a direct child is skipped here.
    if (inDexpiNs) continue;

    // ── Legacy bare-name fallback (defensive — for hand-authored content
    // saved before the carrier migration). Kind is inferred from element
    // shape rather than recorded explicitly. NOT exercised by the UI write
    // paths, the canonical TEP fixture, or any production write path; kept
    // so older BPMN files round-trip during the migration window.
    const propName = child.localName;
    if (FRAMEWORK_ATTRS.has(propName)) continue;

    if (!validNames.has(propName)) {
      failures.push({
        source,
        className: wrappingClass,
        propertyName: propName,
        kind: inferKindFromBpmnElement(child),
        context: `<${propName}> inside <${wrappingClass}>`,
      });
      continue;
    }

    const prop = propByName.get(propName);
    let nextWrap: string | undefined;
    if (prop?.targetType) {
      const t = bareClassName(prop.targetType);
      if (registry.isValidClass(t)) nextWrap = t;
    }
    if (nextWrap) {
      walkRichElement(child, nextWrap, source, registry, failures);
    }
  }
}
