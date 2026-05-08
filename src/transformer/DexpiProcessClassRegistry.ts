/**
 * DexpiProcessClassRegistry
 *
 * Parses DEXPI 2.0 metamodel files (Process.xml, Core.xml, and any number
 * of project-specific extension/profile files) into a single merged registry
 * of classes and their properties.
 *
 * Class names are stored bare (e.g. 'Stream', 'ConceptualObject', 'MassFlow').
 * DEXPI 2.0 keeps class names globally unique across Process + Core, and we
 * fail loudly if a loaded extension introduces a duplicate. Cross-namespace
 * supertype refs (e.g. Stream → ProcessConnection → ConceptualObject in Core)
 * are resolved at load time so getProperties() can walk the entire chain.
 *
 * Usage:
 *   // Default: Process.xml + Core.xml from the bundled schema folder
 *   const registry = await DexpiProcessClassRegistry.loadDefault();
 *
 *   // With user-supplied DEXPI Profile extensions
 *   const registry = await DexpiProcessClassRegistry.loadDefault({
 *     extensions: [{ name: 'BiologicalReactor', xml: profileXml }]
 *   });
 *
 *   registry.isValidClass('Pumping');             // true
 *   registry.isValidClass('BiologicalReactor');   // true if profile loaded
 *   registry.getProperties('Stream');             // includes inherited
 *                                                 //   Identifier/Label/Source/Target
 *                                                 //   from ProcessConnection
 *                                                 // plus own MassFlow/Pressure/...
 *
 * To update the class list when DEXPI releases a new version, replace
 * dexpi-schema-files/Process.xml (and Core.xml if changed) — no code changes.
 */

export type ClassKind = 'concrete' | 'abstract';
export type PropertyKind = 'data' | 'reference' | 'composition';

export interface DexpiProperty {
  /** Property name as declared in the schema (e.g. 'Identifier', 'MassFlow'). */
  name: string;
  kind: PropertyKind;
  /** Cardinality lower bound. 0 = optional, 1+ = required. */
  lower: number;
  /** Cardinality upper bound. null = unbounded. */
  upper: number | null;
  /**
   * Target type indicator.
   *  - DataProperty:        the primitive type ref, e.g. 'Builtin/String'.
   *  - ReferenceProperty:   the target class type ref, e.g. '/Process.MaterialState'.
   *  - CompositionProperty: the wrapper class type ref, typically
   *                         'Core/QualifiedValue' (whose own DataProperties
   *                         carry Value/Unit/Provenance/Range/Scope/...).
   */
  targetType?: string;
  /** Class that declared this property (for diagnostics / supertype walking). */
  declaredOn: string;
}

export interface DexpiClassInfo {
  /** Bare class name, unique across all loaded sources. */
  name: string;
  kind: ClassKind;
  /** Resolved supertype names (bare). Cross-namespace refs are resolved here. */
  superTypes: string[];
  description: string;
  /** Properties declared directly on this class (not inherited). */
  properties: DexpiProperty[];
  /** Source file label that contributed this class (for conflict diagnostics). */
  sourceFile: string;
}

interface SchemaSource {
  /**
   * Stable label for the schema source — used in error messages and as the
   * sourceFile field on every class loaded from this XML. Convention:
   *   'Process.xml', 'Core.xml', and for user profiles the file basename.
   */
  name: string;
  xml: string;
}

const PROCESS_SCHEMA_FILENAME = 'Process.xml';
const CORE_SCHEMA_FILENAME = 'Core.xml';

export class DexpiProcessClassRegistry {
  private readonly classes: Map<string, DexpiClassInfo>;
  /**
   * Enumeration registry: name → ordered list of literal names. Populated
   * from `<Enumeration>` declarations across all loaded sources. Consumed
   * by the data-type validator to verify enum-typed Data values are one
   * of the declared literals.
   */
  private readonly enumerations: Map<string, string[]>;

  private constructor(
    classes: Map<string, DexpiClassInfo>,
    enumerations: Map<string, string[]> = new Map(),
  ) {
    this.classes = classes;
    this.enumerations = enumerations;
  }

