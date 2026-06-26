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
  /**
   * For CompositionProperty slots bound to Core/QualifiedValue whose
   * QualifiedValue.Type is further bound to a PhysicalQuantity /
   * PhysicalQuantityVector with a concrete UnitType, this is the raw type
   * ref of that unit enumeration (e.g. 'Core/PhysicalQuantities.MassFlowRateUnit').
   * Parsed straight from the schema's DataTypeBinding chain — it is what lets
   * the emitter resolve a unit token to the right enumeration literal without
   * any hand-maintained property→unit table. Undefined when the slot has no
   * physical-quantity unit binding (plain QualifiedValue, non-composition, …).
   */
  unitEnumType?: string;
  /** Class that declared this property (for diagnostics / supertype walking). */
  declaredOn: string;
}

/**
 * One enumeration literal with the schema-declared identity fields the unit
 * resolver matches against. All optional except `name` — DEXPI's qualifier
 * enumerations (Scope, QuantityRange, …) carry only a name, while the
 * PhysicalQuantities unit enumerations additionally carry un_symbol / un_code /
 * rdl_label / rdl_uri. No field is ever invented; absent metadata stays
 * undefined so a token can only resolve against values the schema actually
 * declares.
 */
export interface EnumLiteralDetail {
  name: string;
  unSymbol?: string;
  unCode?: string;
  rdlLabel?: string;
  rdlUri?: string;
}

/**
 * One enumeration, fully qualified by the model + package it was declared in,
 * so a reference like `Core/DataTypes.QuantityProvenance` resolves
 * unambiguously without relying on bare-name global uniqueness. `model` is the
 * source-file basename (Core.xml → 'Core', Process.xml → 'Process'); `package`
 * is the enclosing <Package name="…">.
 */
export interface EnumDetail {
  model: string;
  package: string;
  name: string;
  literals: EnumLiteralDetail[];
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
  /**
   * Fully-qualified enumeration index keyed by `Model/Package.Enum`
   * (e.g. 'Core/DataTypes.QuantityProvenance', 'Process/Enumerations.PortDirection',
   * 'Core/PhysicalQuantities.MassFlowRateUnit'). Carries per-literal identity
   * metadata (un_symbol / un_code / rdl_label) so the unit resolver can match a
   * token against the schema's own fields, and so the data-type validator can
   * resolve a `<DataReference data="Model/Package.Enum.Literal"/>` target against
   * the real enumeration rather than a bare name. Built straight from the
   * `<Package><Enumeration><EnumerationLiteral>` structure — no model names are
   * hardcoded; `model` is the source-file basename.
   */
  private readonly enumDetails: Map<string, EnumDetail>;
  /**
   * Same-name merge warnings collected during construction. Empty unless
   * a loaded source (typically a Profile) redeclared a class already
   * present from an earlier source. Each entry names the class plus the
   * two sources involved. Non-fatal — the merge proceeds — but surfaced
   * so callers can flag potential typos or unintended name collisions.
   */
  readonly mergeWarnings: ReadonlyArray<string>;

