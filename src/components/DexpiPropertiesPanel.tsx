import React from 'react';
import type { DexpiElement, DexpiPort, DexpiStream } from '../dexpi/moddle';
import { DexpiEnumerations } from '../utils/dexpiEnumerations';
import { DexpiProcessClassRegistry } from '../transformer/DexpiProcessClassRegistry';
// Vite ?raw import — bundles Process.xml as a string at build time (no runtime fetch needed)
import processXmlRaw from '../../dexpi-schema-files/Process.xml?raw';
import coreXmlRaw from '../../dexpi-schema-files/Core.xml?raw';

// Build registry once at module load — synchronous, browser-safe. This is
// the *base* registry (Process.xml only); when the user has imported DEXPI
// Profiles, the panel rebuilds an augmented registry on demand via
// useStepClasses() below, so Profile-declared classes (e.g. BiologicalReactor)
// surface in the dexpiType dropdown alongside the standard DEXPI 2.0 classes.
const DEXPI_REGISTRY = DexpiProcessClassRegistry.fromXml(processXmlRaw);

/**
 * Look up whether a property is required (lower>=1) on a class via the
 * registry, and resolve where the requirement came from (DEXPI vs a loaded
 * Profile). Returns null when the property is optional or the class isn't
 * in the registry. Used by the attribute editors to lock the
 * "Required in generated Profile" checkbox in the bottom-right cell of
 * the four-quadrant rule:
 *   user box ☐ + DEXPI/Profile lower>=1 → cannot be unset; Profiles
 *                                          narrow but never loosen.
 */
type RequiredSource = { source: 'dexpi' | 'profile'; sourceName: string };
function lookupRequiredSource(
  registry: DexpiProcessClassRegistry,
  className: string,
  propName: string,
): RequiredSource | null {
  if (!registry.isValidClass(className)) return null;
  const props = registry.getProperties(className);
  const prop = props.find(p => p.name === propName);
  if (!prop || prop.lower < 1) return null;
  const declaringClass = registry.getClass(prop.declaredOn);
  const src = declaringClass?.sourceFile ?? '';
  if (src === 'Process.xml' || src === 'Core.xml') {
    return { source: 'dexpi', sourceName: src.replace(/\.xml$/, '') };
  }
  return { source: 'profile', sourceName: src || '(unknown profile)' };
}

/**
 * Properties the transformer auto-emits without the user needing to
 * supply a value. Used by the placeholder logic to AVOID creating empty
 * attribute rows for things that already get filled in at export time
 * (Identifier from BPMN id, Label from BPMN name, Source/Target from
 * sequence-flow topology, etc).
 *
 * Keep in sync with BpmnToDexpiTransformer.ts emission paths. Any property
 * the transformer auto-emits when emitting an instance of `className`
 * (or any of its supertypes — supertype walking is done by the lookup)
 * belongs in the class's set here.
 *
 * UNIVERSAL_AUTO_EMITTED applies to every emitted Object regardless of
 * class (Identifier from id, Label from name).
 */
const UNIVERSAL_AUTO_EMITTED = new Set<string>(['Identifier', 'Label']);
const CLASS_AUTO_EMITTED: Record<string, Set<string>> = {
  // ProcessStep: HierarchyLevel is set via the dedicated dropdown at the
  // top of the panel (which writes the dexpi:element.hierarchyLevel
  // attribute, then transformer.ts:2300 emits <Data property="HierarchyLevel">).
  // Filtering it out of the attribute-name dropdown prevents users from
  // entering it twice — once via the top dropdown and once via the
  // generic attribute editor — which would emit two <Data property=
  // "HierarchyLevel"> siblings on the same Object and violate DEXPI's
  // upper="1" cardinality. Inherited by every ProcessStep subclass via
  // the supertype walk in isAutoEmittedByTransformer.
  ProcessStep: new Set(['HierarchyLevel']),
  EngineeringModel: new Set([
    'ExportDateTime', 'OriginatingSystemName',
    'OriginatingSystemVendorName', 'OriginatingSystemVersion',
    'ConceptualModel',
  ]),
  // Stream + every subclass auto-emit Source/Target from the BPMN
  // sourceRef/targetRef topology. (We can't walk to the abstract
  // ProcessConnection here because the transformer emits these on the
  // concrete subclass directly.)
  Stream: new Set(['Source', 'Target']),
  EnergyFlow: new Set(['Source', 'Target']),
  ThermalEnergyFlow: new Set(['Source', 'Target']),
  MechanicalEnergyFlow: new Set(['Source', 'Target']),
  ElectricalEnergyFlow: new Set(['Source', 'Target']),
  InformationFlow: new Set(['Source', 'Target']),

  // Ports get NominalDirection from BPMN port direction + ConnectorReference
  // from buildPortConnectorMap.
  MaterialPort: new Set(['NominalDirection', 'ConnectorReference']),
  EnergyPort: new Set(['NominalDirection', 'ConnectorReference']),
  InformationPort: new Set(['NominalDirection', 'ConnectorReference']),
  ThermalEnergyPort: new Set(['NominalDirection', 'ConnectorReference']),
  MechanicalEnergyPort: new Set(['NominalDirection', 'ConnectorReference']),
  ElectricalEnergyPort: new Set(['NominalDirection', 'ConnectorReference']),

  // Materials
  MaterialTemplate: new Set([
    'NumberOfMaterialComponents', 'NumberOfPhases', 'PhaseLabel', 'ListOfComponents',
  ]),
  ListOfMaterialComponents: new Set(['Component']),
  MaterialState: new Set(['Description', 'State']),

  // Placeholder slot emission for canonical measured-variable carriers
  QualifiedValue: new Set(['Value', 'DisplayText']),

  // Instrumentation: Description falls back to BPMN name. Subclasses inherit
  // this through the supertype walk that lookupAutoEmitted does.
  InstrumentationActivity: new Set(['Description']),
};

/**
 * Walk the supertype chain to determine whether `propName` is auto-emitted
 * by the transformer when emitting an instance of `className`. Returns
 * true for universal properties (Identifier/Label) and for properties
 * the transformer fills in on this class or any of its supertypes.
 */
function isAutoEmittedByTransformer(
  className: string,
  propName: string,
  registry: DexpiProcessClassRegistry,
): boolean {
  if (UNIVERSAL_AUTO_EMITTED.has(propName)) return true;
  const visited = new Set<string>();
  const walk = (cls: string): boolean => {
    if (visited.has(cls)) return false;
    visited.add(cls);
    if (CLASS_AUTO_EMITTED[cls]?.has(propName)) return true;
    const info = registry.getClass(cls);
    if (!info) return false;
    for (const st of info.superTypes) if (walk(st)) return true;
    return false;
  };
  return walk(className);
}

/**
 * Compute the data-kind required-but-not-auto-emitted properties for a
 * given className. These are the rows the attribute panel materialises
 * as empty placeholders so the user knows what they still need to fill
 * in (e.g. Compressing.Method). Reference/Composition kinds are excluded
 * — they don't fit the simple text-attribute UI.
 */
function computeRequiredPlaceholderProps(
  registry: DexpiProcessClassRegistry | null,
  className: string,
): string[] {
  if (!registry) return [];
  if (!registry.isValidClass(className)) return [];
  const out: string[] = [];
  for (const p of registry.getProperties(className)) {
    if (p.lower < 1) continue;
    if (p.kind !== 'data') continue;
    if (isAutoEmittedByTransformer(className, p.name, registry)) continue;
    out.push(p.name);
  }
  return out;
}

/**
 * Data-kind property names declared (or inherited) on `className`, with
 * transformer-auto-emitted ones (Identifier/Label/etc.) filtered out.
 * Drives the Name dropdown in the attribute editor — same UX shape as the
 * dexpiType class dropdown: schema-known options + a Custom escape hatch.
 * Loaded Profiles flow in through `registry.getProperties`, so any
 * Profile-declared property automatically widens the dropdown.
 */
function dataPropertyNamesForClass(
  registry: DexpiProcessClassRegistry | null,
  className: string,
): string[] {
  if (!registry || !registry.isValidClass(className)) return [];
  return registry
    .getProperties(className)
    .filter(p => p.kind === 'data')
    .filter(p => !isAutoEmittedByTransformer(className, p.name, registry))
    .map(p => p.name)
    .sort();
}

/**
 * Attribute Name + Value editor row.
 *
 * Mirrors the dexpiType dropdown UX one level down — for each attribute,
 *  - Name: <select> of schema-known data-property names for the wrapping
 *    class, plus a "— Custom..." option that switches to a free-text
 *    input. Falls back to a plain free-text input when the registry
 *    knows no class properties (e.g. unknown class, registry not loaded).
 *  - Value: when the chosen Name resolves to an Enumeration-typed property
 *    in the schema/Profile, a <select> of the enum literals + Custom
 *    fallback. Otherwise (primitive types, or Custom name), a plain
 *    free-text input — preserving the panel's current behavior for
 *    non-enum data.
 *
 * Custom-mode is held as local state per row so the Custom toggle survives
 * even when the typed value happens to coincide with a known literal /
 * property name. Initial mode is derived from the persisted value.
 */