  // ── Factories ─────────────────────────────────────────────────────────────

  /** Empty registry — size === 0, all lookups return undefined/false. */
  static empty(): DexpiProcessClassRegistry {
    return new DexpiProcessClassRegistry(new Map());
  }

  /**
   * Permissive single-source loader (back-compat).
   *
   * Treats `xml` as a standalone schema; missing supertypes are kept as raw
   * names without raising. Useful for tests and for environments that have
   * pre-fetched a single XML string. For production loads use loadDefault().
   */
  static fromXml(xml: string): DexpiProcessClassRegistry {
    return DexpiProcessClassRegistry.fromXmlSources(
      [{ name: 'inline', xml }],
      { strictSupertypes: false }
    );
  }

  /**
   * Strict multi-source loader.
   *
   * Parses every source, then validates:
   *   - No two sources may declare the same class name (conflict → throw).
   *   - Every supertype reference must resolve to a class declared in some
   *     source (missing → throw), unless the target lies in an unimported
   *     namespace (e.g. 'MetaData/...') which is treated as out-of-scope and
   *     dropped from the resolved supertype list.
   *
   * The strict check is what extension/profile loading needs: a profile that
   * extends a Process class can only be merged when Process.xml is also
   * provided in the same load.
   */
  static fromXmlSources(
    sources: SchemaSource[],
    options: { strictSupertypes?: boolean } = {}
  ): DexpiProcessClassRegistry {
    const strict = options.strictSupertypes ?? true;
    const classes = new Map<string, DexpiClassInfo>();
    const enumerations = new Map<string, string[]>();
    const conflicts: string[] = [];

    for (const source of sources) {
      const { classes: parsed, enumerations: parsedEnums, mode } = parseSchemaXml(source);
      // Merge enumerations: later sources override earlier ones for the
      // same name. The TEP fixture currently has no enum collisions across
      // Process+Core; if a Profile redefines an enum, the Profile's
      // literals win.
      for (const [enumName, literals] of parsedEnums) {
        enumerations.set(enumName, literals);
      }
      for (const cls of parsed) {
        // Bare-name dedup assumes class names are globally unique across all
        // loaded DEXPI sources. This holds for DEXPI 2.0 — Process.xml + Core.xml
        // do not collide on any concrete or abstract class name. If a future
        // DEXPI release introduces a package that reuses a name (e.g. a second
        // 'Stream' under a different package), this dedup would surface it as
        // a conflict and the registry would need to switch to package-qualified
        // identity ('Process.Stream' vs 'Other.Stream') here and in callers.
        const existing = classes.get(cls.name);
        if (existing) {
          // Profile-level mode="extend" semantics: when the *source*
          // declares this Profile as an extension Profile, the registry
          // merges new property declarations into the existing class
          // (typically a Process.xml or Core.xml class) rather than
          // rejecting the conflict. Existing kind, supertypes, description,
          // sourceFile are preserved; only properties not already declared
          // by name are appended. Hand-authored Profiles without the
          // mode marker keep the default reject-on-conflict behavior.
          //
          // The marker is bpmn2dexpi-specific until DEXPI publishes a
          // standard Profile-extension idiom; on migration this branch
          // would route through whatever the standard names instead.
          if (mode === 'extend') {
            const existingPropNames = new Set(existing.properties.map(p => p.name));
            for (const np of cls.properties) {
              if (!existingPropNames.has(np.name)) {
                existing.properties.push(np);
              }
            }
            continue;
          }
          conflicts.push(
            `Class "${cls.name}" declared in both "${existing.sourceFile}" and "${cls.sourceFile}"`
          );
          continue;
        }
        classes.set(cls.name, cls);
      }
    }

    if (conflicts.length > 0) {
      throw new Error(
        `DEXPI schema merge conflict — duplicate class names:\n  ${conflicts.join('\n  ')}`
      );
    }

    if (strict) {
      const missing: string[] = [];
      for (const cls of classes.values()) {
        for (const st of cls.superTypes) {
          if (!classes.has(st)) {
            missing.push(`"${cls.name}" (in ${cls.sourceFile}) extends unknown supertype "${st}"`);
          }
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `DEXPI schema unresolved supertypes:\n  ${missing.join('\n  ')}`
        );
      }
    }

    return new DexpiProcessClassRegistry(classes, enumerations);
  }