  private constructor(
    classes: Map<string, DexpiClassInfo>,
    enumerations: Map<string, string[]> = new Map(),
    enumDetails: Map<string, EnumDetail> = new Map(),
    mergeWarnings: ReadonlyArray<string> = [],
  ) {
    this.classes = classes;
    this.enumerations = enumerations;
    this.enumDetails = enumDetails;
    this.mergeWarnings = mergeWarnings;
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
    const enumDetails = new Map<string, EnumDetail>();
    const mergeWarnings: string[] = [];

    const conflicts: string[] = [];

    for (const source of sources) {
      const { classes: parsed, enumerations: parsedEnums, enumDetails: parsedEnumDetails } = parseSchemaXml(source);
      // Merge enumerations ADDITIVELY, mirroring the class merge below: a later
      // source (e.g. a generated Profile) declaring an enumeration of the same
      // name EXTENDS it — new literals union in — rather than shadowing it. This
      // is what lets a Profile add a missing unit literal (e.g. KilomolePerHour)
      // to DEXPI's own MoleFlowRateUnit rather than creating a parallel enum.
      for (const [enumName, literals] of parsedEnums) {
        const existing = enumerations.get(enumName);
        if (existing) {
          const have = new Set(existing);
          for (const l of literals) if (!have.has(l)) existing.push(l);
        } else {
          enumerations.set(enumName, [...literals]);
        }
      }
      // Same additive union for the fully-qualified enum index, keyed by
      // package+name so the same enum from two model namespaces (Core vs a
      // Profile) merges in place and keeps Core's qualified path canonical.
      mergeEnumDetailsAdditive(enumDetails, parsedEnumDetails);
      for (const cls of parsed) {
        // Bare-name dedup assumes class names are globally unique across all
        // loaded DEXPI sources. This holds for DEXPI 2.0 — Process.xml +
        // Core.xml do not collide on any concrete or abstract class name.
        //
        // A redeclaration by a Profile is the normal extension case and
        // merges additively into the existing class — kind, supertypes,
        // description, sourceFile preserved; only properties not already
        // declared by name are appended. A mergeWarning is recorded so
        // callers can surface unintended collisions (e.g. a hand-authored
        // Profile typoing a standard class name) without blocking the load.
        //
        // Two collision shapes are NOT additive and DO throw because they
        // would silently produce a wrong-shape registry — the additive
        // merge can't represent them faithfully:
        //   1. Divergent supertypes — `class Compressor superTypes='X'`
        //      vs `Compressor superTypes='Y'`. The registry would keep
        //      one and silently discard the author's other intent.
        //   2. Divergent property kinds — `DataProperty Foo` in one
        //      source vs `ReferenceProperty Foo` in another on the same
        //      class. Strict-mode would then validate against the wrong
        //      kind and accept emission shapes the second author intended
        //      to reject.
        // These cases are the only ones that the old reject-on-conflict
        // default protected meaningfully; we preserve that protection
        // selectively. Everything else (additive property names with
        // matching kind, identical supertypes) just merges + warns.
        const existing = classes.get(cls.name);
        if (existing) {
          // 1. Supertype divergence.
          const existingSupers = [...existing.superTypes].sort().join(',');
          const incomingSupers = [...cls.superTypes].sort().join(',');
          if (existingSupers !== incomingSupers) {
            conflicts.push(
              `Class "${cls.name}" supertype divergence: ` +
              `"${existing.sourceFile}" declares [${existing.superTypes.join(', ') || '(none)'}], ` +
              `"${cls.sourceFile}" declares [${cls.superTypes.join(', ') || '(none)'}]`
            );
            continue;
          }
          // 2. Property-kind divergence (same name, different kind).
          const existingByName = new Map(existing.properties.map(p => [p.name, p]));
          let propConflict = false;
          for (const np of cls.properties) {
            const ep = existingByName.get(np.name);
            if (ep && ep.kind !== np.kind) {
              conflicts.push(
                `Class "${cls.name}" property "${np.name}" kind divergence: ` +
                `"${existing.sourceFile}" declares ${ep.kind}, ` +
                `"${cls.sourceFile}" declares ${np.kind}`
              );
              propConflict = true;
            }
          }
          if (propConflict) continue;
          // 3. Pure additive merge — append only new property names.
          for (const np of cls.properties) {
            if (!existingByName.has(np.name)) {
              existing.properties.push(np);
            }
          }
          mergeWarnings.push(
            `Class "${cls.name}" from "${cls.sourceFile}" merged into prior declaration from "${existing.sourceFile}"`
          );
          continue;
        }
        classes.set(cls.name, cls);
      }
    }

    if (conflicts.length > 0) {
      throw new Error(
        `DEXPI schema merge conflict — divergent declarations:\n  ${conflicts.join('\n  ')}`
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

    return new DexpiProcessClassRegistry(classes, enumerations, enumDetails, mergeWarnings);
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
    } catch (err) {
      // Don't bare-swallow: include the underlying error so a broken
      // install (missing schema file, permissions error, malformed XML)
      // is visible. An empty registry causes every strict-mode validator
      // to silently pass — the user must know the registry is degraded
      // so they don't trust a green --strict run that ran no rules.
      console.error(
        '[bpmn2dexpi] Could not load Process.xml/Core.xml from disk — strict-mode ' +
        'validation will silently pass because the registry is empty. Underlying error: ' +
        ((err as Error)?.message ?? String(err))
      );
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
   * the original schema sources. Same uniform merge semantics as
   * fromXmlSources(): same-name classes merge additively, with a warning
   * recorded for surfacing by callers.
   *
   * The current registry is left untouched.
   */
  cloneAndMergeXml(name: string, xml: string): DexpiProcessClassRegistry {
    // Deep-clone the classes map so the returned registry is independent.
    const cloned = new Map<string, DexpiClassInfo>();
    for (const [k, v] of this.classes) {
      cloned.set(k, { ...v, properties: [...v.properties], superTypes: [...v.superTypes] });
    }
    const { classes: parsed, enumerations: parsedEnums, enumDetails: parsedEnumDetails } = parseSchemaXml({ name, xml });
    // Clone enums + merge new ones ADDITIVELY (same package+name extends in
    // place rather than shadowing — consistent with fromXmlSources and the
    // class merge, so a Profile unit literal lands on the real enum).
    const clonedEnums = new Map<string, string[]>();
    for (const [k, v] of this.enumerations) clonedEnums.set(k, [...v]);
    for (const [enumName, literals] of parsedEnums) {
      const existing = clonedEnums.get(enumName);
      if (existing) {
        const have = new Set(existing);
        for (const l of literals) if (!have.has(l)) existing.push(l);
      } else {
        clonedEnums.set(enumName, [...literals]);
      }
    }
    const clonedEnumDetails = new Map<string, EnumDetail>();
    for (const [k, v] of this.enumDetails) clonedEnumDetails.set(k, v);
    mergeEnumDetailsAdditive(clonedEnumDetails, parsedEnumDetails);
    const mergeWarnings: string[] = [...this.mergeWarnings];
    const conflicts: string[] = [];
    // Same selective-throw semantics as fromXmlSources — divergent
    // supertypes or property kinds are not faithfully representable
    // by an additive merge, so they throw rather than silently
    // produce a wrong-shape registry. See the fromXmlSources block
    // for the full rationale.
    for (const cls of parsed) {
      const existing = cloned.get(cls.name);
      if (existing) {
        const existingSupers = [...existing.superTypes].sort().join(',');
        const incomingSupers = [...cls.superTypes].sort().join(',');
        if (existingSupers !== incomingSupers) {
          conflicts.push(
            `Class "${cls.name}" supertype divergence: ` +
            `"${existing.sourceFile}" declares [${existing.superTypes.join(', ') || '(none)'}], ` +
            `"${cls.sourceFile}" declares [${cls.superTypes.join(', ') || '(none)'}]`
          );
          continue;
        }
        const existingByName = new Map(existing.properties.map(p => [p.name, p]));
        let propConflict = false;
        for (const np of cls.properties) {
          const ep = existingByName.get(np.name);
          if (ep && ep.kind !== np.kind) {
            conflicts.push(
              `Class "${cls.name}" property "${np.name}" kind divergence: ` +
              `"${existing.sourceFile}" declares ${ep.kind}, ` +
              `"${cls.sourceFile}" declares ${np.kind}`
            );
            propConflict = true;
          }
        }
        if (propConflict) continue;
        for (const np of cls.properties) {
          if (!existingByName.has(np.name)) existing.properties.push(np);
        }
        mergeWarnings.push(
          `Class "${cls.name}" from "${cls.sourceFile}" merged into prior declaration from "${existing.sourceFile}"`
        );
        continue;
      }
      cloned.set(cls.name, cls);
    }
    if (conflicts.length > 0) {
      throw new Error(
        `DEXPI schema merge conflict — divergent declarations:\n  ${conflicts.join('\n  ')}`
      );
    }
    return new DexpiProcessClassRegistry(cloned, clonedEnums, clonedEnumDetails, mergeWarnings);
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
   * Resolve the inner Object class name for a composition property — i.e.
   * what type the records inside `<dexpi:components property="X">` should be.
   *
   *   getCompositionInnerClassName('MaterialComponent', 'PersistentIdentifiers')
   *     → 'PersistentIdentifier'
   *   getCompositionInnerClassName('MaterialComponent', 'MolecularWeight')
   *     → 'QualifiedValue'
   *
   * Returns null if the property isn't declared on the class (or its
   * supertypes), isn't a CompositionProperty, or its target type ref doesn't
   * resolve to a loaded class. The MaterialComponent / ProcessStep / Stream
   * editor uses this to dispatch composition rendering: QualifiedValue gets
   * the Value+Unit+URI form; everything else gets a generic list-of-records
   * editor introspecting the inner class's declared DataProperties.
   */
  getCompositionInnerClassName(className: string, propName: string): string | null {
    if (!this.classes.has(className)) return null;
    const prop = this.getProperties(className).find(p => p.name === propName);
    if (!prop || prop.kind !== 'composition' || !prop.targetType) return null;
    return parseTypeRef(prop.targetType);
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

  // ── Schema-driven unit + qualified-enum resolution ──────────────────────────

  /**
   * Literal names for a fully-qualified enumeration path
   * (`Model/Package.Enum`, e.g. 'Core/DataTypes.QuantityProvenance'), or null
   * when no such enumeration is registered. Backs the data-type validator's
   * DataReference target check (D9): a `data="Model/Package.Enum.Literal"`
   * resolves iff this returns a non-null list containing `Literal`.
   */
  getQualifiedEnumLiterals(qualifiedPath: string): string[] | null {
    const detail = this.enumDetails.get(qualifiedPath);
    return detail ? detail.literals.map(l => l.name) : null;
  }

  /**
   * Build the canonical enumeration reference path (`Model/Package.Enum`) for
   * an enum-typed property, resolving the property's declared targetType
   * against the model that declared it. Returns null when the property is
   * unknown or its target type is not a registered enumeration.
   *
   *   getEnumReferencePathForProperty('QualifiedValue', 'Provenance')
   *     → 'Core/DataTypes.QuantityProvenance'
   *   getEnumReferencePathForProperty('MaterialPort', 'NominalDirection')
   *     → 'Process/Enumerations.PortDirection'
   *
   * The emitter uses this to build `<DataReference data="<path>.<Literal>"/>`
   * with no hardcoded package or model name — both come from the schema.
   */
  getEnumReferencePathForProperty(className: string, propName: string): string | null {
    if (!this.classes.has(className)) return null;
    const prop = this.getProperties(className).find(p => p.name === propName);
    if (!prop || !prop.targetType) return null;
    const path = this.qualifyEnumRef(prop.targetType, prop.declaredOn);
    return path && this.enumDetails.has(path) ? path : null;
  }

  /**
   * The unit enumeration reference (`Model/Package.Enum`) bound to a
   * composition property's PhysicalQuantity, parsed from the schema's
   * DataTypeBinding chain (e.g. Stream.MassFlow →
   * 'Core/PhysicalQuantities.MassFlowRateUnit'). Null when the property has no
   * physical-quantity unit binding.
   */
  getUnitEnumRefForProperty(className: string, propName: string): string | null {
    if (!this.classes.has(className)) return null;
    const prop = this.getProperties(className).find(p => p.name === propName);
    return prop?.unitEnumType ?? null;
  }

  /**
   * Resolve a unit token to its enumeration literal NAME within a unit
   * enumeration, matching ONLY the schema's own declared fields — literal name
   * first, then un_symbol / un_code / rdl_label (all exact). Returns null when
   * the token matches none (the caller must then fail closed or offer the
   * picker — never guess). No alias table; resolution is schema-field equality.
   */
  resolveUnitLiteral(unitEnumPath: string, token: string): string | null {
    const detail = this.enumDetails.get(unitEnumPath);
    if (!detail) return null;
    const t = token.trim();
    if (t === '') return null;
    const byName = detail.literals.find(l => l.name === t);
    if (byName) return byName.name;
    const byMeta = detail.literals.find(
      l => l.unSymbol === t || l.unCode === t || l.rdlLabel === t,
    );
    return byMeta ? byMeta.name : null;
  }

  /**
   * Resolve a unit token across ALL PhysicalQuantities unit enumerations,
   * returning the qualified enum path + literal of the first match. Used ONLY
   * for composition properties that carry no PhysicalQuantity unit binding
   * (project/profile extensions such as MaterialStateType.MoleFlow): there is
   * no declared quantity type to scope the search to, so the token is matched
   * against every unit enum the schema declares. Bound properties never use
   * this — they resolve strictly within their bound enum and fail closed on a
   * mismatch, so a unit can never silently land in the wrong quantity type.
   * Still schema-driven (only real literals match); returns null on no match.
   */
  resolveUnitGlobal(token: string): { enumPath: string; literal: string } | null {
    const t = token.trim();
    if (t === '') return null;
    for (const [path, detail] of this.enumDetails) {
      if (detail.package !== 'PhysicalQuantities') continue;
      const literal = this.resolveUnitLiteral(path, t);
      if (literal) return { enumPath: path, literal };
    }
    return null;
  }

  /**
   * Bare names of every PhysicalQuantities unit enumeration the registry knows
   * (Core + any loaded Profiles). The Profile generator uses this to place a
   * missing unit literal under the unit enum its carrying property best matches
   * (e.g. a `MoleFlow` property → `MoleFlowRateUnit`) rather than guessing a
   * name. Sorted for deterministic generator output.
   */
  unitEnumNames(): string[] {
    const names = new Set<string>();
    for (const detail of this.enumDetails.values()) {
      if (detail.package === 'PhysicalQuantities') names.add(detail.name);
    }
    return [...names].sort();
  }

  /**
   * Qualified path (`Model/Package.Enum`) for a bare PhysicalQuantities unit-enum
   * name (e.g. 'MoleFlowRateUnit' -> 'Core/PhysicalQuantities.MoleFlowRateUnit'),
   * or null when no such unit enumeration is registered. Lets the emitter turn an
   * authored quantity choice into a fully-qualified unit `DataReference` so the
   * data-type tier (D9) can resolve — or flag — its literal target.
   */
  unitEnumPath(bareName: string): string | null {
    for (const [path, detail] of this.enumDetails) {
      if (detail.package === 'PhysicalQuantities' && detail.name === bareName) return path;
    }
    return null;
  }

  /**
   * Literal names of a unit enumeration path — for the properties-panel unit
   * picker (the same literals+Custom dropdown used for any enum-typed value).
   */
  getUnitEnumLiterals(unitEnumPath: string): string[] | null {
    const detail = this.enumDetails.get(unitEnumPath);
    return detail ? detail.literals.map(l => l.name) : null;
  }

  /**
   * Convenience for the UI: the unit enumeration's literals for a measurement
   * property, or null when the property has no physical-quantity unit binding.
   */
  getUnitEnumLiteralsForProperty(className: string, propName: string): string[] | null {
    const ref = this.getUnitEnumRefForProperty(className, propName);
    return ref ? this.getUnitEnumLiterals(ref) : null;
  }

  /**
   * Qualify a raw schema type ref to a `Model/Package.Enum` path. Absolute
   * refs ('/Package.Enum') resolve against the model that declared the
   * referencing property (its source-file basename); already-prefixed refs
   * ('Core/Package.Enum') are kept as-is. Returns null for refs that can't be
   * qualified (Builtin/*, MetaData/*, …).
   */
  private qualifyEnumRef(rawTypeRef: string, declaringClass: string): string | null {
    if (rawTypeRef.startsWith('Builtin/') || rawTypeRef.startsWith('MetaData/')) return null;
    if (rawTypeRef.startsWith('/')) {
      const model = this.modelOfClass(declaringClass);
      return model ? `${model}${rawTypeRef}` : null;
    }
    return rawTypeRef.includes('/') ? rawTypeRef : null;
  }

  /** Source-file basename (no .xml extension) of a class's declaring model. */
  private modelOfClass(className: string): string | null {
    const info = this.classes.get(className);
    if (!info) return null;
    return info.sourceFile.replace(/\.xml$/i, '');
  }
}

// ── Schema-XML parsing internals ──────────────────────────────────────────

interface ParsedSchema {
  classes: DexpiClassInfo[];
  /** Map of enumeration name → literal names (in declaration order). */
  enumerations: Map<string, string[]>;
  /** Fully-qualified enum index keyed by `Model/Package.Enum`, with metadata. */
  enumDetails: Map<string, EnumDetail>;
}

/**
 * Parse one schema XML string. Returns the list of classes declared in this
 * file, with supertypes resolved to bare names (cross-namespace refs like
 * 'Core/ConceptualObject' → 'ConceptualObject'; '/Process.X' → 'X'). Refs
 * into non-imported namespaces (currently 'MetaData/...') are dropped.
 */
function parseSchemaXml(source: SchemaSource): ParsedSchema {
  const parser = new DOMParser();
  const doc = parser.parseFromString(source.xml, 'text/xml');
  const out: DexpiClassInfo[] = [];

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
  // AggregatedDataType (PhysicalQuantity, PhysicalQuantityVector,
  // MultiLanguageString, …) declares DataProperty children just like a class
  // (PhysicalQuantity → Unit + Value; PhysicalQuantityVector → Unit + Values).
  // Parsing them as classes is what lets the property-name validator resolve a
  // nested `<Data property="Unit">` against PhysicalQuantity instead of
  // mis-attributing it to the enclosing QualifiedValue — i.e. it is what makes
  // the canonical nested form validatable and the flat form rejectable, with no
  // allowlist. They are Core-sourced, so concreteClasses() still excludes them
  // from the user-pickable ProcessStep list.
  extract('AggregatedDataType', 'concrete');

  // Parse every <Package><Enumeration><EnumerationLiteral> into the
  // fully-qualified enum index (Model/Package.Enum → literals + identity
  // metadata). `model` is the source-file basename; `package` is the enclosing
  // <Package>. Each literal carries the schema's own un_symbol / un_code /
  // rdl_label / rdl_uri so the unit resolver matches tokens against real
  // schema fields. The bare-name `enumerations` map (kept for back-compat with
  // getEnumerationLiterals) is derived from this.
  const model = source.name.replace(/\.xml$/i, '');
  const enumDetails = new Map<string, EnumDetail>();
  for (const el of Array.from(doc.querySelectorAll('Enumeration'))) {
    const name = el.getAttribute('name');
    if (!name) continue;
    let pkgEl: Element | null = el.parentElement;
    while (pkgEl && pkgEl.tagName !== 'Package') pkgEl = pkgEl.parentElement;
    const pkg = pkgEl?.getAttribute('name') ?? '';
    const literals: EnumLiteralDetail[] = [];
    for (const lit of Array.from(el.querySelectorAll(':scope > EnumerationLiteral'))) {
      const litName = lit.getAttribute('name');
      if (!litName) continue;
      const meta = (key: string): string | undefined => {
        const d = Array.from(lit.querySelectorAll(':scope > Data')).find(
          x => x.getAttribute('property') === `MetaData/${key}`,
        );
        const s = d?.querySelector(':scope > String')?.textContent?.trim();
        return s && s.length > 0 ? s : undefined;
      };
      literals.push({
        name: litName,
        unSymbol: meta('un_symbol'),
        unCode: meta('un_code'),
        rdlLabel: meta('rdl_label'),
        rdlUri: meta('rdl_uri'),
      });
    }
    const qualifiedPath = pkg ? `${model}/${pkg}.${name}` : `${model}/${name}`;
    enumDetails.set(qualifiedPath, { model, package: pkg, name, literals });
  }
  // Derive the bare-name map (last declaration of a given name wins, matching
  // prior behaviour).
  const enumerations = new Map<string, string[]>();
  for (const detail of enumDetails.values()) {
    enumerations.set(detail.name, detail.literals.map(l => l.name));
  }

  return { classes: out, enumerations, enumDetails };
}

/**
 * Additively merge a parsed enumeration index into an accumulating one, keyed by
 * package+name rather than model-qualified path. A later source declaring an
 * enumeration of the same package+name EXTENDS the existing one (new literals
 * union in); the first source's qualified path stays canonical, so a Profile
 * that adds a unit literal extends e.g. Core's MoleFlowRateUnit in place and
 * references resolve to the Core path. Mirrors the additive class merge.
 */
function mergeEnumDetailsAdditive(
  target: Map<string, EnumDetail>,
  incoming: Map<string, EnumDetail>,
): void {
  const byPkgName = new Map<string, string>();
  for (const [path, d] of target) byPkgName.set(`${d.package} ${d.name}`, path);
  for (const [path, detail] of incoming) {
    const key = `${detail.package} ${detail.name}`;
    const canonical = byPkgName.get(key);
    if (canonical) {
      const existing = target.get(canonical)!;
      const have = new Set(existing.literals.map(l => l.name));
      const merged = [...existing.literals];
      for (const lit of detail.literals) {
        if (!have.has(lit.name)) { merged.push(lit); have.add(lit.name); }
      }
      target.set(canonical, { ...existing, literals: merged });
    } else {
      byPkgName.set(key, path);
      target.set(path, detail);
    }
  }
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
      unitEnumType: kind === 'composition' ? parseUnitEnumBinding(el) : undefined,
      declaredOn,
    });
  }
  return out;
}

/**
 * Extract the unit enumeration a CompositionProperty's PhysicalQuantity is
 * bound to, straight from the schema's DataTypeBinding chain:
 *
 *   <CompositionProperty name="MassFlow">
 *     <BoundClass>
 *       <DataTypeBinding parameter="Core/QualifiedValue.Type">
 *         <UnionDataType>
 *           <BoundDataType>
 *             <DataTypeReference type="Core/PhysicalQuantities.PhysicalQuantity"/>
 *             <DataTypeBinding parameter="Core/PhysicalQuantities.PhysicalQuantity.UnitType">
 *               <DataTypeReference type="Core/PhysicalQuantities.MassFlowRateUnit"/>  ← this
 *
 * Handles both PhysicalQuantity and PhysicalQuantityVector (their UnitType
 * parameter both end in `.UnitType`). Returns the raw, already-model-prefixed
 * type ref (e.g. 'Core/PhysicalQuantities.MassFlowRateUnit') or undefined when
 * the property has no such binding. No property→unit table — the binding is
 * read entirely from the schema.
 */
function parseUnitEnumBinding(compEl: Element): string | undefined {
  for (const b of Array.from(compEl.querySelectorAll('DataTypeBinding'))) {
    const param = b.getAttribute('parameter') ?? '';
    if (/\.UnitType$/.test(param) && param.includes('PhysicalQuantit')) {
      const type = b.querySelector(':scope > DataTypeReference')?.getAttribute('type');
      if (type) return type;
    }
  }
  return undefined;
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