export const AttributeNameValueRow: React.FC<{
  attr: { name?: string; value?: string };
  registry: DexpiProcessClassRegistry | null;
  className: string;
  onChange: (updates: { name?: string; value?: string }) => void;
  /** Optional content inserted between the Attribute and Value rows
   *  (e.g. the Stream editor's Attribute URI input). */
  betweenNameAndValue?: React.ReactNode;
}> = ({ attr, registry, className, onChange, betweenNameAndValue }) => {
  const knownNames = React.useMemo(
    () => dataPropertyNamesForClass(registry, className),
    [registry, className],
  );

  const valueLiterals = React.useMemo<string[] | null>(() => {
    if (!registry || !attr.name) return null;
    return registry.getEnumLiteralsForProperty(className, attr.name) ?? null;
  }, [registry, className, attr.name]);

  const [nameCustom, setNameCustom] = React.useState<boolean>(
    !!attr.name && knownNames.length > 0 && !knownNames.includes(attr.name),
  );
  const [valueCustom, setValueCustom] = React.useState<boolean>(
    !!attr.value && valueLiterals !== null && !valueLiterals.includes(attr.value),
  );

  // Re-derive when the wrapping class changes (different element selected),
  // so a row that was Custom on Reactor doesn't stay Custom when the user
  // jumps to a Compressor where the same name now is known. We don't depend
  // on attr.name/value here on purpose — those toggle interactively below.
  React.useEffect(() => {
    setNameCustom(!!attr.name && knownNames.length > 0 && !knownNames.includes(attr.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownNames]);
  React.useEffect(() => {
    setValueCustom(!!attr.value && valueLiterals !== null && !valueLiterals.includes(attr.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueLiterals]);

  const handleNameSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === '__custom__') {
      setNameCustom(true);
      onChange({ name: '' });
    } else {
      setNameCustom(false);
      onChange({ name: v });
    }
  };

  const handleValueSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === '__custom__') {
      setValueCustom(true);
      onChange({ value: '' });
    } else {
      setValueCustom(false);
      onChange({ value: v });
    }
  };

  const showNameDropdown = knownNames.length > 0;
  const nameSelectValue = nameCustom
    ? '__custom__'
    : (attr.name && knownNames.includes(attr.name) ? attr.name : '');

  const showValueDropdown = valueLiterals !== null && !nameCustom;
  const valueSelectValue = valueCustom
    ? '__custom__'
    : (attr.value && valueLiterals && valueLiterals.includes(attr.value) ? attr.value : '');

  return (
    <>
      <label>
        Attribute:
        {showNameDropdown ? (
          <select value={nameSelectValue} onChange={handleNameSelect}>
            <option value="">-- Select --</option>
            {knownNames.map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
            <option value="__custom__">— Custom...</option>
          </select>
        ) : (
          <input
            type="text"
            value={attr.name || ''}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        )}
        {showNameDropdown && nameCustom && (
          <input
            type="text"
            value={attr.name || ''}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Custom attribute name..."
            autoFocus
            style={{ marginTop: '4px' }}
          />
        )}
      </label>

      {betweenNameAndValue}

      <label>
        Value:
        {showValueDropdown ? (
          <select value={valueSelectValue} onChange={handleValueSelect}>
            <option value="">-- Select --</option>
            {valueLiterals!.map(lit => (
              <option key={lit} value={lit}>{lit}</option>
            ))}
            <option value="__custom__">— Custom...</option>
          </select>
        ) : (
          <input
            type="text"
            value={attr.value || ''}
            onChange={(e) => onChange({ value: e.target.value })}
          />
        )}
        {showValueDropdown && valueCustom && (
          <input
            type="text"
            value={attr.value || ''}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder="Custom value..."
            autoFocus
            style={{ marginTop: '4px' }}
          />
        )}
      </label>
    </>
  );
};

/**
 * Read ProcessStep attributes from a moddle `dexpi:Element`, supporting
 * BOTH the legacy flat `<dexpi:attribute>` shape AND the canonical-carrier
 * shape (`<dexpi:data property="X">v</dexpi:data>` for plain attrs and
 * `<dexpi:components property="X"><dexpi:object type="Core/QualifiedValue">…
 * </dexpi:object></dexpi:components>` for measurement attrs).
 *
 * Canonical shape mirrors what MaterialComponent and Stream already use;
 * this reader brings ProcessStep onto the same convention. Legacy reads
 * are still supported so older saves continue to load — the canonical
 * shape wins when both forms exist on the same element (transition state).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readAttributesFromDexpiElement(dexpiElement: any): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];

  // Canonical: flat data carriers (enum literals, boolean flags, simple strings).
  const dataChildren = Array.isArray(dexpiElement.data) ? dexpiElement.data : [];
  for (const d of dataChildren) {
    const propName = d.property ?? d.$attrs?.property ?? '';
    const body = d.body ?? d.$body ?? d._ ?? '';
    if (!propName) continue;
    out.push({ name: propName, value: String(body) });
  }

  // Canonical: composition carriers with QualifiedValue inner — measurement
  // attrs with optional Value+Unit+Provenance+Range+Scope+UnitReference and
  // an optional References>QuantityKindReference sibling for the attribute URI.
  const componentsChildren = Array.isArray(dexpiElement.components) ? dexpiElement.components : [];
  for (const carrier of componentsChildren) {
    const propName = carrier.property ?? carrier.$attrs?.property ?? '';
    if (!propName) continue;
    const objs = carrier.objects ?? carrier.$children ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qv = (Array.isArray(objs) ? objs : []).find((o: any) =>
      (o.$type || '').toLowerCase().includes('object') &&
      (o.type === 'Core/QualifiedValue' || o.$attrs?.type === 'Core/QualifiedValue')
    );
    if (!qv) continue;
    const qvData = Array.isArray(qv.data) ? qv.data : (qv.$children ?? []);
    let value = '';
    let unit: string | undefined;
    let unitUri: string | undefined;
    let scope: string | undefined;
    let range: string | undefined;
    let provenance: string | undefined;
    for (const dc of qvData) {
      const dp = dc.property ?? dc.$attrs?.property;
      const dv = (dc.body ?? dc.$body ?? '').toString().trim();
      if (dp === 'Value') value = dv;
      else if (dp === 'Unit') unit = dv;
      else if (dp === 'UnitReference') unitUri = dv;
      else if (dp === 'Scope') scope = dv;
      else if (dp === 'Range') range = dv;
      else if (dp === 'Provenance') provenance = dv;
    }
    let nameUri: string | undefined;
    const qvRefs = Array.isArray(qv.references) ? qv.references : [];
    for (const r of qvRefs) {
      const rp = r.property ?? r.$attrs?.property;
      if (rp === 'QuantityKindReference') {
        nameUri = r.objects ?? r.uidRef ?? r.$attrs?.objects ?? r.$attrs?.uidRef;
        break;
      }
    }
    const required = carrier.required === true || carrier.$attrs?.required === 'true';
    out.push({
      name: propName,
      value,
      ...(unit !== undefined ? { unit } : {}),
      ...(unitUri !== undefined ? { unitUri } : {}),
      ...(nameUri !== undefined ? { nameUri } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(range !== undefined ? { range } : {}),
      ...(provenance !== undefined ? { provenance } : {}),
      ...(required ? { required: true } : {}),
    });
  }

  return out;
}

/**
 * Convert the panel's attribute-array view into canonical-carrier moddle
 * children. Returns `{ data, components }` for assignment onto a moddle
 * `dexpi:Element`.
 *
 * Kind dispatch is **schema-driven**: each attribute's declared kind comes
 * from `registry.getProperties(className)`. Schema-data → flat
 * `<dexpi:data property="X">v</dexpi:data>`; schema-composition →
 * QualifiedValue-shaped `<dexpi:components property="X"><dexpi:object
 * type="Core/QualifiedValue">…</dexpi:object></dexpi:components>` carrier
 * (same canonical-extension shape streams + MaterialComponent emit).
 *
 * For project-extension property names the registry doesn't declare (custom
 * authoring beyond Process.xml's vocabulary), kind falls back to a presence
 * heuristic — any unit / URI / scope-range-provenance metadata implies the
 * author intended a measurement. The heuristic only fires on unknown
 * names; schema-declared dispatch is the primary path.
 *
 * Empty rows (no name or no value) are dropped silently.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attrsToCanonicalCarriers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attrs: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  moddle: any,
  registry: DexpiProcessClassRegistry | null,
  className: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { data: any[]; components: any[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const components: any[] = [];
  const buildData = (property: string, body: string) =>
    moddle.create('dexpi:Data', { property, body });

  // Schema-driven kind lookup. Map property name → declared kind from the
  // registry. Empty when the registry doesn't know the class (e.g. custom-
  // typed steps falling back to heuristics until a Profile is loaded).
  const declaredKindByName = new Map<string, 'data' | 'composition' | 'reference'>();
  if (registry && registry.isValidClass(className)) {
    for (const p of registry.getProperties(className)) {
      declaredKindByName.set(p.name, p.kind);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolveKind = (attr: any): 'data' | 'composition' => {
    const declared = declaredKindByName.get(attr.name);
    if (declared === 'composition') return 'composition';
    if (declared === 'data' || declared === 'reference') return 'data';
    // Unknown property name (project-extension). Fall back to a presence
    // heuristic — any measurement-oriented metadata implies the author
    // intended a QualifiedValue carrier. Pure flat name+value emits as
    // a Data carrier.
    return (attr.unit || attr.unitUri || attr.nameUri ||
            attr.scope || attr.range || attr.provenance) ? 'composition' : 'data';
  };

  for (const attr of attrs) {
    if (!attr?.name || !attr?.value) continue;
    if (resolveKind(attr) === 'data') {
      data.push(buildData(attr.name, attr.value));
      continue;
    }
    // Composition carrier with QV inner — same canonical-extension shape
    // streams + MaterialComponent already emit.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qvData: any[] = [
      buildData('Value', attr.value),
      // DisplayText (lower=1 on Core/QualifiedValue per Core.xml). Derive
      // deterministically from value + unit so the cardinality validator
      // stays clean on emit. Same convention transformer.ts and the
      // MaterialComponent path already use.
      buildData('DisplayText', attr.unit ? `${attr.value} ${attr.unit}` : attr.value),
    ];
    if (attr.unit) qvData.push(buildData('Unit', attr.unit));
    if (attr.unitUri) qvData.push(buildData('UnitReference', attr.unitUri));
    if (attr.scope) qvData.push(buildData('Scope', attr.scope));
    if (attr.range) qvData.push(buildData('Range', attr.range));
    if (attr.provenance) qvData.push(buildData('Provenance', attr.provenance));
    const qvObjectProps: Record<string, unknown> = {
      type: 'Core/QualifiedValue',
      data: qvData,
    };
    if (attr.nameUri) {
      qvObjectProps.references = [
        moddle.create('dexpi:References', {
          property: 'QuantityKindReference',
          objects: attr.nameUri,
        }),
      ];
    }
    const carrierProps: Record<string, unknown> = {
      property: attr.name,
      objects: [moddle.create('dexpi:Object', qvObjectProps)],
    };
    if (attr.required) carrierProps.required = true;
    components.push(moddle.create('dexpi:Components', carrierProps));
  }
  return { data, components };
}

/**
 * Map a BPMN-side `<dexpi:stream streamType="...">` discriminator to the
 * DEXPI class the transformer emits for it. Mirrors the same map in
 * BpmnToDexpiTransformer.streamTypeToDexpiClass and DexpiProfileGenerator's
 * own copy — keeping it inline here lets the panel resolve a stream's
 * className without an additional cross-module dependency.
 */
function streamTypeToDexpiClassName(streamType: string | null | undefined): string {
  switch (streamType) {
    case 'ThermalEnergyFlow':    return 'ThermalEnergyFlow';
    case 'MechanicalEnergyFlow': return 'MechanicalEnergyFlow';
    case 'ElectricalEnergyFlow': return 'ElectricalEnergyFlow';
    case 'EnergyFlow':           return 'EnergyFlow';
    case 'InformationFlow':      return 'InformationFlow';
    default:                     return 'Stream';
  }
}

/**
 * Names that are concrete classes in the registry but should NOT appear in
 * the *task* dexpiType dropdown — they're either non-step classes (ports,
 * flows, templates), or have dedicated event mappings that bypass tasks
 * (Source/Sink → StartEvent/EndEvent per the representation methodology).
 */
const NON_TASK_CLASSES = new Set<string>([
  'MaterialPort', 'EnergyPort', 'InformationPort', 'ThermalEnergyPort',
  'MechanicalEnergyPort', 'ElectricalEnergyPort', 'MaterialFlow', 'EnergyFlow',
  'ElectricalEnergyFlow', 'MechanicalEnergyFlow', 'ThermalEnergyFlow',
  'InformationFlow', 'InformationVariant', 'MaterialTemplate', 'MaterialState',
  'MaterialStateType', 'ListOfMaterialComponents', 'MaterialComponent',
  'PureMaterialComponent', 'CustomMaterialComponent', 'Composition',
  'ProcessModel', 'Stream', 'Source', 'Sink',
]);

function filterTaskClasses(allConcrete: string[]): string[] {
  return allConcrete.filter(c => !NON_TASK_CLASSES.has(c));
}

/** Default class list (no Profiles loaded) — derived from Process.xml only. */
const STEP_CLASSES = filterTaskClasses(DEXPI_REGISTRY.concreteClasses());

interface DexpiPropertiesPanelProps {
  element: any;
  modeler: any;
  /**
   * DEXPI Profiles loaded in the current session. When non-empty, the
   * dexpiType dropdown is augmented with Profile-declared concrete
   * classes so users can pick (e.g.) BiologicalReactor without having
   * to fall through the Custom / external RDL escape hatch. The base
   * Process.xml registry is the static fallback when this prop is
   * undefined or empty.
   */
  loadedProfiles?: { name: string; xml: string }[];
}

export const DexpiPropertiesPanel: React.FC<DexpiPropertiesPanelProps> = ({ element, modeler, loadedProfiles }) => {
  // Full registry: Process.xml + Core.xml + any loaded Profiles. Used both
  // for the dropdown class list AND for the required-flag lookup that the
  // step-attribute editor consults to lock the checkbox when a property is
  // already DEXPI/Profile-required (the bottom-right cell of the four-
  // quadrant rule).
  const augmentedRegistry = React.useMemo<DexpiProcessClassRegistry | null>(() => {
    try {
      return DexpiProcessClassRegistry.fromXmlSources([
        { name: 'Process.xml', xml: processXmlRaw },
        { name: 'Core.xml',    xml: coreXmlRaw },
        ...(loadedProfiles ?? []),
      ], { strictSupertypes: false });
    } catch {
      return null;
    }
  }, [loadedProfiles]);

  const dropdownClasses = React.useMemo<string[]>(() => {
    if (!augmentedRegistry) return STEP_CLASSES;
    if (!loadedProfiles || loadedProfiles.length === 0) return STEP_CLASSES;
    try {
      return filterTaskClasses(augmentedRegistry.concreteClasses());
    } catch {
      return STEP_CLASSES;
    }
  }, [augmentedRegistry, loadedProfiles]);
  // Likewise, broaden the "is custom?" check so a Profile-declared class
  // is recognized as standard rather than triggering the Custom-type UI.
  const isKnownClass = React.useCallback((name: string): boolean => {
    if (DEXPI_REGISTRY.isValidClass(name)) return true;
    if (loadedProfiles) {
      for (const p of loadedProfiles) {
        // Cheap textual match avoids rebuilding the full registry just to
        // test class membership; sufficient because Profile XML class names
        // appear as `name="..."` attributes on ConcreteClass / AbstractClass.
        const re = new RegExp(`<(?:Concrete|Abstract)Class[^>]*\\bname="${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"`);
        if (re.test(p.xml)) return true;
      }
    }
    return false;
  }, [loadedProfiles]);
  const [dexpiType, setDexpiType] = React.useState<string>('');
  const [identifier, setIdentifier] = React.useState<string>('');
  const [uid, setUid] = React.useState<string>('');
  const [customUri, setCustomUri] = React.useState<string>('');
  const [customSuperType, setCustomSuperType] = React.useState<string>('');
  const [elementName, setElementName] = React.useState<string>('');
  const [ports, setPorts] = React.useState<DexpiPort[]>([]);
  const [hasData, setHasData] = React.useState<boolean>(false);
  const [isCustomType, setIsCustomType] = React.useState<boolean>(false);
  const [customTypeName, setCustomTypeName] = React.useState<string>('');

  React.useEffect(() => {
    if (element) {
      const businessObject = element.businessObject;
      const extensionElements = businessObject.extensionElements;
      
      // Look for dexpiElement and portsContainer if extensionElements exist
      let dexpiElement: any = undefined;
      let portsContainer: any = undefined;
      let p: any[] = [];
      
      if (extensionElements && extensionElements.values) {
        // Look for dexpi:Element with various possible type names
        dexpiElement = extensionElements.values.find(
          (e: any) => {
            const type = e.$type || '';
            return type === 'dexpi:Element' || 
                   type === 'dexpi:element' || 
                   type.toLowerCase().includes('element');
          }
        );
        
        // Also look for legacy <ports> container (not dexpi:Element)
        portsContainer = extensionElements.values.find(
          (e: any) => {
            const type = (e.$type || '').toLowerCase();
            return type === 'ports' || 
                   type.includes('ports') || 
                   e.port !== undefined ||
                   (e.$instanceOf && e.$instanceOf('ports'));
          }
        );
        
        // Extract ports if we have dexpiElement or portsContainer
        if (dexpiElement || portsContainer) {
          setHasData(true);
          
          if (dexpiElement) {
            p = dexpiElement.ports || [];
            if (typeof dexpiElement.get === 'function') {
              p = dexpiElement.get('ports') || p;
            }
          }
          
          // If no ports from dexpiElement, try portsContainer
          if (p.length === 0 && portsContainer) {
            // Try multiple ways to access port children
            if (Array.isArray(portsContainer.port)) {
              p = portsContainer.port;
            } else if (portsContainer.port) {
              p = [portsContainer.port];
            }
            
            if (p.length === 0 && portsContainer.$children) {
              p = portsContainer.$children.filter((child: any) => 
                child.$type && (child.$type === 'port' || child.$type.toLowerCase().includes('port'))
              );
            }
            
            if (p.length === 0 && typeof portsContainer.get === 'function') {
              p = portsContainer.get('port') || [];
            }
            
            if (p.length > 0) {
              // Normalize legacy format ports
              p = p.map((legacyPort: any) => {
                // Normalize direction: Input/Output → Inlet/Outlet for consistency
                let direction = legacyPort.direction || 'Inlet';
                if (direction === 'Input') direction = 'Inlet';
                if (direction === 'Output') direction = 'Outlet';
                
                const normalized = {
                  portId: `${businessObject.id}_${legacyPort.name || legacyPort.label}`,
                  name: legacyPort.name || legacyPort.label || 'Unnamed',
                  portType: legacyPort.type || legacyPort.portType || 'MaterialPort',
                  direction: direction,
                  anchorSide: legacyPort.anchorSide || 'left',
                  anchorOffset: legacyPort.anchorOffset || 0.5,
                  _legacy: true,
                  _originalId: legacyPort.id
                };
                return normalized;
              });
            }
          }
        } else {
          setHasData(false);
        }
      } else {
        setHasData(false);
      }
      
      // Extract properties - runs for ALL elements
      let dtype = dexpiElement?.dexpiType || dexpiElement?.type || '';
      const ident = dexpiElement?.identifier || dexpiElement?.id || businessObject.name || businessObject.id || '';
      const u = dexpiElement?.uid || businessObject.id || '';
      
      // Auto-detect DEXPI type if not already set
      if (!dtype) {
        if (element.type === 'bpmn:StartEvent') {
          const isPortProxy = element.parent && 
            (element.parent.type === 'bpmn:SubProcess' || element.parent.type === 'bpmn:Process') &&
            portsContainer;
          if (!isPortProxy) {
            dtype = 'Source';
          }
        } else if (element.type === 'bpmn:EndEvent') {
          const isPortProxy = element.parent && 
            (element.parent.type === 'bpmn:SubProcess' || element.parent.type === 'bpmn:Process') &&
            portsContainer;
          if (!isPortProxy) {
            dtype = 'Sink';
          }
        } else if (element.type === 'bpmn:SubProcess') {
          // Try name-based inference for subprocesses too
          dtype = 'ProcessStep';
        } else if (element.type === 'bpmn:Task' || element.type.includes('Task')) {
          const di = element.di;
          let fill = '';
          if (di) {
            fill = di.fill || di.$attrs?.['bioc:fill'] || di.$attrs?.fill || '';
          }
          const hasDataOutput = businessObject.dataOutputAssociations?.length > 0;
          const hasDataInput = businessObject.dataInputAssociations?.length > 0;
          const isGreen = fill.toLowerCase().includes('#c8e6c9') || 
                        fill.toLowerCase().includes('c8e6c9') ||
                        (hasDataOutput && !hasDataInput);

          if (isGreen) {
            dtype = 'InstrumentationActivity';
          } else {
            // Try to infer from task name using the registry — shows a meaningful type
            // instead of always defaulting to ProcessStep for unannotated imports
            dtype = 'ProcessStep';
          }
        }
      }
      
      setDexpiType(dtype);
      setIdentifier(ident);
      setUid(u);
      setCustomUri(dexpiElement?.customUri || '');
      setCustomSuperType(dexpiElement?.customSuperType || '');
      // Detect if loaded type is a custom (non-DEXPI) type
      const isCustom = !!dtype && !isKnownClass(dtype) && dtype !== 'Source' && dtype !== 'Sink';
      setIsCustomType(isCustom);
      setCustomTypeName(isCustom ? dtype : '');
      setElementName(businessObject.name || '');
      setPorts(Array.isArray(p) ? p : []);
    }
  }, [element]);

  const updateDexpiElement = (updates: Partial<DexpiElement>) => {
    if (!modeler || !element) return;

    const modeling = modeler.get('modeling');
    const moddle = modeler.get('moddle');
    const businessObject = element.businessObject;

    let extensionElements = businessObject.extensionElements;
    if (!extensionElements) {
      extensionElements = moddle.create('bpmn:ExtensionElements');
    }

    let dexpiElement = extensionElements.values?.find(
      (e: any) => e.$type === 'dexpi:Element'
    );

    if (!dexpiElement) {
      dexpiElement = moddle.create('dexpi:Element');
      if (!extensionElements.values) {
        // eslint-disable-next-line react-hooks/immutability
        extensionElements.values = [];
      }
      extensionElements.values.push(dexpiElement);
    }

    Object.assign(dexpiElement, updates);

    modeling.updateProperties(element, {
      extensionElements
    });
    
    // Trigger visual update if dexpiType changed
    if (updates.dexpiType) {
      const eventBus = modeler.get('eventBus');
      
      // Force a redraw by firing element.changed event
      eventBus.fire('element.changed', { element });
    }
  };

  const handleDexpiTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newType = e.target.value;
    if (newType === '__custom__') {
      setIsCustomType(true);
      setCustomTypeName('');
      setCustomSuperType('');
    } else {
      setIsCustomType(false);
      setCustomTypeName('');
      setCustomSuperType('');
      setDexpiType(newType);
      updateDexpiElement({ dexpiType: newType, customUri: undefined, customSuperType: undefined });

      // Auto-fill element name with the DEXPI type if name is empty or still generic
      const isGenericName = !elementName ||
        elementName === 'ProcessStep' ||
        elementName === dexpiType ||  // was previously auto-filled
        element.businessObject.name === element.businessObject.id; // BPMN default
      if (isGenericName && newType !== 'ProcessStep') {
        const modeling = modeler.get('modeling');
        modeling.updateProperties(element, { name: newType });
        setElementName(newType);
      }
    }
  };

  const handleCustomTypeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setCustomTypeName(val);
    setDexpiType(val);
    updateDexpiElement({ dexpiType: val });
  };

  const handleUidChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newUid = e.target.value;
    setUid(newUid);
    updateDexpiElement({ uid: newUid });
  };

  const addPort = () => {
    const moddle = modeler.get('moddle');
    const newPort = moddle.create('dexpi:Port', {
      portId: `port-${Date.now()}`,
      name: `Port ${ports.length + 1}`,
      portType: 'MaterialPort',
      direction: 'Inlet',
      anchorSide: 'left',
      anchorOffset: 0.5
    });

    const updatedPorts = [...ports, newPort];
    setPorts(updatedPorts);
    updateDexpiElement({ ports: updatedPorts });
  };

  const removePort = (portId: string) => {
    const updatedPorts = ports.filter(p => p.portId !== portId);
    setPorts(updatedPorts);
    updateDexpiElement({ ports: updatedPorts });
  };

  const updatePort = (portId: string, updates: Partial<DexpiPort>) => {
    const updatedPorts = ports.map(p => {
      if (p.portId === portId) {
        // Check if this is a legacy port
        if ((p as any)._legacy) {
          // For legacy ports, update the original port object directly
          // Don't create new moddle objects
          return {
            ...p,
            ...updates
          };
        } else {
          // For dexpi:Port objects, create proper moddle instance.
          // data / references / components are the canonical-carrier slots
          // for port-level DEXPI attributes (Identifier, Label,
          // PersistentIdentifiers, MaterialTemplateReference, …) — forwarded
          // through every recreate so attribute edits authored via the
          // PortAttributesSection persist across updates to other fields.
          const moddle = modeler.get('moddle');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const u = updates as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pAny = p as any;
          const updatedPort = moddle.create('dexpi:Port', {
            portId: updates.portId !== undefined ? updates.portId : p.portId,
            name: updates.name !== undefined ? updates.name : p.name,
            portType: updates.portType !== undefined ? updates.portType : p.portType,
            direction: updates.direction !== undefined ? updates.direction : p.direction,
            anchorSide: updates.anchorSide !== undefined ? updates.anchorSide : p.anchorSide,
            anchorOffset: updates.anchorOffset !== undefined ? updates.anchorOffset : p.anchorOffset,
            anchorX: updates.anchorX !== undefined ? updates.anchorX : p.anchorX,
            anchorY: updates.anchorY !== undefined ? updates.anchorY : p.anchorY,
            subReference: updates.subReference !== undefined ? updates.subReference : pAny.subReference,
            superReference: updates.superReference !== undefined ? updates.superReference : pAny.superReference,
            data: u.data !== undefined ? u.data : pAny.data,
            references: u.references !== undefined ? u.references : pAny.references,
            components: u.components !== undefined ? u.components : pAny.components,
          });
          return updatedPort;
        }
      }
      return p;
    });
    setPorts(updatedPorts);
    
    // For legacy ports, we need to update them differently
    const hasLegacyPorts = updatedPorts.some((p: any) => p._legacy);
    if (hasLegacyPorts) {
      // Update legacy ports in the extensionElements directly
      const modeling = modeler.get('modeling');
      const businessObject = element.businessObject;
      let extensionElements = businessObject.extensionElements;
      
      if (!extensionElements) {
        const moddle = modeler.get('moddle');
        extensionElements = moddle.create('bpmn:ExtensionElements');
      }
      
      // Find or create ports container
      let portsContainer = extensionElements.values?.find((e: any) => {
        const type = (e.$type || '').toLowerCase();
        return type === 'ports' || type.includes('ports') || e.port !== undefined;
      });
      
      if (!portsContainer) {
        const moddle = modeler.get('moddle');
        portsContainer = moddle.create('ports');
        // eslint-disable-next-line react-hooks/immutability
        extensionElements.values = extensionElements.values || [];
        extensionElements.values.push(portsContainer);
      }
      
      // Update the ports in the container, removing the normalized fields
      const legacyPorts = updatedPorts.map((p: any) => {
        if (p._legacy) {
          // Convert back to legacy format
          return {
            $type: 'port',
            id: p._originalId || p.portId,
            name: p.name,
            type: p.portType,
            direction: p.direction,
            label: p.name,
            anchorSide: p.anchorSide,
            anchorOffset: p.anchorOffset
          };
        }
        return p;
      });
      
      portsContainer.port = legacyPorts.filter((p: any) => p.$type === 'port');
      
      modeling.updateProperties(element, {
        extensionElements
      });
    } else {
      updateDexpiElement({ ports: updatedPorts });
    }
  };

  const isPortConnected = (port: DexpiPort): boolean => {
    const businessObject = element.businessObject;
    const elementId = businessObject.id;
    
    // Check for InformationPorts with data associations
    if (port.portType === 'InformationPort') {
      if (port.direction === 'Outlet' && businessObject.dataOutputAssociations?.length > 0) {
        return true;
      }
      if (port.direction === 'Inlet' && businessObject.dataInputAssociations?.length > 0) {
        return true;
      }
    }
    
    // Check for other ports with sequence flows
    const elementRegistry = modeler.get('elementRegistry');
    const connections = elementRegistry.filter((el: any) => {
      if (el.type !== 'bpmn:SequenceFlow') return false;
      const bo = el.businessObject;
      return bo.sourceRef?.id === elementId || bo.targetRef?.id === elementId;
    });
    
    for (const conn of connections) {
      const bo = conn.businessObject;
      const streamName = bo.name || '';
      const parts = streamName.split(' - ').map((p: string) => p.trim());
      let sourcePortName = '';
      let targetPortName = '';
      
      if (parts.length === 2) {
        [sourcePortName, targetPortName] = parts;
      } else if (parts.length === 3) {
        [sourcePortName, , targetPortName] = parts;
      }
      
      const isSourcePort = (bo.sourceRef?.id === elementId && port.name === sourcePortName && port.direction === 'Outlet');
      const isTargetPort = (bo.targetRef?.id === elementId && port.name === targetPortName && port.direction === 'Inlet');
      
      if (isSourcePort || isTargetPort) {
        return true;
      }
    }
    
    return false;
  };

  if (!element) {
    return <div className="dexpi-properties-panel">Select an element to view properties</div>;
  }

  const elementType = element.type;
  const isDexpiElement = elementType === 'bpmn:Task' || 
                         elementType === 'bpmn:SubProcess' ||
                         elementType === 'bpmn:ServiceTask' ||
                         elementType === 'bpmn:UserTask' ||
                         elementType === 'bpmn:ScriptTask' ||
                         elementType === 'bpmn:ManualTask' ||
                         elementType === 'bpmn:BusinessRuleTask' ||
                         elementType === 'bpmn:SendTask' ||
                         elementType === 'bpmn:ReceiveTask' ||
                         elementType === 'bpmn:CallActivity' ||
                         elementType === 'bpmn:StartEvent' || 
                         elementType === 'bpmn:EndEvent' ||
                         elementType === 'bpmn:IntermediateThrowEvent' ||
                         elementType === 'bpmn:IntermediateCatchEvent';

  if (!isDexpiElement) {
    if (elementType === 'bpmn:DataObjectReference' || elementType === 'bpmn:DataObject') {
      const name = element.businessObject?.name || '';
      const isConnected = (element.incoming?.length ?? 0) > 0 || (element.outgoing?.length ?? 0) > 0;

      if (isConnected) {
        return (
          <div className="dexpi-properties-panel">
            <h3>Process Variable</h3>
            <div style={{ padding: '8px', backgroundColor: '#e8f5e9', borderRadius: '4px', fontSize: '0.85rem', color: '#2e7d32' }}>
              🔬 Exported as <code>InformationVariant</code> in the DEXPI InformationFlow.
            </div>
            {name && (
              <div className="property-group" style={{ marginTop: '12px' }}>
                <label>Variable name: <strong>{name}</strong></label>
              </div>
            )}
          </div>
        );
      }

      return (
        <div className="dexpi-properties-panel">
          <h3>Material / Simulation Data</h3>
          <div style={{ padding: '8px', backgroundColor: '#f3e5f5', borderRadius: '4px', fontSize: '0.85rem', color: '#6a1b9a' }}>
            📊 MaterialTemplate or simulation case — edit via the <strong>Materials panel</strong> in the toolbar.
          </div>
          {name && <div className="property-group" style={{ marginTop: '12px' }}><label>Name: <strong>{name}</strong></label></div>}
        </div>
      );
    }
    return <div className="dexpi-properties-panel">Element does not support DEXPI properties</div>;
  }

  return (
    <div className="dexpi-properties-panel">
      <h3>DEXPI Properties</h3>
      
      {/* Status banner */}
      {hasData && dexpiType && isKnownClass(dexpiType) && !isCustomType && (
        <div style={{ padding: '8px', backgroundColor: '#e8f5e9', borderRadius: '4px', marginBottom: '12px', fontSize: '0.85rem' }}>
          ✓ DEXPI type: <strong>{dexpiType}</strong>
        </div>
      )}
      {hasData && isCustomType && customTypeName && (
        <div style={{ padding: '8px', backgroundColor: '#fff8e1', borderRadius: '4px', marginBottom: '12px', fontSize: '0.85rem', color: '#e65100' }}>
          ⚠ Custom type — not a standard DEXPI 2.0 class
        </div>
      )}
      {hasData && !dexpiType && !isCustomType && (
        <div style={{ padding: '8px', backgroundColor: '#fff8e1', borderRadius: '4px', marginBottom: '12px', fontSize: '0.85rem', color: '#795548' }}>
          ⚠ No type selected — choose a DEXPI class or enter a custom type
        </div>
      )}
      
      <div className="property-group">
        <label>
          Element Name:
          <input 
            type="text" 
            value={elementName} 
            onChange={(e) => {
              const newName = e.target.value;
              setElementName(newName);
              const modeling = modeler.get('modeling');
              modeling.updateProperties(element, { name: newName });
            }}
            placeholder="Enter element name..."
          />
        </label>
      </div>

      <div className="property-group">
        <label>
          DEXPI Type:
          <select
            value={isCustomType ? '__custom__' : dexpiType}
            onChange={handleDexpiTypeChange}
          >
            <option value="">Select DEXPI type...</option>
            {(elementType === 'bpmn:Task' ||
              elementType === 'bpmn:SubProcess' ||
              elementType === 'bpmn:ServiceTask' ||
              elementType === 'bpmn:UserTask' ||
              elementType === 'bpmn:ScriptTask' ||
              elementType === 'bpmn:ManualTask' ||
              elementType === 'bpmn:BusinessRuleTask' ||
              elementType === 'bpmn:SendTask' ||
              elementType === 'bpmn:ReceiveTask' ||
              elementType === 'bpmn:CallActivity') && (
              <>
                {/* Populated from dexpi-schema-files/Process.xml + any
                    DEXPI Profiles loaded in the current session. The
                    Custom / external RDL escape hatch below is an
                    *instance-level* annotation (via customUri) that's
                    complementary to Profile-declared classes — both
                    paths remain available. */}
                {dropdownClasses.map(cls => (
                  <option key={cls} value={cls}>{cls}</option>
                ))}
                <option value="__custom__">— Custom...</option>
              </>
            )}
            {(elementType === 'bpmn:StartEvent' || elementType === 'bpmn:IntermediateCatchEvent') && (
              <option value="Source">Source</option>
            )}
            {(elementType === 'bpmn:EndEvent' || elementType === 'bpmn:IntermediateThrowEvent') && (
              <option value="Sink">Sink</option>
            )}
          </select>
        </label>
      </div>

      <div className="property-group">
        <label>
          Identifier:
          <input
            type="text"
            value={identifier}
            onChange={(e) => {
              const val = e.target.value;
              setIdentifier(val);
              updateDexpiElement({ identifier: val });
            }}
            placeholder="Human-readable identifier (e.g. R-101)"
          />
        </label>
      </div>

      {/* Custom type — shown when user selects "Custom..." */}
      {isCustomType && (
        <div className="property-group">
          <label>
            Custom class name:
            <input
              type="text"
              value={customTypeName}
              onChange={handleCustomTypeChange}
              placeholder="e.g. ElectrolyticReduction, MyReactor..."
              autoFocus
            />
          </label>
          <label style={{ marginTop: '8px', display: 'block' }}>
            Supertype (parent DEXPI class) <span style={{ color: '#c0392b' }}>*</span>:
            <select
              value={customSuperType}
              onChange={(e) => {
                const val = e.target.value;
                setCustomSuperType(val);
                updateDexpiElement({ customSuperType: val || undefined });
              }}
              aria-required="true"
              aria-invalid={!customSuperType}
              style={!customSuperType ? { borderColor: '#c0392b', outline: '1px solid #f5c6cb' } : undefined}
            >
              <option value="">Select parent class...</option>
              {dropdownClasses.map(cls => (
                <option key={cls} value={cls}>{cls}</option>
              ))}
            </select>
          </label>
          {!customSuperType && (
            <div style={{ fontSize: '0.78rem', color: '#c0392b', marginTop: '3px', fontWeight: 600 }}>
              Required for custom classes. Without a supertype the export falls back to
              generic <code>ProcessStep</code> and the custom class name is lost on reload.
            </div>
          )}
          <div style={{ fontSize: '0.78rem', color: '#555', marginTop: '3px' }}>
            Pick the closest DEXPI class your custom class extends. The Profile generator
            emits <code>&lt;ConcreteClass name="{customTypeName || '...'}" superTypes="..."/&gt;</code>
            with this supertype; loading the generated Profile makes the class known to the
            registry on subsequent transforms.
          </div>
          <label style={{ marginTop: '8px', display: 'block' }}>
            Reference URI (optional):
            <input
              type="text"
              value={customUri}
              onChange={(e) => {
                const val = e.target.value;
                setCustomUri(val);
                updateDexpiElement({ customUri: val });
              }}
              placeholder="e.g. https://data.15926.org/rdl/R1234"
              style={{ fontFamily: 'monospace', fontSize: '0.88em' }}
            />
          </label>
          <div style={{ fontSize: '0.78rem', color: '#555', marginTop: '3px' }}>
            URI referencing the class in an external RDL (ISO 15926, OntoCAPE, company RDL).
            Stored as <code>ReferenceUri</code> in the DEXPI output.
          </div>
        </div>
      )}

      {/* Process Step specific properties */}
      {(dexpiType === 'ProcessStep' || elementType === 'bpmn:Task' || elementType === 'bpmn:SubProcess') && (
        <div className="property-group">
          <label>
            Hierarchy Level:
            <select 
              value={element.businessObject.extensionElements?.values?.find((e: any) => 
                e.$type === 'dexpi:Element' || e.$type === 'dexpi:element'
              )?.hierarchyLevel || ''} 
              onChange={(e) => {
                const modeling = modeler.get('modeling');
                const moddle = modeler.get('moddle');
                const businessObject = element.businessObject;
                
                if (!businessObject.extensionElements) {
                  // eslint-disable-next-line react-hooks/immutability
                  businessObject.extensionElements = moddle.create('bpmn:ExtensionElements');
                }
                if (!businessObject.extensionElements.values) {
                  // eslint-disable-next-line react-hooks/immutability
                  businessObject.extensionElements.values = [];
                }
                
                let dexpiElement = businessObject.extensionElements.values.find(
                  (el: any) => el.$type === 'dexpi:Element' || el.$type === 'dexpi:element'
                );
                
                if (!dexpiElement) {
                  dexpiElement = moddle.create('dexpi:Element');
                  businessObject.extensionElements.values.push(dexpiElement);
                }
                
                dexpiElement.hierarchyLevel = e.target.value;
                modeling.updateProperties(element, {
                  extensionElements: businessObject.extensionElements
                });
              }}
            >
              <option value="">-- Select Hierarchy Level --</option>
              {DexpiEnumerations.ProcessStepHierarchyLevel.map(level => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Advanced — internal-serialization fields users rarely need to edit.
          UID is the XML id attribute used as a cross-reference target (other
          elements point to this object via <References objects="#X"/>);
          changing it after the fact can break references in saved files. */}
      <details className="property-group" style={{ marginTop: '0.5em' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.9em' }}>
          Advanced
        </summary>
        <div style={{ marginTop: '0.5em' }}>
          <label>
            UID:
            <input
              type="text"
              value={uid}
              onChange={handleUidChange}
              placeholder="Enter unique ID..."
            />
          </label>
          <div style={{ fontSize: '0.78rem', color: '#555', marginTop: '3px' }}>
            Internal cross-reference id used in the DEXPI XML serialization
            (the <code>id="..."</code> attribute on the emitted{' '}
            <code>&lt;Object&gt;</code>). Stable; only edit if you need a
            specific id for compatibility with another tool.
          </div>
        </div>
      </details>

      <div className="property-group">
        <h4>Ports ({ports.length})</h4>
        <button onClick={addPort} className="btn-add-port">Add Port</button>
        
        {ports.map((port) => (
          <div key={port.portId} className="port-item">
            <div className="port-header">
              <strong>{port.name}</strong>
              {isPortConnected(port) && <span style={{ fontSize: '0.8em', color: '#666', marginLeft: '8px' }}>🔗 connected</span>}
              <button onClick={() => removePort(port.portId)} className="btn-remove">×</button>
            </div>
            
            <label>
              Port ID (for stream references):
              <input 
                type="text" 
                value={port.portId} 
                onChange={(e) => updatePort(port.portId, { portId: e.target.value })}
                placeholder="Unique port identifier"
                style={{ fontFamily: 'monospace', fontSize: '0.9em' }}
              />
            </label>
            
            <label>
              Name:
              <input 
                type="text" 
                value={port.name} 
                onChange={(e) => updatePort(port.portId, { name: e.target.value })}
              />
            </label>

            <label>
              Type:
              <select 
                value={port.portType} 
                onChange={(e) => updatePort(port.portId, { portType: e.target.value as any })}
              >
                <option value="MaterialPort">Material Port</option>
                <option value="ThermalEnergyPort">Thermal Energy Port</option>
                <option value="MechanicalEnergyPort">Mechanical Energy Port</option>
                <option value="ElectricalEnergyPort">Electrical Energy Port</option>
                <option value="InformationPort">Information Port</option>
              </select>
            </label>

            <label>
              Direction:
              <select 
                value={port.direction} 
                onChange={(e) => updatePort(port.portId, { direction: e.target.value as any })}
              >
                {DexpiEnumerations.PortDirection.map(dir => (
                  <option key={dir} value={dir}>{dir}</option>
                ))}
              </select>
            </label>

            {!isPortConnected(port) && (
              <>
                <label>
                  Anchor Side:
                  <select 
                    value={port.anchorSide || 'left'} 
                    onChange={(e) => updatePort(port.portId, { anchorSide: e.target.value as any })}
                  >
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                    <option value="top">Top</option>
                    <option value="bottom">Bottom</option>
                  </select>
                </label>

                <label>
                  Anchor Offset (0.0 - 1.0):
                  <input 
                    type="number" 
                    min="0" 
                    max="1" 
                    step="0.1"
                    value={port.anchorOffset || 0.5} 
                    onChange={(e) => updatePort(port.portId, { anchorOffset: parseFloat(e.target.value) })}
                  />
                </label>
              </>
            )}
            
            {/* SubReference — only for subprocess boundary ports */}
            {elementType === 'bpmn:SubProcess' && port.portType !== 'InformationPort' && (() => {
              // Collect candidate child ports: same portType, compatible direction
              // Parent Inlet → child Outlet (stream exits child, enters parent)
              // Parent Outlet → child Inlet (stream enters child, exits parent)
              const compatDir = port.direction === 'Inlet' ? 'Outlet' : 'Inlet';
              const flowEls: any[] = element.businessObject.flowElements || [];
              const candidates: { portId: string; label: string }[] = [];
              flowEls.forEach((fe: any) => {
                if (!fe.extensionElements?.values) return;
                const dexpiEl = fe.extensionElements.values.find(
                  (v: any) => v.$type === 'dexpi:Element' || v.$type === 'dexpi:element'
                );
                if (!dexpiEl) return;
                const fePorts: any[] = dexpiEl.ports || dexpiEl.$children?.filter((c: any) =>
                  (c.$type || '').toLowerCase().includes('port')) || [];
                fePorts.forEach((cp: any) => {
                  if (cp.portType !== port.portType && cp.type !== port.portType) return;
                  const cpDir = cp.direction;
                  if (cpDir !== compatDir) return;
                  const cpId = cp.portId || cp.id || '';
                  const cpName = cp.name || cp.label || cpId;
                  const parentName = fe.name || fe.id || '';
                  candidates.push({ portId: cpId, label: `${parentName} › ${cpName}` });
                });
              });
              return (
                <label>
                  Link to child port (subReference):
                  <select
                    value={port.subReference || ''}
                    onChange={(e) => {
                      const selectedChildPortId = e.target.value;
                      const modeling = modeler.get('modeling');
                      const elementRegistry = modeler.get('elementRegistry');
                      const previousChildPortId = port.subReference;

                      // Build a list of every (flowElement, port) tuple
                      // under this subprocess so we can detect existing
                      // cross-links and clean them up atomically.
                      type Tup = { fe: any; cp: any };
                      const flowEls2: any[] = element.businessObject.flowElements || [];
                      const allChildPorts: Tup[] = [];
                      flowEls2.forEach((fe: any) => {
                        if (!fe.extensionElements?.values) return;
                        const dexpiEl = fe.extensionElements.values.find(
                          (v: any) => v.$type === 'dexpi:Element' || v.$type === 'dexpi:element'
                        );
                        if (!dexpiEl) return;
                        const fePorts: any[] = dexpiEl.ports ||
                          dexpiEl.$children?.filter((c: any) =>
                            (c.$type || '').toLowerCase().includes('port')) || [];
                        fePorts.forEach((cp: any) => allChildPorts.push({ fe, cp }));
                      });

                      // Conflict detection: is the selected child port
                      // already linked to a DIFFERENT parent port? If so,
                      // confirm before overwriting; on confirm, clear the
                      // OTHER parent port's subReference so the link
                      // stays 1:1.
                      if (selectedChildPortId) {
                        const target = allChildPorts.find(
                          ({ cp }) => (cp.portId || cp.id) === selectedChildPortId
                        );
                        const existingParentRef = target?.cp.superReference;
                        if (existingParentRef && existingParentRef !== port.portId) {
                          const proceed = window.confirm(
                            `Child port "${selectedChildPortId}" is already linked to ` +
                            `parent port "${existingParentRef}". ` +
                            `Reassigning will break that link. Proceed?`
                          );
                          if (!proceed) {
                            // Force the React-controlled select to fall
                            // back to the previous value by re-setting
                            // state. updatePort below would also do this,
                            // but bailing here prevents the writes.
                            return;
                          }
                          // Clean up: find the OTHER parent port (on this
                          // same subprocess) that referenced this child
                          // and clear its subReference.
                          if (ports) {
                            const stalePeer = ports.find(
                              (p2: any) => p2.subReference === selectedChildPortId &&
                                p2.portId !== port.portId
                            );
                            if (stalePeer) {
                              updatePort(stalePeer.portId, { subReference: undefined });
                            }
                          }
                        }
                      }

                      // Write subReference on this (parent) port
                      updatePort(port.portId, { subReference: selectedChildPortId || undefined });

                      // Stale-cleanup: clear superReference on the previously-
                      // linked child port if the user changed selection or
                      // deselected.
                      if (previousChildPortId && previousChildPortId !== selectedChildPortId) {
                        const oldChild = allChildPorts.find(
                          ({ cp }) => (cp.portId || cp.id) === previousChildPortId
                        );
                        if (oldChild?.cp.superReference === port.portId) {
                          oldChild.cp.superReference = undefined;
                          const oldChildShape = elementRegistry.get(oldChild.fe.id);
                          if (oldChildShape) {
                            modeling.updateProperties(oldChildShape, {
                              extensionElements: oldChild.fe.extensionElements,
                            });
                          }
                        }
                      }

                      // Write superReference on the selected child port
                      if (selectedChildPortId) {
                        const target = allChildPorts.find(
                          ({ cp }) => (cp.portId || cp.id) === selectedChildPortId
                        );
                        if (target) {
                          target.cp.superReference = port.portId;
                          const targetShape = elementRegistry.get(target.fe.id);
                          if (targetShape) {
                            modeling.updateProperties(targetShape, {
                              extensionElements: target.fe.extensionElements,
                            });
                          }
                        }
                      }
                    }}
                    style={{ fontSize: '0.85em' }}
                  >
                    <option value="">— None (no formal link) —</option>
                    {candidates.map(c => (
                      <option key={c.portId} value={c.portId}>{c.label}</option>
                    ))}
                  </select>
                  {port.subReference && (
                    <span style={{ fontSize: '0.8em', color: '#4a7c4e', marginTop: '2px', display: 'block' }}>
                      ✓ Linked → {port.subReference}
                    </span>
                  )}
                </label>
              );
            })()}

            {/* SuperReference — editable from the child side. Symmetric
                with the SubReference editor on the parent SubProcess: a
                user can establish or change the parent ↔ child boundary
                link from either direction. Both writes (superReference
                on this child port + subReference on the parent boundary
                port) happen atomically here, mirroring the parent-side
                editor. Shown only when this element has a SubProcess
                parent (top-level steps have no boundary to link to). */}
            {port.portType !== 'InformationPort' && (() => {
              const parentBO = element.businessObject?.$parent;
              if (!parentBO) return null;
              const parentType = parentBO.$type || '';
              if (parentType !== 'bpmn:SubProcess') return null;

              // Mirror of the SubReference direction rule from the parent
              // side: child Outlet ↔ parent Inlet, child Inlet ↔ parent
              // Outlet (the same stream entering / exiting the subprocess
              // boundary).
              const compatDir = port.direction === 'Inlet' ? 'Outlet' : 'Inlet';
              const parentExt = parentBO.extensionElements?.values || [];
              const parentDexpiEl = parentExt.find(
                (v: any) => v.$type === 'dexpi:Element' || v.$type === 'dexpi:element'
              );
              if (!parentDexpiEl) return null;
              const parentPorts: any[] = parentDexpiEl.ports ||
                parentDexpiEl.$children?.filter((c: any) =>
                  (c.$type || '').toLowerCase().includes('port')) || [];
              const candidates: { portId: string; label: string }[] = [];
              parentPorts.forEach((pp: any) => {
                if (pp.portType !== port.portType && pp.type !== port.portType) return;
                if (pp.direction !== compatDir) return;
                const ppId = pp.portId || pp.id || '';
                const ppName = pp.name || pp.label || ppId;
                const parentName = parentBO.name || parentBO.id || '';
                candidates.push({ portId: ppId, label: `${parentName} › ${ppName}` });
              });
              if (candidates.length === 0) return null;

              return (
                <label style={{ marginTop: '4px', display: 'block' }}>
                  Link to parent port (superReference):
                  <select
                    value={(port as any).superReference || ''}
                    onChange={(e) => {
                      const selectedParentPortId = e.target.value;
                      const modeling = modeler.get('modeling');
                      const previousParentPortId = (port as any).superReference;

                      // Conflict detection: is the selected parent port
                      // already linked (subReference) to a DIFFERENT child
                      // port? If so, confirm before overwriting. On
                      // confirm, the previously-linked child's
                      // superReference will be cleared below as part of
                      // the parentPorts pass so the link stays 1:1.
                      if (selectedParentPortId) {
                        const target = parentPorts.find((pp: any) =>
                          (pp.portId || pp.id) === selectedParentPortId
                        );
                        const existingChildRef = target?.subReference;
                        if (existingChildRef && existingChildRef !== port.portId) {
                          const proceed = window.confirm(
                            `Parent port "${selectedParentPortId}" is already linked to ` +
                            `child port "${existingChildRef}". ` +
                            `Reassigning will break that link. Proceed?`
                          );
                          if (!proceed) return;
                          // Clear superReference on the previously-linked
                          // child port (look it up among siblings of this
                          // child element). Walks the same flowElements
                          // list the parent SubProcess sees.
                          const flowEls: any[] = parentBO.flowElements || [];
                          flowEls.forEach((fe: any) => {
                            if (!fe.extensionElements?.values) return;
                            const dexpiEl = fe.extensionElements.values.find(
                              (v: any) => v.$type === 'dexpi:Element' || v.$type === 'dexpi:element'
                            );
                            if (!dexpiEl) return;
                            const fePorts: any[] = dexpiEl.ports ||
                              dexpiEl.$children?.filter((c: any) =>
                                (c.$type || '').toLowerCase().includes('port')) || [];
                            const stalePeer = fePorts.find((cp: any) =>
                              (cp.portId || cp.id) === existingChildRef
                            );
                            if (stalePeer && stalePeer.superReference === selectedParentPortId) {
                              stalePeer.superReference = undefined;
                              const peerShape = modeler.get('elementRegistry').get(fe.id);
                              if (peerShape) {
                                modeling.updateProperties(peerShape, {
                                  extensionElements: fe.extensionElements,
                                });
                              }
                            }
                          });
                        }
                      }

                      // Write superReference on this (child) port.
                      updatePort(port.portId, {
                        superReference: selectedParentPortId || undefined,
                      } as any);

                      // Write subReference on the selected parent boundary
                      // port, and clear it on the previously-linked parent
                      // port (if any) so the link stays 1:1 in both
                      // directions. Mirrors the parent-side editor's
                      // semantics.
                      let parentTouched = false;
                      parentPorts.forEach((pp: any) => {
                        const ppId = pp.portId || pp.id;
                        if (ppId === previousParentPortId &&
                            previousParentPortId !== selectedParentPortId) {
                          if (pp.subReference === port.portId) {
                            pp.subReference = undefined;
                            parentTouched = true;
                          }
                        }
                        if (selectedParentPortId && ppId === selectedParentPortId) {
                          pp.subReference = port.portId;
                          parentTouched = true;
                        }
                      });
                      if (parentTouched) {
                        const parentShape = modeler.get('elementRegistry').get(parentBO.id);
                        if (parentShape) {
                          modeling.updateProperties(parentShape, {
                            extensionElements: parentBO.extensionElements,
                          });
                        }
                      }
                    }}
                    style={{ fontSize: '0.85em' }}
                  >
                    <option value="">— None (no formal link) —</option>
                    {candidates.map(c => (
                      <option key={c.portId} value={c.portId}>{c.label}</option>
                    ))}
                  </select>
                  {(port as any).superReference && (
                    <span style={{
                      fontSize: '0.8em', color: '#4a7c4e',
                      marginTop: '2px', display: 'block',
                    }}>
                      ✓ Bound to parent → {(port as any).superReference}
                    </span>
                  )}
                </label>
              );
            })()}

            {isPortConnected(port) && (
              <div style={{ fontSize: '0.85em', color: '#666', fontStyle: 'italic', marginTop: '8px' }}>
                Position automatically determined by connection
              </div>
            )}

            {/* Port-level DEXPI attribute editor — collapsed by default.
                Same canonical-carrier persistence the ProcessStep + Stream
                attribute editors use; the wrapping class for schema-driven
                kind dispatch is the port's portType (MaterialPort,
                ThermalEnergyPort, …) so PersistentIdentifiers / Identifier
                / Label / MaterialTemplateReference are all reachable. */}
            <PortAttributesSection
              port={port}
              modeler={modeler}
              registry={augmentedRegistry}
              onPortChange={(updates) => updatePort(port.portId, updates as any)}
            />
          </div>
        ))}
      </div>

      {/* ProcessStep Attributes Section */}
      {(elementType === 'bpmn:Task' || 
        elementType === 'bpmn:SubProcess' ||
        elementType === 'bpmn:ServiceTask' ||
        elementType === 'bpmn:UserTask' ||
        elementType === 'bpmn:ScriptTask' ||
        elementType === 'bpmn:ManualTask' ||
        elementType === 'bpmn:BusinessRuleTask' ||
        elementType === 'bpmn:SendTask' ||
        elementType === 'bpmn:ReceiveTask' ||
        elementType === 'bpmn:CallActivity') && (
        <ProcessStepAttributesSection
          element={element}
          modeler={modeler}
          registry={augmentedRegistry}
          className={dexpiType || 'ProcessStep'}
        />
      )}
    </div>
  );
};

// ProcessStep Attributes Component
const ProcessStepAttributesSection: React.FC<{
  element: any;
  modeler: any;
  registry: DexpiProcessClassRegistry | null;
  className: string;
}> = ({ element, modeler, registry, className }) => {
  const [attributes, setAttributes] = React.useState<any[]>([]);

  React.useEffect(() => {
    if (element) {
      const businessObject = element.businessObject;
      const extensionElements = businessObject.extensionElements;

      if (extensionElements?.values) {
        const dexpiElement = extensionElements.values.find(
          (e: any) => e.$type === 'dexpi:Element'
        );

        if (dexpiElement) {
          // Canonical-carrier read; legacy <dexpi:attribute> slot was removed
          // from the moddle descriptor and is no longer supported.
          setAttributes(readAttributesFromDexpiElement(dexpiElement));
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element]);

  // Auto-create empty placeholder attributes for DEXPI/Profile-required
  // properties the transformer doesn't fill in itself (e.g.
  // Compressing.Method). Persisted as real attributes with empty value so
  // they survive reload; the transformer's existing
  // `if (!attr.name || !attr.value) return` skip means they don't pollute
  // the DEXPI XML until the user types a value, while the cardinality
  // validator continues to flag them as missing — preserving the
  // validate→author→close-the-loop story.
  //
  // Depend on `attributes` so this runs *after* the load useEffect
  // populates state from BPMN; otherwise we'd race load and overwrite
  // BPMN with just placeholders. The set-difference + early-exit guard
  // makes the post-add re-run a no-op, so no infinite loop.
  React.useEffect(() => {
    if (!registry || !element) return;
    const present = new Set(attributes.map((a: any) => a?.name).filter(Boolean));
    const needed = computeRequiredPlaceholderProps(registry, className).filter(p => !present.has(p));
    if (needed.length === 0) return;
    const placeholders = needed.map(propName => ({
      name: propName,
      value: '',
      required: true,
    }));
    const updated = [...attributes, ...placeholders];
    setAttributes(updated);
    updateElementAttributes(updated);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attributes, className, registry, element]);

  const addAttribute = () => {
    const newAttr = {
      name: `Attribute ${attributes.length + 1}`,
      value: '',
      unit: '',
      scope: 'Design',
      range: 'Nominal',
      provenance: 'Calculated',
    };

    const updatedAttrs = [...attributes, newAttr];
    setAttributes(updatedAttrs);
    updateElementAttributes(updatedAttrs);
  };

  const removeAttribute = (index: number) => {
    const updatedAttrs = attributes.filter((_, i) => i !== index);
    setAttributes(updatedAttrs);
    updateElementAttributes(updatedAttrs);
  };

  const updateAttribute = (index: number, updates: any) => {
    const updatedAttrs = attributes.map((attr, i) => {
      if (i === index) {
        return {
          name: updates.name !== undefined ? updates.name : attr.name,
          value: updates.value !== undefined ? updates.value : attr.value,
          unit: updates.unit !== undefined ? updates.unit : attr.unit,
          // nameUri / unitUri: project-extension authoring metadata. The
          // transformer routes these to canonical DEXPI 2.0 destinations
          // (nameUri → QuantityKindReference; unitUri → UnitReference on
          // the wrapping QualifiedValue). Always preserved through edits
          // so the step panel matches the stream panel's URI surface.
          nameUri: updates.nameUri !== undefined ? updates.nameUri : attr.nameUri,
          unitUri: updates.unitUri !== undefined ? updates.unitUri : attr.unitUri,
          scope: updates.scope !== undefined ? updates.scope : attr.scope,
          range: updates.range !== undefined ? updates.range : attr.range,
          provenance: updates.provenance !== undefined ? updates.provenance : attr.provenance,
          required: 'required' in updates ? updates.required : attr.required,
        };
      }
      return attr;
    });
    setAttributes(updatedAttrs);
    updateElementAttributes(updatedAttrs);
  };

  const updateElementAttributes = (updatedAttrs: any[]) => {
    const modeling = modeler.get('modeling');
    const moddle = modeler.get('moddle');
    const businessObject = element.businessObject;

    let extensionElements = businessObject.extensionElements;
    if (!extensionElements) {
      extensionElements = moddle.create('bpmn:ExtensionElements');
    }

    let dexpiElement = extensionElements.values?.find(
      (e: any) => e.$type === 'dexpi:Element'
    );

    if (!dexpiElement) {
      dexpiElement = moddle.create('dexpi:Element');
      if (!extensionElements.values) {
        // eslint-disable-next-line react-hooks/immutability
        extensionElements.values = [];
      }
      extensionElements.values.push(dexpiElement);
    }

    // Canonical-carrier write: dispatch each attribute to either a flat
    // <dexpi:data> carrier or a QualifiedValue-shaped <dexpi:components>
    // carrier based on the registry's declared kind for the property name
    // on the wrapping class. The legacy <dexpi:attribute> slot was removed
    // from the moddle descriptor; nothing reads it, nothing writes it.
    const { data, components } = attrsToCanonicalCarriers(updatedAttrs, moddle, registry, className);
    dexpiElement.data = data;
    dexpiElement.components = components;

    modeling.updateProperties(element, {
      extensionElements
    });
  };

  return (
    <div className="property-group">
      <h4>Attributes ({attributes.length})</h4>
      <button onClick={addAttribute} className="btn-add-port">Add Attribute</button>
      
      {attributes.map((attr, index) => (
        <div key={index} className="port-item">
          <div className="port-header">
            <strong>{attr.name}</strong>
            <button onClick={() => removeAttribute(index)} className="btn-remove">×</button>
          </div>
          
          <AttributeNameValueRow
            attr={attr}
            registry={registry}
            className={className}
            onChange={(updates) => updateAttribute(index, updates)}
            betweenNameAndValue={
              <label>
                Attribute URI:
                <input
                  type="text"
                  value={attr.nameUri || ''}
                  onChange={(e) => updateAttribute(index, { nameUri: e.target.value })}
                  placeholder="e.g. https://qudt.org/vocab/quantitykind/MassFlowRate"
                  style={{ fontFamily: 'monospace', fontSize: '0.85em' }}
                />
              </label>
            }
          />

          <label>
            Unit:
            <input
              type="text"
              value={attr.unit || ''}
              onChange={(e) => updateAttribute(index, { unit: e.target.value })}
              placeholder="e.g., kg/h, °C, bar"
            />
          </label>

          <label>
            Unit URI:
            <input
              type="text"
              value={attr.unitUri || ''}
              onChange={(e) => updateAttribute(index, { unitUri: e.target.value })}
              placeholder="e.g. https://qudt.org/vocab/unit/KiloGM-PER-HR"
              style={{ fontFamily: 'monospace', fontSize: '0.85em' }}
            />
          </label>

          <label>
            Scope:
            <select
              value={attr.scope || ''}
              onChange={(e) => updateAttribute(index, { scope: e.target.value })}
            >
              <option value="">-- Select Scope --</option>
              {DexpiEnumerations.Scope.map(scope => (
                <option key={scope} value={scope}>{scope}</option>
              ))}
            </select>
          </label>

          <label>
            Range:
            <select 
              value={attr.range || ''}
              onChange={(e) => updateAttribute(index, { range: e.target.value })}
            >
              <option value="">-- Select Range --</option>
              {DexpiEnumerations.Range.map(range => (
                <option key={range} value={range}>{range}</option>
              ))}
            </select>
          </label>

          <label>
            Provenance:
            <select
              value={attr.provenance || ''}
              onChange={(e) => updateAttribute(index, { provenance: e.target.value })}
            >
              <option value="">-- Select Provenance --</option>
              {DexpiEnumerations.Provenance.map(prov => (
                <option key={prov} value={prov}>{prov}</option>
              ))}
            </select>
          </label>

          {(() => {
            // Lock the box when the property is already required (lower>=1)
            // by DEXPI or a loaded Profile — Profiles narrow but never
            // loosen, so the user cannot un-require it via this UI.
            const lock = attr.name && registry
              ? lookupRequiredSource(registry, className, attr.name)
              : null;
            const lockedOn = lock !== null;
            return (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                  <input
                    type="checkbox"
                    checked={lockedOn ? true : !!attr.required}
                    disabled={lockedOn}
                    onChange={(e) => updateAttribute(index, { required: e.target.checked || undefined })}
                  />
                  <span style={lockedOn ? { color: '#555' } : undefined}>
                    Required in generated Profile
                  </span>
                </label>
                {lockedOn && (
                  <div style={{ fontSize: '0.75rem', color: '#555', marginTop: '2px', marginLeft: '22px' }}>
                    {lock!.source === 'dexpi'
                      ? `Required by DEXPI (${lock!.sourceName}) — Profiles narrow but never loosen, so this cannot be unset.`
                      : `Required by loaded Profile "${lock!.sourceName}" — to override, regenerate without that Profile loaded.`}
                  </div>
                )}
                {!lockedOn && attr.required && (
                  <div style={{ fontSize: '0.75rem', color: '#555', marginTop: '2px', marginLeft: '22px' }}>
                    The Profile generator will narrow this property's lower bound to 1
                    for the wrapping class. DEXPI's lower=0 default is overridden — on
                    reload, the loaded Profile takes precedence.
                  </div>
                )}
              </>
            );
          })()}
        </div>
      ))}
    </div>
  );
};

/**
 * Per-port attribute editor — collapses by default to keep the port row
 * compact, expands to a full attribute table on demand. Reuses the same
 * canonical-carrier persistence path the ProcessStep + Stream attribute
 * editors use (`attrsToCanonicalCarriers` + `readAttributesFromDexpiElement`),
 * so attributes authored here flow through identical schema-driven kind
 * dispatch and identical BPMN-storage shape.
 *
 * Wrapping class for the schema-lookup is `port.portType` — the registry
 * knows MaterialPort, ThermalEnergyPort, etc., and walks supertypes up
 * through `Port` → `Core/ConceptualObject`, so PersistentIdentifiers and
 * the rest are visible. Saved through `onPortChange({ data, components })`,
 * which the parent forwards to `updatePort` to persist.
 */
const PortAttributesSection: React.FC<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  port: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modeler: any;
  registry: DexpiProcessClassRegistry | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onPortChange: (updates: { data?: any[]; components?: any[] }) => void;
}> = ({ port, modeler, registry, onPortChange }) => {
  const [expanded, setExpanded] = React.useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [attributes, setAttributes] = React.useState<any[]>([]);
  const className = port?.portType || 'Port';

  React.useEffect(() => {
    if (!port) return;
    setAttributes(readAttributesFromDexpiElement(port));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const persist = (next: any[]) => {
    setAttributes(next);
    const moddle = modeler.get('moddle');
    const { data, components } = attrsToCanonicalCarriers(next, moddle, registry, className);
    onPortChange({ data, components });
  };

  const addAttribute = () => {
    const newAttr = {
      name: `Attribute ${attributes.length + 1}`,
      value: '',
      unit: '',
      scope: 'Design',
      range: 'Nominal',
      provenance: 'Calculated',
    };
    persist([...attributes, newAttr]);
  };

  const removeAttribute = (index: number) => {
    persist(attributes.filter((_, i) => i !== index));
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateAttribute = (index: number, updates: any) => {
    const next = attributes.map((attr, i) => {
      if (i !== index) return attr;
      return {
        name: updates.name !== undefined ? updates.name : attr.name,
        value: updates.value !== undefined ? updates.value : attr.value,
        unit: updates.unit !== undefined ? updates.unit : attr.unit,
        nameUri: updates.nameUri !== undefined ? updates.nameUri : attr.nameUri,
        unitUri: updates.unitUri !== undefined ? updates.unitUri : attr.unitUri,
        scope: updates.scope !== undefined ? updates.scope : attr.scope,
        range: updates.range !== undefined ? updates.range : attr.range,
        provenance: updates.provenance !== undefined ? updates.provenance : attr.provenance,
        required: 'required' in updates ? updates.required : attr.required,
      };
    });
    persist(next);
  };

  return (
    <div style={{ marginTop: '0.5em', padding: '0.4em 0.5em', background: '#fafafa', borderRadius: '3px', fontSize: '0.9em' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '0', color: '#555' }}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▾' : '▸'} Attributes ({attributes.length})
        </button>
        {expanded && (
          <button
            type="button"
            onClick={addAttribute}
            style={{ marginLeft: 'auto', cursor: 'pointer' }}
          >
            + Add Attribute
          </button>
        )}
      </div>
      {expanded && attributes.map((attr, index) => (
        <div key={index} style={{ marginTop: '0.4em', padding: '0.4em', border: '1px solid #ddd', borderRadius: '3px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <strong style={{ fontSize: '0.9em' }}>{attr.name || '(unnamed)'}</strong>
            <button
              type="button"
              onClick={() => removeAttribute(index)}
              style={{ marginLeft: 'auto', cursor: 'pointer', color: '#a44' }}
              title="Remove attribute"
            >
              ✕
            </button>
          </div>
          <AttributeNameValueRow
            attr={attr}
            registry={registry}
            className={className}
            onChange={(updates) => updateAttribute(index, updates)}
          />
        </div>
      ))}
    </div>
  );
};

// Helper function to find a port by name on an element
function findPortByName(element: any, portName: string): any {
  if (!element || !portName) {
    return null;
  }
  
  const extensionElements = element.extensionElements;
  if (!extensionElements || !extensionElements.values) {
    return null;
  }
  
  // Look for dexpi:Element
  const dexpiElement = extensionElements.values.find(
    (e: any) => e.$type === 'dexpi:Element'
  );
  
  if (dexpiElement && dexpiElement.ports) {
    const port = dexpiElement.ports.find((p: any) => p.name === portName);
    if (port) {
      return port;
    }
  }
  
  // Look for legacy <ports> container
  const portsContainer = extensionElements.values.find(
    (e: any) => {
      const type = (e.$type || '').toLowerCase();
      return type === 'ports' || type.includes('ports') || e.port !== undefined;
    }
  );
  
  if (portsContainer) {
    let ports = [];
    
    if (Array.isArray(portsContainer.port)) {
      ports = portsContainer.port;
    } else if (portsContainer.port) {
      ports = [portsContainer.port];
    } else if (portsContainer.$children) {
      ports = portsContainer.$children;
    }
    
    const port = ports.find((p: any) => 
      p.name === portName || p.label === portName
    );
    if (port) {
      return port;
    }
  }
  
  return null;
}

interface StreamPropertiesPanelProps {
  element: any;
  modeler: any;
  /** Same prop as on DexpiPropertiesPanel — used to build the augmented
   *  registry that locks the required-flag checkbox when an attribute is
   *  already DEXPI/Profile-required. */
  loadedProfiles?: { name: string; xml: string }[];
}

export const StreamPropertiesPanel: React.FC<StreamPropertiesPanelProps> = ({ element, modeler, loadedProfiles }) => {
  // Augmented registry for required-flag lookup. Cheap to build (parse cost
  // is shared with the step panel's own useMemo since results are cached
  // per profile-list reference identity).
  const augmentedRegistry = React.useMemo<DexpiProcessClassRegistry | null>(() => {
    try {
      return DexpiProcessClassRegistry.fromXmlSources([
        { name: 'Process.xml', xml: processXmlRaw },
        { name: 'Core.xml',    xml: coreXmlRaw },
        ...(loadedProfiles ?? []),
      ], { strictSupertypes: false });
    } catch {
      return null;
    }
  }, [loadedProfiles]);
  // Resolve the wrapping DEXPI class for the current stream from its
  // streamType discriminator. Memoised on the BPMN element + extension
  // changes — the dependency on element is enough since a streamType edit
  // produces a new businessObject on the React side.
  const streamClassName = React.useMemo<string>(() => {
    const ext = element?.businessObject?.extensionElements?.values ?? [];
    const stream = ext.find((e: any) => {
      const t = (e.$type || '').toLowerCase();
      return t === 'dexpi:stream' || t === 'stream';
    });
    return streamTypeToDexpiClassName(stream?.streamType);
  }, [element]);
  const [streamData, setStreamData] = React.useState<Partial<DexpiStream>>({});
  const [streamName, setStreamName] = React.useState<string>('');
  const [attributes, setAttributes] = React.useState<any[]>([]);
  const [hasData, setHasData] = React.useState<boolean>(false);
  const [materialState, setMaterialState] = React.useState<any>(null);
  const [materialTemplate, setMaterialTemplate] = React.useState<any>(null);
  const [allMaterialStates, setAllMaterialStates] = React.useState<any[]>([]);
  const [currentStateUidRef, setCurrentStateUidRef] = React.useState<string>('');
  // uid → moddle element index across all DataObject extension entries.
  // Used to follow Process.xml-aligned MaterialState → MaterialStateType →
  // Composition reference chains: the state has a State ref whose uidRef
  // points at a MaterialStateType, which has a Composition ref to a
  // Composition object, which carries the actual Flow / Fractions data.
  const [extensionByUid, setExtensionByUid] = React.useState<Map<string, any>>(new Map());

  /**
   * Read a DataProperty's body text from a moddle DEXPI parent. Prefers
   * the typed `data` array bpmn-moddle exposes for carrier-form parents
   * (<dexpi:data property="X">v</dexpi:data>); falls back to walking
   * $children for legacy bare-name <X>v</X> children. Returns 'N/A' if
   * the property isn't found — keeps the panel renders defensively
   * non-undefined.
   */
  const readDexpiData = React.useCallback((parent: any, propertyName: string): string => {
    if (!parent) return 'N/A';
    if (Array.isArray(parent.data)) {
      for (const d of parent.data) {
        const prop = d.property ?? d.$attrs?.property;
        if (prop === propertyName) {
          const body = d.body ?? d.$body ?? d._ ?? '';
          if (body) return body;
        }
      }
    }
    if (parent.$children) {
      for (const c of parent.$children) {
        const t = (c.$type || '').toLowerCase();
        if ((t === 'dexpi:data' || t === 'data') &&
            (c.property === propertyName || c.$attrs?.property === propertyName)) {
          const body = c.body ?? c.$body ?? c._ ?? '';
          if (body) return body;
        }
      }
      const bare = parent.$children.find((c: any) => c.$type === propertyName);
      if (bare?.$body) return bare.$body;
    }
    return 'N/A';
  }, []);

  React.useEffect(() => {
    // Load all material states for dropdown
    const elementRegistry = modeler.get('elementRegistry');
    const allElements = elementRegistry.getAll();
    const stateDataObjs = allElements.filter((el: any) => 
      el.type === 'bpmn:DataObjectReference' && 
      (el.businessObject.name?.includes('MaterialStates') || el.businessObject.name === 'MaterialStates')
    );
    
    const states: any[] = [];
    // Cross-reference map: every DataObject extension entry by uid, used
    // to follow MaterialState → MaterialStateType → Composition reference
    // chains at render time. Built once per panel load; the data is small
    // enough that this isn't a performance concern.
    const byUid = new Map<string, any>();
    stateDataObjs.forEach((dataObj: any) => {
      if (dataObj?.businessObject?.extensionElements?.values) {
        dataObj.businessObject.extensionElements.values.forEach((val: any) => {
          if (val.uid) byUid.set(val.uid, val);
          // Filter MaterialState entries (and *only* MaterialState, not
          // MaterialStateType) — only the actual states should appear in
          // the dropdown.
          if (val.$type === 'MaterialState' ||
              (val.$type && val.$type.includes('MaterialState') &&
               !val.$type.includes('MaterialStateType'))) {
            states.push(val);
          }
        });
      }
    });
    setAllMaterialStates(states);
    setExtensionByUid(byUid);

    if (element && element.type === 'bpmn:SequenceFlow') {
      const businessObject = element.businessObject;
      const extensionElements = businessObject.extensionElements;
      
      
      if (extensionElements && extensionElements.values) {
        extensionElements.values.forEach((_val: any, _idx: number) => {
        });
        
        // The TEP fixture (and any DEXPI-shape BPMN export) carries TWO
        // Stream-like extension elements under each sequenceFlow:
        //
        //   1. <dexpi:Stream sourcePortRef="..." targetPortRef="..."/>
        //      The port-binding marker (always present, has only the
        //      port refs as attributes; no children).
        //   2. <Stream Identifier="6" name="...">  ...rich content...
        //      The DEXPI Process-XML-shape stream attributes block: name,
        //      Identifier, MassFlow / Temperature / Pressure children,
        //      MaterialStateReference, MaterialTemplateReference, etc.
        //      Only present when the model actually carries property values.
        //
        // We need both: the rich block for attributes / state ref / template
        // ref, and the binding marker for sourcePortRef / targetPortRef. The
        // previous code did a single find() and got whichever sibling came
        // first — usually the binding marker — and never saw the rich data.
        const streamCandidates: any[] = extensionElements.values.filter(
          (e: any) => {
            const type = e.$type || '';
            return type === 'dexpi:Stream' ||
                   type === 'dexpi:stream' ||
                   type === 'Stream' ||
                   type.toLowerCase().includes('stream');
          }
        );
        // Rich content has either children or a name / Identifier attribute;
        // binding marker has only sourcePortRef / targetPortRef.
        const isRichStream = (s: any) =>
          (Array.isArray(s.$children) && s.$children.length > 0) ||
          s.name || s.Identifier;
        const richStream = streamCandidates.find(isRichStream);
        const bindingStream = streamCandidates.find(
          (s: any) => !isRichStream(s) && (s.sourcePortRef || s.targetPortRef)
        );
        // Synthesize a unified view for the downstream code: prefer rich
        // attributes when present, fall back to the binding marker for
        // port refs. If only one exists, use that.
        const dexpiStream = richStream
          ? {
              ...richStream,
              sourcePortRef: richStream.sourcePortRef ?? bindingStream?.sourcePortRef,
              targetPortRef: richStream.targetPortRef ?? bindingStream?.targetPortRef,
            }
          : bindingStream || streamCandidates[0];
        
        
        if (dexpiStream) {
          setHasData(true);
          
          // Extract basic stream properties
          const streamName = dexpiStream.name || dexpiStream.Identifier || businessObject.name || '';
          const streamId = dexpiStream.identifier || dexpiStream.Identifier || '';
          const streamType = dexpiStream.streamType || 'MaterialFlow';
          const provenance = dexpiStream.provenance || dexpiStream.Provenance || 'Calculated';
          const range = dexpiStream.range || dexpiStream.Range || 'Design';
          
          // Try to extract port references from stream name
          // Format: "SourcePort - [Stream ID] - TargetPort" or "SourcePort - TargetPort"
          // Prefer the new self-contained sourcePortId/targetPortId form over
          // the legacy suffix sourcePortRef/targetPortRef. The variable names
          // below still say "Ref" for back-compat with the rest of the panel,
          // but the value carries whichever form was found in the moddle.
          let sourcePortRef = dexpiStream.sourcePortId || dexpiStream.sourcePortRef || '';
          let targetPortRef = dexpiStream.targetPortId || dexpiStream.targetPortRef || '';
          
          const flowName = businessObject.name || '';
          
          if (flowName && !sourcePortRef && !targetPortRef) {
            // Parse the flow name to extract port names
            const parts = flowName.split(' - ').map((p: string) => p.trim());
            
            if (parts.length === 2) {
              // Format: "SourcePort - TargetPort"
              const sourcePortName = parts[0];
              const targetPortName = parts[1];
              
              
              // Find actual port IDs from source and target elements. The
              // canonical port id format is `${elementId}_${portName}_port`
              // (matching the AutoTypeBehavior creation and the format of
              // dexpi:port id attributes in the BPMN), so the fallback uses
              // that same suffix so the resolved value is a valid full id.
              if (businessObject.sourceRef) {
                const sourcePort = findPortByName(businessObject.sourceRef, sourcePortName);
                if (sourcePort) {
                  sourcePortRef = `${businessObject.sourceRef.id}_${sourcePortName}_port`;
                }
              }
              if (businessObject.targetRef) {
                const targetPort = findPortByName(businessObject.targetRef, targetPortName);
                if (targetPort) {
                  targetPortRef = `${businessObject.targetRef.id}_${targetPortName}_port`;
                }
              }
            } else if (parts.length === 3) {
              // Format: "SourcePort - Stream ID - TargetPort"
              const sourcePortName = parts[0];
              const targetPortName = parts[2];
              if (businessObject.sourceRef) {
                const sourcePort = findPortByName(businessObject.sourceRef, sourcePortName);
                if (sourcePort) {
                  sourcePortRef = `${businessObject.sourceRef.id}_${sourcePortName}_port`;
                }
              }
              if (businessObject.targetRef) {
                const targetPort = findPortByName(businessObject.targetRef, targetPortName);
                if (targetPort) {
                  targetPortRef = `${businessObject.targetRef.id}_${targetPortName}_port`;
                }
              }
            }
          }
          
          setStreamData({
            identifier: streamId,
            name: streamName,
            streamType: streamType as any,
            sourcePortRef,
            targetPortRef,
            provenance: provenance as any,
            range: range as any
          });
          setStreamName(element.businessObject.name || '');
          
          // Stream attribute reads only consult canonical carriers. The
          // legacy <dexpi:attribute> shape is no longer supported — the
          // moddle Attribute class declaration + the attributes slot on
          // Element / Stream were removed; bpmn-moddle would error on
          // parsing any old BPMN containing <dexpi:attribute> elements.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let attrs: any[] = [];

          // Carrier-wrapped CompositionProperty form (preferred):
          //   <dexpi:components property="X">
          //     <dexpi:object type="Core/QualifiedValue">
          //       <dexpi:data property="Value">v</dexpi:data>
          //       <dexpi:data property="Unit">u</dexpi:data>
          //       ...optional Provenance/Range/Scope...
          //     </dexpi:object>
          //   </dexpi:components>
          // bpmn-moddle parses these as typed arrays (Stream.components,
          // Components.objects, Object.data). We read directly from the
          // typed accessors; if for any reason the typed slots are empty
          // we fall back to the $children walk below for legacy / opaque
          // pass-through content.
          if (attrs.length === 0) {
            const carrierAttrs = (dexpiStream.components || []).map((carrier: any) => {
              const propertyName = carrier.property ?? carrier.$attrs?.property ?? 'Unknown';
              const obj = (carrier.objects || carrier.$children || []).find((o: any) =>
                (o.$type || '').toLowerCase().includes('object')
              );
              const readData = (name: string): string => {
                const dataChildren = obj?.data || obj?.$children || [];
                for (const d of dataChildren) {
                  const prop = d.property ?? d.$attrs?.property;
                  if (prop === name) return d.body ?? d.$body ?? d._ ?? '';
                }
                return '';
              };
              // nameUri — QuantityKindReference URI carrier sibling of Data
              // inside the QualifiedValue. Project-extension on Core/Qualified
              // Value, used identically by ProcessStep + MaterialComponent.
              // Round-tripped here so re-saving doesn't strip authored URIs.
              let nameUri: string | undefined;
              const refsList = obj?.references || (obj?.$children ?? []);
              for (const r of refsList) {
                const rt = (r.$type || '').toLowerCase();
                if ((rt && rt !== 'dexpi:references' && rt !== 'references') && obj?.references) continue;
                const rp = r.property ?? r.$attrs?.property;
                if (rp === 'QuantityKindReference') {
                  nameUri = r.objects ?? r.uidRef ?? r.$attrs?.objects ?? r.$attrs?.uidRef;
                  break;
                }
              }
              const unitUri = readData('UnitReference') || undefined;
              const required = carrier.required === true || carrier.$attrs?.required === 'true';
              return {
                name: propertyName,
                value: readData('Value'),
                unit: readData('Unit'),
                ...(unitUri !== undefined ? { unitUri } : {}),
                ...(nameUri !== undefined ? { nameUri } : {}),
                scope: readData('Scope') || 'Design',
                range: readData('Range') || 'Nominal',
                provenance: readData('Provenance') || 'Calculated',
                qualifier: readData('Qualifier') || 'Average',
                ...(required ? { required: true } : {}),
              };
            }).filter((a: any) => a.value);
            // Also pick up canonical flat <dexpi:data property="X">v</dexpi:data>
            // siblings — same shape ProcessStep migration introduced for
            // enum literals / plain strings on Stream-level attrs. Skip
            // structural Identifier / Label so they don't double up with
            // the dedicated emit paths in the transformer.
            const dataAttrs = (dexpiStream.data || []).map((d: any) => {
              const propertyName = d.property ?? d.$attrs?.property ?? '';
              const body = d.body ?? d.$body ?? d._ ?? '';
              if (!propertyName) return null;
              if (propertyName === 'Identifier' || propertyName === 'Label') return null;
              if (!body) return null;
              return { name: propertyName, value: String(body) };
            }).filter((a: any) => a);
            const merged = [...carrierAttrs, ...dataAttrs];
            if (merged.length > 0) attrs = merged;
          }

          // Legacy bare-name format (kept as fallback for files saved
          // before the carrier migration): <Stream><MassFlow><Value/>...
          if (attrs.length === 0 && dexpiStream.$children) {

            // Reference-shaped children (point at MaterialState / MaterialTemplate
            // by uidRef) are NOT property values; they're handled separately
            // below. The legacy folk name was TemplateReference; the canonical
            // DEXPI name is MaterialTemplateReference (per Process.xml line
            // 4387, the property on Stream is MaterialTemplateReference). We
            // accept both so older saves still round-trip.
            const REFERENCE_TYPES = new Set([
              'MaterialStateReference',
              'MaterialTemplateReference',
              'TemplateReference', // legacy folk name; back-compat
              'StreamReference',
            ]);
            attrs = dexpiStream.$children
              .filter((child: any) => !REFERENCE_TYPES.has(child.$type))
              .map((child: any) => {
                // Child is like <MassFlow>..., extract name from $type
                const attributeName = child.$type || 'Unknown';
                
                // Try to find Value and Unit children
                let value = '';
                let unit = '';
                const provenance = child.Provenance || '';
                const range = child.Range || '';
                
                if (child.$children) {
                  const valueChild = child.$children.find((c: any) => c.$type === 'Value');
                  const unitChild = child.$children.find((c: any) => c.$type === 'Unit');
                  
                  if (valueChild) {
                    value = valueChild.$body || valueChild._ || '';
                  }
                  if (unitChild) {
                    unit = unitChild.$body || unitChild._ || '';
                  }
                }
                
                // Also check direct properties (some formats might store it differently)
                if (!value && child.Value) {
                  if (typeof child.Value === 'object' && child.Value.$body) {
                    value = child.Value.$body;
                  } else {
                    value = child.Value;
                  }
                }
                if (!unit && child.Unit) {
                  if (typeof child.Unit === 'object' && child.Unit.$body) {
                    unit = child.Unit.$body;
                  } else {
                    unit = child.Unit;
                  }
                }
                
                return {
                  name: attributeName,
                  value: value,
                  unit: unit,
                  mode: range || 'Design',
                  qualifier: provenance || 'Average'
                };
              });
          }
          
          // Stream data already set above with port refs - don't overwrite!
          setAttributes(Array.isArray(attrs) ? attrs : []);
          
          // Extract MaterialStateReference and MaterialTemplateReference.
          // Prefer the typed dexpi:references array bpmn-moddle now exposes
          // (Stream.references); fall back to walking $children for legacy
          // bare-name forms <MaterialStateReference uidRef="..."/>.
          {
            const findRef = (propertyName: string): any => {
              // Typed accessor (carrier-wrapped form)
              const fromTyped = (dexpiStream.references || []).find((r: any) => {
                const prop = r.property ?? r.$attrs?.property;
                return prop === propertyName;
              });
              if (fromTyped) return fromTyped;
              // Legacy fallbacks
              if (dexpiStream.$children) {
                for (const c of dexpiStream.$children as any[]) {
                  const t = (c.$type || '').toLowerCase();
                  if ((t === 'dexpi:references' || t === 'references') &&
                      (c.property ?? c.$attrs?.property) === propertyName) {
                    return c;
                  }
                  if (c.$type === propertyName) return c;
                }
              }
              return null;
            };
            const stateRef = findRef('MaterialStateReference');
            const templateRef =
              findRef('MaterialTemplateReference') ?? findRef('TemplateReference');

            if (stateRef?.uidRef) {
              setCurrentStateUidRef(stateRef.uidRef);
              // Find the actual MaterialState from DataObjectReference elements
              const elementRegistry = modeler.get('elementRegistry');
              const allElements = elementRegistry.getAll();
              const stateDataObjs = allElements.filter((el: any) => 
                el.type === 'bpmn:DataObjectReference' && 
                (el.businessObject.name?.includes('MaterialStates') || el.businessObject.name === 'MaterialStates')
              );
              
              let foundState = null;
              for (const dataObj of stateDataObjs) {
                if (dataObj?.businessObject?.extensionElements?.values) {
                  const state = dataObj.businessObject.extensionElements.values.find((val: any) => 
                    (val.$type === 'MaterialState' || val.$type?.includes('MaterialState')) && val.uid === stateRef.uidRef
                  );
                  if (state) {
                    foundState = state;
                    // Add reference metadata if present
                    if (stateRef.Provenance || stateRef.Range) {
                      foundState._refProvenance = stateRef.Provenance;
                      foundState._refRange = stateRef.Range;
                    }
                    break;
                  }
                }
              }
              
              setMaterialState(foundState);
            } else {
              setCurrentStateUidRef('');
            }
            
            if (templateRef?.uidRef) {
              // Find the actual MaterialTemplate
              const elementRegistry = modeler.get('elementRegistry');
              const allElements = elementRegistry.getAll();
              const templateDataObj = allElements.find((el: any) => 
                el.type === 'bpmn:DataObjectReference' && 
                el.businessObject.name === 'MaterialTemplates'
              );
              
              if (templateDataObj?.businessObject?.extensionElements?.values) {
                const template = templateDataObj.businessObject.extensionElements.values.find((val: any) => 
                  (val.$type === 'MaterialTemplate' || val.$type?.includes('MaterialTemplate')) && val.uid === templateRef.uidRef
                );
                setMaterialTemplate(template);
              }
            }
          }
        } else {
          setHasData(false);
          setStreamData({});
          setAttributes([]);
          setMaterialState(null);
          setMaterialTemplate(null);
        }
      } else {
        setHasData(false);
        setStreamData({});
        setAttributes([]);
        setMaterialState(null);
        setMaterialTemplate(null);
      }
    }
  }, [element]);

  const updateStream = (updates: Partial<DexpiStream>) => {
    if (!modeler || !element) return;

    const modeling = modeler.get('modeling');
    const moddle = modeler.get('moddle');
    const businessObject = element.businessObject;

    let extensionElements = businessObject.extensionElements;
    if (!extensionElements) {
      extensionElements = moddle.create('bpmn:ExtensionElements');
    }

    let dexpiStream = extensionElements.values?.find(
      (e: any) => e.$type === 'dexpi:Stream'
    );

    if (!dexpiStream) {
      dexpiStream = moddle.create('dexpi:Stream');
      if (!extensionElements.values) {
        // eslint-disable-next-line react-hooks/immutability
        extensionElements.values = [];
      }
      extensionElements.values.push(dexpiStream);
    }

    // Intercept attribute updates and translate the panel's flat array view
    // into canonical-carrier moddle children. Same shape ProcessStep +
    // MaterialComponent emit (reused via attrsToCanonicalCarriers). The
    // reader ignores the legacy <dexpi:attribute> slot — clearing it here
    // ensures opening any old BPMN and saving produces a fully-canonical
    // file (no orphan legacy elements survive moddle round-trip).
    if ('attributes' in updates) {
      const moddle = modeler.get('moddle');
      const { data, components } = attrsToCanonicalCarriers(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (updates.attributes as any[]) ?? [],
        moddle,
        augmentedRegistry,
        streamClassName,
      );
      dexpiStream.data = data;
      dexpiStream.components = components;
      const { attributes: _drop, ...rest } = updates as Record<string, unknown>;
      Object.assign(dexpiStream, rest);
    } else {
      Object.assign(dexpiStream, updates);
    }
    setStreamData({ ...streamData, ...updates });

    modeling.updateProperties(element, {
      extensionElements
    });
  };

  // Auto-create empty placeholder attributes for required-but-not-auto-emitted
  // properties on the wrapping Stream class (e.g. InformationFlow.InformationValue).
  // Same mechanics as the step-attribute editor: empty value → transformer
  // skips emission → cardinality validator flags missing → user fills in.
  //
  // Depend on `attributes` so this runs *after* the load useEffect populates
  // state from BPMN — otherwise we'd race the load and risk overwriting
  // the BPMN's existing attributes with just placeholders. The set-
  // difference + early-exit guard makes the post-add re-run a no-op, so no
  // infinite loop.
  React.useEffect(() => {
    if (!augmentedRegistry || !element) return;
    const present = new Set(attributes.map((a: any) => a?.name).filter(Boolean));
    const needed = computeRequiredPlaceholderProps(augmentedRegistry, streamClassName)
      .filter(p => !present.has(p));
    if (needed.length === 0) return;
    const placeholders = needed.map(propName => ({
      name: propName,
      value: '',
      required: true,
    }));
    const updated = [...attributes, ...placeholders];
    setAttributes(updated);
    updateStream({ attributes: updated });
  // updateStream is closure-stable enough for this; eslint can't statically
  // verify but the captured `streamData`/`element` reference stays valid
  // for one effect tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attributes, streamClassName, augmentedRegistry, element]);

  const addAttribute = () => {
    const newAttr = {
      name: 'New Attribute',
      value: '',
      unit: '',
      scope: 'Design',
      range: 'Nominal',
      provenance: 'Calculated',
      qualifier: 'Average',
    };

    const updatedAttrs = [...attributes, newAttr];
    setAttributes(updatedAttrs);
    updateStream({ attributes: updatedAttrs });
  };

  const removeAttribute = (index: number) => {
    const updatedAttrs = attributes.filter((_, i) => i !== index);
    setAttributes(updatedAttrs);
    updateStream({ attributes: updatedAttrs });
  };

  const updateAttribute = (index: number, updates: any) => {
    const updatedAttrs = attributes.map((attr, i) => {
      if (i === index) {
        return {
          name: updates.name !== undefined ? updates.name : attr.name,
          nameUri: updates.nameUri !== undefined ? updates.nameUri : attr.nameUri,
          value: updates.value !== undefined ? updates.value : attr.value,
          unit: updates.unit !== undefined ? updates.unit : attr.unit,
          unitUri: updates.unitUri !== undefined ? updates.unitUri : attr.unitUri,
          scope: updates.scope !== undefined ? updates.scope : attr.scope,
          range: updates.range !== undefined ? updates.range : attr.range,
          provenance: updates.provenance !== undefined ? updates.provenance : attr.provenance,
          qualifier: updates.qualifier !== undefined ? updates.qualifier : attr.qualifier,
          required: 'required' in updates ? updates.required : attr.required,
        };
      }
      return attr;
    });
    setAttributes(updatedAttrs);
    updateStream({ attributes: updatedAttrs });
  };

  if (!element || (
    element.type !== 'bpmn:SequenceFlow' &&
    element.type !== 'bpmn:Association' &&
    element.type !== 'bpmn:DataOutputAssociation' &&
    element.type !== 'bpmn:DataInputAssociation'
  )) {
    return null;
  }


  return (
    <div className="stream-properties-panel">
      <h3>Stream Properties</h3>
      
      {hasData && (
        <div style={{ padding: '8px', backgroundColor: '#e8f5e9', borderRadius: '4px', marginBottom: '12px', fontSize: '0.85rem' }}>
          ✓ Stream has DEXPI data
        </div>
      )}
      
      <div className="property-group">
        <label>
          Stream Name:
          <input 
            type="text" 
            value={streamName} 
            onChange={(e) => {
              const newName = e.target.value;
              setStreamName(newName);
              const modeling = modeler.get('modeling');
              modeling.updateProperties(element, { name: newName });
            }}
          />
        </label>
      </div>

      <div className="property-group">
        <label>Stream Type:</label>
        {['bpmn:Association','bpmn:DataOutputAssociation','bpmn:DataInputAssociation'].includes(element.type) ? (
          <div style={{ padding: '6px 0', fontSize: '0.9rem', color: '#333' }}>
            Information Flow
          </div>
        ) : (
          <select
            value={streamData.streamType || 'MaterialFlow'}
            onChange={(e) => updateStream({ streamType: e.target.value as any })}
          >
            <option value="MaterialFlow">Material Flow</option>
            <option value="ThermalEnergyFlow">Thermal Energy Flow</option>
            <option value="MechanicalEnergyFlow">Mechanical Energy Flow</option>
            <option value="ElectricalEnergyFlow">Electrical Energy Flow</option>
            <option value="EnergyFlow">Energy Flow — generic</option>
          </select>
        )}
      </div>

      <div className="property-group">
        <label>
          UID:
          <input 
            type="text" 
            value={element.businessObject.id || ''} 
            readOnly
            style={{ backgroundColor: '#f5f5f5', color: '#666' }}
          />
        </label>
      </div>

      <div className="property-group">
        <label>
          Source Port Ref:
          <input
            type="text"
            value={streamData.sourcePortId || streamData.sourcePortRef || ''}
            onChange={(e) => updateStream({ sourcePortId: e.target.value, sourcePortRef: undefined })}
            placeholder="Source port ID..."
          />
        </label>
      </div>

      <div className="property-group">
        <label>
          Target Port Ref:
          <input
            type="text"
            value={streamData.targetPortId || streamData.targetPortRef || ''}
            onChange={(e) => updateStream({ targetPortId: e.target.value, targetPortRef: undefined })}
            placeholder="Target port ID..."
          />
        </label>
      </div>

      {/* Material State Information */}
      <div className="property-group" style={{ background: '#e3f2fd', padding: '12px', borderRadius: '4px', marginTop: '12px' }}>
        <h4 style={{ margin: '0 0 8px 0', color: '#1976d2' }}>📊 Material State</h4>
        <label style={{ marginBottom: '8px', display: 'block' }}>
          Select State:
          <select 
            value={currentStateUidRef} 
            onChange={(e) => {
              const newUid = e.target.value;
              const moddle = modeler.get('moddle');
              const modeling = modeler.get('modeling');
              const businessObject = element.businessObject;
              
              if (!businessObject.extensionElements) {
                // eslint-disable-next-line react-hooks/immutability
                businessObject.extensionElements = moddle.create('bpmn:ExtensionElements');
              }
              if (!businessObject.extensionElements.values) {
                // eslint-disable-next-line react-hooks/immutability
                businessObject.extensionElements.values = [];
              }
              
              let dexpiStream = businessObject.extensionElements.values.find(
                (e: any) => e.$type === 'Stream' || e.$type?.includes('Stream')
              );
              
              if (!dexpiStream) {
                dexpiStream = moddle.create('Stream');
                // eslint-disable-next-line react-hooks/immutability
                dexpiStream.$children = [];
                businessObject.extensionElements.values.push(dexpiStream);
              }
              
              if (!dexpiStream.$children) {
                // eslint-disable-next-line react-hooks/immutability
                dexpiStream.$children = [];
              }
              
              // Update or create MaterialStateReference
              let stateRef = dexpiStream.$children.find((c: any) => c.$type === 'MaterialStateReference');
              if (stateRef) {
                stateRef.uidRef = newUid;
              } else {
                stateRef = moddle.create('MaterialStateReference');
                stateRef.uidRef = newUid;
                dexpiStream.$children.push(stateRef);
              }
              
              modeling.updateProperties(element, {
                extensionElements: businessObject.extensionElements
              });
              
              setCurrentStateUidRef(newUid);
              // Trigger re-render
              const newState = allMaterialStates.find(s => s.uid === newUid);
              setMaterialState(newState || null);
            }}
            style={{ width: '100%', padding: '4px', marginTop: '4px' }}
          >
            <option value="">-- No State --</option>
            {allMaterialStates.map((state: any) => {
              const label = readDexpiData(state, 'Label');
              const identifier = readDexpiData(state, 'Identifier');
              return (
                <option key={state.uid} value={state.uid}>
                  {label} ({identifier})
                </option>
              );
            })}
          </select>
        </label>
        {materialState && (
        <div style={{ fontSize: '0.9rem' }}>
          <div><strong>Label:</strong> {readDexpiData(materialState, 'Label')}</div>
          <div><strong>Identifier:</strong> {readDexpiData(materialState, 'Identifier')}</div>
          <div><strong>UID:</strong> <code style={{ background: 'rgba(0,0,0,0.1)', padding: '2px 6px', borderRadius: '3px', fontSize: '0.85em' }}>{materialState.uid}</code></div>
            {(materialState._refProvenance || materialState._refRange) && (
              <div style={{ marginTop: '8px', padding: '6px', background: 'rgba(255,255,255,0.7)', borderRadius: '3px', fontSize: '0.85rem' }}>
                {materialState._refProvenance && <div><strong>Reference Provenance:</strong> {materialState._refProvenance}</div>}
                {materialState._refRange && <div><strong>Reference Range:</strong> {materialState._refRange}</div>}
              </div>
            )}
            {(() => {
              // Resolve the Process.xml-aligned chain at render time:
              //   MaterialState.State → MaterialStateType.Composition → Composition
              // State + Composition references are stored as carrier
              // entries (<dexpi:references property="State" uidRef="X"/>);
              // their resolved moddle objects live in extensionByUid.
              // Falls back to the legacy inline-Flow shape when carriers
              // are absent (older saved BPMN files).
              const refUid = (typeName: string) => {
                // Typed accessor first
                if (Array.isArray(materialState.references)) {
                  const r = materialState.references.find((x: any) =>
                    (x.property ?? x.$attrs?.property) === typeName
                  );
                  if (r) return r.uidRef ?? r.$attrs?.uidRef;
                }
                // $children fallback
                const ref = (materialState.$children ?? []).find((c: any) => {
                  const ll = (c.$type || '').toLowerCase();
                  return (ll === 'dexpi:references' || ll === 'references') &&
                    (c.property === typeName || c.$attrs?.property === typeName);
                });
                return ref?.uidRef ?? ref?.$attrs?.uidRef;
              };
              const stateTypeUid = refUid('State');
              const stateType = stateTypeUid ? extensionByUid.get(stateTypeUid) : null;
              let composition: any = null;
              if (stateType) {
                // Typed accessor first
                let compUid: string | undefined;
                if (Array.isArray(stateType.references)) {
                  const r = stateType.references.find((x: any) =>
                    (x.property ?? x.$attrs?.property) === 'Composition'
                  );
                  if (r) compUid = r.uidRef ?? r.$attrs?.uidRef;
                }
                // $children fallback
                if (!compUid && stateType.$children) {
                  const compRef = stateType.$children.find((c: any) => {
                    const ll = (c.$type || '').toLowerCase();
                    return (ll === 'dexpi:references' || ll === 'references') &&
                      (c.property === 'Composition' || c.$attrs?.property === 'Composition');
                  });
                  compUid = compRef?.uidRef ?? compRef?.$attrs?.uidRef;
                }
                if (compUid) composition = extensionByUid.get(compUid);
              }
              // State-level scalar MoleFlow lives on MaterialStateType
              // (Profile-extension parallel to the schema's scalar
              // MassFlow / VolumeFlow); Composition.MoleFlow is a
              // different concept (per-component vector) that TEP
              // doesn't use at the state-total level.

              // Helper: read a Components-carrier QualifiedValue for a
              // given property name ('MoleFlow', 'MoleFractiona', etc.)
              const readQualifiedValue = (parent: any, propName: string): { values: string[]; unit: string } | null => {
                if (!parent) return null;
                // Locate the Components carrier by property name. Prefer
                // typed accessor; fall back to $children walking.
                let carrier: any | null = null;
                if (Array.isArray(parent.components)) {
                  carrier = parent.components.find((c: any) =>
                    (c.property ?? c.$attrs?.property) === propName
                  ) ?? null;
                }
                if (!carrier && parent.$children) {
                  carrier = parent.$children.find((c: any) => {
                    const ll = (c.$type || '').toLowerCase();
                    return (ll === 'dexpi:components' || ll === 'components') &&
                      ((c.property ?? c.$attrs?.property) === propName);
                  }) ?? null;
                }
                if (!carrier) return null;
                // Carrier's inner Object: typed `objects` array first.
                const objList = carrier.objects ?? carrier.$children ?? [];
                const obj = objList.find((o: any) =>
                  (o.$type || '').toLowerCase().includes('object')
                );
                if (!obj) return null;
                // Object's data entries: typed `data` first, $children fallback.
                const dataList = obj.data ?? obj.$children ?? [];
                const values: string[] = [];
                let unit = '';
                for (const d of dataList) {
                  const ll = (d.$type || '').toLowerCase();
                  // Typed-data entries don't carry a $type prefix the same
                  // way pass-through ones do; allow either.
                  if (ll && ll !== 'dexpi:data' && ll !== 'data') continue;
                  const prop = d.property ?? d.$attrs?.property;
                  const body = d.body ?? d.$body ?? d._ ?? '';
                  if (prop === 'Value' || prop === 'Values') {
                    values.push(body);
                  } else if (prop === 'Unit') {
                    unit = body;
                  }
                }
                return { values, unit };
              };

              // Legacy inline-Flow fallback for fixtures saved before the
              // restructure — reuse the previous shape's reads here so
              // older BPMN files still render some Flow info.
              const flowChild = (materialState.$children ?? []).find((c: any) => c.$type === 'Flow');
              const legacyMoleFlow = flowChild?.$children?.find((c: any) => c.$type === 'MoleFlow');
              const legacyComposition = flowChild?.$children?.find((c: any) => c.$type === 'Composition');

              const moleFlow = stateType
                ? readQualifiedValue(stateType, 'MoleFlow')
                : (legacyMoleFlow ? {
                    values: [legacyMoleFlow.$children?.find((c: any) => c.$type === 'Value')?.$body || ''],
                    unit: legacyMoleFlow.$children?.find((c: any) => c.$type === 'Unit')?.$body || '',
                  } : null);

              const fractions = composition
                ? (readQualifiedValue(composition, 'MoleFractiona') ??
                   readQualifiedValue(composition, 'MassFractions') ??
                   readQualifiedValue(composition, 'VolumeFractions'))
                : null;
              const legacyFractions = legacyComposition?.$children?.filter((c: any) => c.$type === 'Fraction') ?? [];
              const fractionValues = fractions?.values ??
                legacyFractions.map((f: any) =>
                  f.$children?.find((c: any) => c.$type === 'Value')?.$body || '0');
              const readDisplay = (parent: any): string | undefined => {
                if (!parent) return undefined;
                if (Array.isArray(parent.data)) {
                  const d = parent.data.find((x: any) =>
                    (x.property ?? x.$attrs?.property) === 'Display'
                  );
                  if (d) return d.body ?? d.$body ?? d._ ?? undefined;
                }
                if (parent.$children) {
                  const d = parent.$children.find((c: any) => {
                    const ll = (c.$type || '').toLowerCase();
                    return (ll === 'dexpi:data' || ll === 'data') &&
                      ((c.property ?? c.$attrs?.property) === 'Display');
                  });
                  if (d) return d.body ?? d.$body ?? undefined;
                }
                return undefined;
              };
              const display = composition
                ? readDisplay(composition)
                : legacyComposition?.$children?.find((c: any) => c.$type === 'Display')?.$body;

              if (!moleFlow && fractionValues.length === 0) return null;

              return (
                <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #90caf9' }}>
                  <strong>Flow Properties:</strong>
                  {moleFlow && (
                    <div>• Mole Flow: {moleFlow.values[0]} {moleFlow.unit}</div>
                  )}
                  {fractionValues.length > 0 && (
                    <div style={{ marginTop: '8px' }}>
                      <strong>Composition:</strong>
                      <div style={{ marginLeft: '12px', fontSize: '0.85rem' }}>
                        {display && <div>Display: {display}</div>}
                        <div style={{ marginTop: '4px' }}>
                          <strong>Fractions:</strong>
                          {fractionValues.map((v: string, idx: number) => {
                            const value = parseFloat(v) || 0;
                            return <div key={idx}>  Component {idx + 1}: {(value * 100).toFixed(2)}%</div>;
                          })}
                          <div style={{ marginTop: '2px', fontWeight: 'bold' }}>
                            Total: {(fractionValues.reduce((sum: number, v: string) => sum + (parseFloat(v) || 0), 0) * 100).toFixed(2)}%
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Material Template Information */}
      {materialTemplate && (
        <div className="property-group" style={{ background: '#f3e5f5', padding: '12px', borderRadius: '4px', marginTop: '12px' }}>
          <h4 style={{ margin: '0 0 8px 0', color: '#7b1fa2' }}>🧪 Material Template</h4>
          <div style={{ fontSize: '0.9rem' }}>
            <div><strong>Label:</strong> {readDexpiData(materialTemplate, 'Label')}</div>
            <div><strong>Identifier:</strong> {readDexpiData(materialTemplate, 'Identifier')}</div>
            <div><strong>Components:</strong> {readDexpiData(materialTemplate, 'NumberOfMaterialComponents')}</div>
            <div><strong>Phases:</strong> {readDexpiData(materialTemplate, 'NumberOfPhases')}</div>
          </div>
        </div>
      )}

      <div className="property-group">
        <h4>Stream Attributes ({attributes.length})</h4>
        <button onClick={addAttribute} className="btn-add-port">Add Attribute</button>
        
        {attributes.map((attr, index) => (
          <div key={index} className="port-item">
            <div className="port-header">
              <strong>{attr.name}</strong>
              <button onClick={() => removeAttribute(index)} className="btn-remove">×</button>
            </div>
            
            <AttributeNameValueRow
              attr={attr}
              registry={augmentedRegistry}
              className={streamClassName}
              onChange={(updates) => updateAttribute(index, updates)}
              betweenNameAndValue={
                <label>
                  Attribute URI:
                  <input
                    type="text"
                    value={attr.nameUri || ''}
                    onChange={(e) => updateAttribute(index, { nameUri: e.target.value })}
                    placeholder="e.g. https://qudt.org/vocab/quantitykind/MassFlowRate"
                    style={{ fontFamily: 'monospace', fontSize: '0.85em' }}
                  />
                </label>
              }
            />

            <label>
              Unit:
              <input 
                type="text" 
                value={attr.unit || ''} 
                onChange={(e) => updateAttribute(index, { unit: e.target.value })}
                placeholder="e.g., kg/h, °C, bar"
              />
            </label>

            <label>
              Unit URI:
              <input
                type="text"
                value={attr.unitUri || ''}
                onChange={(e) => updateAttribute(index, { unitUri: e.target.value })}
                placeholder="e.g. https://qudt.org/vocab/unit/KiloGM-PER-HR"
                style={{ fontFamily: 'monospace', fontSize: '0.85em' }}
              />
            </label>

            <label>
              Scope:
              <select 
                value={attr.scope || ''}
                onChange={(e) => updateAttribute(index, { scope: e.target.value })}
              >
                <option value="">-- Select Scope --</option>
                {DexpiEnumerations.Scope.map(scope => (
                  <option key={scope} value={scope}>{scope}</option>
                ))}
              </select>
            </label>

            <label>
              Range:
              <select 
                value={attr.range || ''}
                onChange={(e) => updateAttribute(index, { range: e.target.value })}
              >
                <option value="">-- Select Range --</option>
                {DexpiEnumerations.Range.map(range => (
                  <option key={range} value={range}>{range}</option>
                ))}
              </select>
            </label>

            <label>
              Provenance:
              <select
                value={attr.provenance || ''}
                onChange={(e) => updateAttribute(index, { provenance: e.target.value })}
              >
                <option value="">-- Select Provenance --</option>
                {DexpiEnumerations.Provenance.map(prov => (
                  <option key={prov} value={prov}>{prov}</option>
                ))}
              </select>
            </label>

            {(() => {
              const lock = attr.name && augmentedRegistry
                ? lookupRequiredSource(augmentedRegistry, streamClassName, attr.name)
                : null;
              const lockedOn = lock !== null;
              return (
                <>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                    <input
                      type="checkbox"
                      checked={lockedOn ? true : !!attr.required}
                      disabled={lockedOn}
                      onChange={(e) => updateAttribute(index, { required: e.target.checked || undefined })}
                    />
                    <span style={lockedOn ? { color: '#555' } : undefined}>
                      Required in generated Profile
                    </span>
                  </label>
                  {lockedOn && (
                    <div style={{ fontSize: '0.75rem', color: '#555', marginTop: '2px', marginLeft: '22px' }}>
                      {lock!.source === 'dexpi'
                        ? `Required by DEXPI (${lock!.sourceName}) on ${streamClassName} — Profiles narrow but never loosen, so this cannot be unset.`
                        : `Required by loaded Profile "${lock!.sourceName}" on ${streamClassName} — to override, regenerate without that Profile loaded.`}
                    </div>
                  )}
                  {!lockedOn && attr.required && (
                    <div style={{ fontSize: '0.75rem', color: '#555', marginTop: '2px', marginLeft: '22px' }}>
                      The Profile generator will narrow this property's lower bound
                      to 1 for the Stream's class. DEXPI's lower=0 default is
                      overridden — on reload, the loaded Profile takes precedence.
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        ))}
      </div>
    </div>
  );
};