  /**
   * Async loader.
   *
   * With no override: reads Process.xml + Core.xml from the bundled
   * dexpi-schema-files/ folder (Node only) and merges them strictly.
   *
   * With an override string: behaves like fromXml(override) for back-compat
   * with code that wants to inject a pre-fetched single schema (used e.g. by
   * tests that supply a synthetic Process.xml).
   */
  static async load(processXmlOverride?: string): Promise<DexpiProcessClassRegistry> {
    if (processXmlOverride) {
      return DexpiProcessClassRegistry.fromXml(processXmlOverride);
    }
    return DexpiProcessClassRegistry.loadDefault();
  }

  /**
   * Load Process.xml + Core.xml from disk (Node) and merge with optional
   * user-supplied DEXPI Profile extensions. Strict supertype resolution.
   */
  static async loadDefault(
    options: { extensions?: SchemaSource[] } = {}
  ): Promise<DexpiProcessClassRegistry> {
    const sources: SchemaSource[] = [];
    try {
      const { readFileSync } = await import('fs');
      const { join, dirname } = await import('path');
      const { fileURLToPath } = await import('url');

      let base: string;
      try {
        // ESM
        const __filename = fileURLToPath(import.meta.url);
        base = dirname(__filename);
      } catch {
        base = __dirname;
      }
      const schemaDir = join(base, '..', '..', 'dexpi-schema-files');
      sources.push({
        name: PROCESS_SCHEMA_FILENAME,
        xml: readFileSync(join(schemaDir, PROCESS_SCHEMA_FILENAME), 'utf-8'),
      });
      sources.push({
        name: CORE_SCHEMA_FILENAME,
        xml: readFileSync(join(schemaDir, CORE_SCHEMA_FILENAME), 'utf-8'),
      });
    } catch {
      console.warn('[bpmn2dexpi] Could not load Process.xml/Core.xml from disk — using empty registry.');
      return DexpiProcessClassRegistry.empty();
    }

    if (options.extensions) sources.push(...options.extensions);
    return DexpiProcessClassRegistry.fromXmlSources(sources, { strictSupertypes: true });
  }

  // ── Query API ─────────────────────────────────────────────────────────────

  /** Returns true if name is any class (concrete or abstract) in the registry. */
  isValidClass(name: string): boolean {
    return this.classes.has(name);
  }

  /** Returns true if name is a concrete (instantiable) class. */
  isConcreteClass(name: string): boolean {
    return this.classes.get(name)?.kind === 'concrete';
  }

  /**
   * All concrete class names from Process.xml + any user-loaded extensions —
   * suitable for a UI dropdown of pickable process step types. Core.xml is
   * excluded because its concrete classes are primitives (QualifiedValue,
   * unit types, ...) that aren't user-pickable as ProcessSteps. Inline
   * single-source loads (back-compat path) include their concrete classes
   * since the caller has no other channel to scope.
   */
  concreteClasses(): string[] {
    return Array.from(this.classes.values())
      .filter(c => c.kind === 'concrete' && c.sourceFile !== CORE_SCHEMA_FILENAME)
      .map(c => c.name)
      .sort();
  }

  /** All concrete class names from a specific source file. */
  concreteClassesFrom(sourceFile: string): string[] {
    return Array.from(this.classes.values())
      .filter(c => c.kind === 'concrete' && c.sourceFile === sourceFile)
      .map(c => c.name)
      .sort();
  }

  /** All class names (concrete + abstract). */
  allClasses(): string[] {
    return Array.from(this.classes.keys()).sort();
  }

  /** Returns class metadata or undefined if not found. */
  getClass(name: string): DexpiClassInfo | undefined {
    return this.classes.get(name);
  }

  /**
   * Returns all properties on `className`, including inherited ones from
   * the entire supertype chain (Process → Core). Closer subclasses override
   * supertypes when the same property name is declared on both — first
   * occurrence wins, walking from the class itself up.
   */
  getProperties(className: string): DexpiProperty[] {
    const seen = new Set<string>();
    const out: DexpiProperty[] = [];
    const walked = new Set<string>();
    const walk = (name: string) => {
      if (walked.has(name)) return;
      walked.add(name);
      const info = this.classes.get(name);
      if (!info) return;
      for (const p of info.properties) {
        if (seen.has(p.name)) continue;
        seen.add(p.name);
        out.push(p);
      }
      for (const st of info.superTypes) walk(st);
    };
    walk(className);
    return out;
  }

  /**
   * Returns true if className has ancestor somewhere in its supertype chain.
   * Walks superTypes recursively, including across namespaces (Process→Core).
   */
  hasAncestor(className: string, ancestor: string): boolean {
    if (className === ancestor) return true;
    const seen = new Set<string>();
    const walk = (name: string): boolean => {
      if (seen.has(name)) return false;
      seen.add(name);
      const info = this.classes.get(name);
      if (!info) return false;
      for (const st of info.superTypes) {
        if (st === ancestor) return true;
        if (walk(st)) return true;
      }
      return false;
    };
    return walk(className);
  }

  /** Number of classes loaded. 0 means all schemas failed to load. */
  get size(): number {
    return this.classes.size;
  }

  /**
   * Return a NEW registry containing the current classes plus the merge
   * of an additional schema XML. Used by the Profile generator to build
   * intermediate registries during iterative generation without retaining
   * the original schema sources. Honors the same Profile mode="extend"
   * semantics as fromXmlSources(): without the marker, conflicts throw;
   * with it, properties are merged into existing classes.
   *
   * The current registry is left untouched.
   */
  cloneAndMergeXml(name: string, xml: string): DexpiProcessClassRegistry {
    // Deep-clone the classes map so the returned registry is independent.
    const cloned = new Map<string, DexpiClassInfo>();
    for (const [k, v] of this.classes) {
      cloned.set(k, { ...v, properties: [...v.properties], superTypes: [...v.superTypes] });
    }
    const { classes: parsed, enumerations: parsedEnums, mode } = parseSchemaXml({ name, xml });
    // Clone enums + merge new ones (later wins for same name).
    const clonedEnums = new Map<string, string[]>();
    for (const [k, v] of this.enumerations) clonedEnums.set(k, [...v]);
    for (const [k, v] of parsedEnums) clonedEnums.set(k, v);
    const conflicts: string[] = [];
    for (const cls of parsed) {
      const existing = cloned.get(cls.name);
      if (existing) {
        if (mode === 'extend') {
          const existingPropNames = new Set(existing.properties.map(p => p.name));
          for (const np of cls.properties) {
            if (!existingPropNames.has(np.name)) existing.properties.push(np);
          }
          continue;
        }
        conflicts.push(
          `Class "${cls.name}" declared in both "${existing.sourceFile}" and "${cls.sourceFile}"`
        );
        continue;
      }
      cloned.set(cls.name, cls);
    }
    if (conflicts.length > 0) {
      throw new Error(
        `DEXPI schema merge conflict — duplicate class names:\n  ${conflicts.join('\n  ')}`
      );
    }
    return new DexpiProcessClassRegistry(cloned, clonedEnums);
  }

  /**
   * Return the declared literal names for a given enumeration, or undefined
   * if no such enumeration is registered. Lookups are by bare name (e.g.
   * 'QuantityProvenance', 'PortDirection') — strip the namespace prefix
   * (e.g. '/Enumerations.QuantityProvenance' → 'QuantityProvenance') before
   * calling.
   */
  getEnumerationLiterals(enumName: string): string[] | undefined {
    const literals = this.enumerations.get(enumName);
    return literals ? [...literals] : undefined;
  }

  /** Number of distinct enumerations registered. */
  get enumerationCount(): number {
    return this.enumerations.size;
  }

  /**
   * Resolve the enumeration literals for a specific property on a class,
   * walking the supertype chain. Returns null when the class is unknown,
   * the property is not declared on the class (or its supertypes), or its
   * target type is not an Enumeration. Used by the properties-panel
   * attribute editor to render the value field as a dropdown of literals
   * + a Custom escape hatch when the schema/Profile defines an enum type.
   */
  getEnumLiteralsForProperty(className: string, propName: string): string[] | null {
    if (!this.classes.has(className)) return null;
    const prop = this.getProperties(className).find(p => p.name === propName);
    if (!prop || !prop.targetType) return null;
    const enumName = parseTypeRef(prop.targetType);
    if (!enumName) return null;
    const literals = this.enumerations.get(enumName);
    return literals ? [...literals] : null;
  }
}

// ── Schema-XML parsing internals ──────────────────────────────────────────

/**
 * Profile-level merge mode read from the root element's `mode` attribute.
 * Recognized values:
 *   'extend' — Profile extends existing classes; conflicts merge instead
 *              of rejecting (per Step 9 design: <Profile mode="extend">).
 *   undefined — default reject-on-conflict semantics.
 *
 * Marker is bpmn2dexpi-specific. When DEXPI publishes a standard Profile-
 * extension idiom, the parser will route through that signal instead and
 * this attribute can be deprecated.
 */
type SchemaMode = 'extend' | undefined;

interface ParsedSchema {
  classes: DexpiClassInfo[];
  /** Map of enumeration name → literal names (in declaration order). */
  enumerations: Map<string, string[]>;
  /** Root-level merge directive — see SchemaMode. */
  mode: SchemaMode;
}

/**
 * Parse one schema XML string. Returns the list of classes declared in this
 * file, with supertypes resolved to bare names (cross-namespace refs like
 * 'Core/ConceptualObject' → 'ConceptualObject'; '/Process.X' → 'X'). Refs
 * into non-imported namespaces (currently 'MetaData/...') are dropped.
 *
 * Also reads the root element's `mode` attribute (works for both `<Model>`
 * and `<Profile>` roots) so the caller can switch between merge and
 * reject conflict semantics per Profile.
 */
function parseSchemaXml(source: SchemaSource): ParsedSchema {
  const parser = new DOMParser();
  const doc = parser.parseFromString(source.xml, 'text/xml');
  const out: DexpiClassInfo[] = [];

  const root = doc.documentElement;
  const rawMode = root?.getAttribute('mode');
  const mode: SchemaMode = rawMode === 'extend' ? 'extend' : undefined;

  const extract = (tagName: string, kind: ClassKind) => {
    const elements = Array.from(doc.querySelectorAll(tagName));
    elements.forEach(el => {
      const name = el.getAttribute('name');
      if (!name) return;

      const superTypes = parseSuperTypes(el.getAttribute('superTypes'));
      const description = el
        .querySelector('Data[property="MetaData/description"] > String')
        ?.textContent?.trim() ?? '';
      const properties = parseDirectProperties(el, name);

      out.push({ name, kind, superTypes, description, properties, sourceFile: source.name });
    });
  };

  extract('ConcreteClass', 'concrete');
  extract('AbstractClass', 'abstract');

  // Parse <Enumeration name="X"><EnumerationLiteral name="..."/></Enumeration>.
  // Used by the data-type validator to verify enum-typed Data values are one
  // of the declared literals (e.g. Provenance ∈ {Calculated, Estimated, ...}).
  const enumerations = new Map<string, string[]>();
  for (const el of Array.from(doc.querySelectorAll('Enumeration'))) {
    const name = el.getAttribute('name');
    if (!name) continue;
    const literals: string[] = [];
    for (const lit of Array.from(el.querySelectorAll(':scope > EnumerationLiteral'))) {
      const litName = lit.getAttribute('name');
      if (litName) literals.push(litName);
    }
    enumerations.set(name, literals);
  }

  return { classes: out, enumerations, mode };
}

/**
 * superTypes attribute is a whitespace-separated list of name references.
 * Forms we care about:
 *   '/Process.Foo'         → bare 'Foo' (absolute path within current model)
 *   '/Foo'                 → bare 'Foo' (absolute, unwrapped — Core convention)
 *   'Core/Foo'             → bare 'Foo' (cross-namespace via import prefix)
 *   'Core/Package.Foo'     → bare 'Foo' (cross-namespace into a Core package)
 *   'MetaData/...'         → dropped (out-of-scope namespace for this registry)
 */
function parseSuperTypes(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map(parseTypeRef)
    .filter((s): s is string => s !== null);
}

/**
 * Strip a name reference down to its bare class name, returning null when
 * the reference targets an out-of-scope namespace we don't load.
 */
function parseTypeRef(ref: string): string | null {
  // Drop refs into namespaces we don't load (only MetaData currently).
  if (ref.startsWith('MetaData/') || ref.startsWith('/MetaData.')) return null;

  // 'Core/ConceptualObject', 'Core/Package.Foo' → take after last '.' or '/'
  // '/Process.Foo' → 'Foo'
  // '/Foo' → 'Foo'
  const stripped = ref.replace(/^\//, '');     // remove leading absolute slash
  const last = stripped.split(/[./]/).pop();   // last segment after . or /
  return last && last.length > 0 ? last : null;
}

/**
 * Parse DataProperty / ReferenceProperty / CompositionProperty children
 * declared directly on this class element (not inherited).
 *
 * Limit search to immediate children (not descendants) — properties belong
 * to the enclosing class, not to nested helper classes. We use childNodes
 * iteration rather than querySelectorAll, which would descend into nested
 * BoundClass entries.
 */
function parseDirectProperties(classEl: Element, declaredOn: string): DexpiProperty[] {
  const out: DexpiProperty[] = [];
  const children = Array.from(classEl.childNodes);
  for (const node of children) {
    if (node.nodeType !== 1) continue; // ELEMENT_NODE
    const el = node as Element;
    let kind: PropertyKind | null = null;
    if (el.tagName === 'DataProperty') kind = 'data';
    else if (el.tagName === 'ReferenceProperty') kind = 'reference';
    else if (el.tagName === 'CompositionProperty') kind = 'composition';
    if (!kind) continue;

    const name = el.getAttribute('name');
    if (!name) continue;

    out.push({
      name,
      kind,
      lower: parseInt(el.getAttribute('lower') ?? '0', 10) || 0,
      upper: parseUpper(el.getAttribute('upper')),
      targetType: parsePropertyTargetType(el, kind),
      declaredOn,
    });
  }
  return out;
}

function parseUpper(raw: string | null): number | null {
  if (raw === null || raw === '' || raw === '*' || raw === 'unbounded') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Best-effort target-type extraction:
 *   DataProperty       → first <DataTypeReference type="..."/>
 *   ReferenceProperty  → first <ClassReference type="..."/>
 *   CompositionProperty → either direct <ClassReference> or wrapped in <BoundClass>
 *
 * Returns the raw type string from the schema; consumers can normalize via
 * parseTypeRef() if they want a bare class name.
 */
function parsePropertyTargetType(el: Element, kind: PropertyKind): string | undefined {
  if (kind === 'data') {
    const dtr = el.querySelector('DataTypeReference');
    return dtr?.getAttribute('type') ?? undefined;
  }
  if (kind === 'reference') {
    const cr = el.querySelector('ClassReference');
    return cr?.getAttribute('type') ?? undefined;
  }
  // composition: BoundClass > ClassReference, or direct ClassReference
  const bound = el.querySelector('BoundClass > ClassReference');
  if (bound) return bound.getAttribute('type') ?? undefined;
  const direct = el.querySelector(':scope > ClassReference');
  return direct?.getAttribute('type') ?? undefined;
}
