import React, { useState, useEffect, useMemo } from 'react';
import { AttributeNameValueRow } from './DexpiPropertiesPanel';
import { DexpiProcessClassRegistry, type DexpiProperty } from '../transformer/DexpiProcessClassRegistry';
import processXmlRaw from '../../dexpi-schema-files/Process.xml?raw';
import coreXmlRaw from '../../dexpi-schema-files/Core.xml?raw';
import type { MaterialComponent, MaterialComponentProperty } from '../dexpi/moddle/materials';

// Build the registry once per module so every editor render reuses the same
// parsed Process.xml + Core.xml. Profile-extension classes (loaded into the
// session by the user) are not included here yet — the Type dropdown is
// derived from this base registry, so it covers every concrete subclass of
// MaterialComponent declared in Process.xml automatically.
const baseRegistry: DexpiProcessClassRegistry | null = (() => {
  try {
    return DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: processXmlRaw },
      { name: 'Core.xml', xml: coreXmlRaw },
    ]);
  } catch (e) {
    console.warn('Failed to build registry for MaterialEditorPanel:', e);
    return null;
  }
})();

/**
 * Properties bound to typed fields on `MaterialComponent` (identifier / label
 * / description) rather than going through the generic `properties[]`
 * array. Kept structural because the rest of the codebase (cross-references,
 * list-item display) reads them as named JS fields. Description is also
 * special-cased to a textarea below because Process.xml types it as
 * `Core/DataTypes.MultiLanguageString` rather than `Builtin/String`.
 */
const STRUCTURAL_PROPS = new Set(['Identifier', 'Label', 'Description']);

/**
 * Generic editor for a CompositionProperty whose inner Object type is **not**
 * `Core/QualifiedValue` — e.g. `PersistentIdentifiers` (inner type
 * `Core/PersistentIdentifier` with Context + Value fields). Renders one row
 * per record with one input per declared inner DataProperty.
 *
 * Inputs are introspected from the registry:
 *   - DataProperty whose `targetType` matches a registered Enumeration →
 *     `<select>` with the enum's literal values.
 *   - Otherwise → `<input type="text">`.
 *
 * The component is fully data-driven from the schema. Adding a new inner
 * class to Process.xml / a Profile XML automatically gets a working editor
 * here without code changes — same property would appear with its declared
 * field shape.
 */
interface NonQvCompositionFieldProps {
  propName: string;
  labelText: string;
  tooltip: string;
  innerClassName: string | null;
  registry: DexpiProcessClassRegistry | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  edited: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setEdited: (next: any) => void;
}
const NonQvCompositionField: React.FC<NonQvCompositionFieldProps> = ({
  propName, labelText, tooltip, innerClassName, registry, edited, setEdited,
}) => {
  // Inner class's declared DataProperties (walked through supertypes via
  // registry.getProperties). Filter to data kind only — references and
  // nested compositions inside an inner class are out of scope for this
  // editor and rare on the typed identifier-style classes that hit this
  // path. If a user authors a class with reference/composition fields, we
  // surface a TODO note in the UI rather than render incorrectly.
  const innerDeclaredProps: DexpiProperty[] = innerClassName && registry?.isValidClass(innerClassName)
    ? registry.getProperties(innerClassName).filter(p => p.kind === 'data')
    : [];

  // Pull the records array out of edited.properties[]. `prop.records` is
  // optional; treat missing as empty list.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const propEntry = (edited.properties ?? []).find((p: any) => p.name === propName && p.kind === 'composition');
  const records: Array<Record<string, string>> = propEntry?.records ?? [];

  const writeRecords = (next: Array<Record<string, string>>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = [...(edited.properties ?? [])];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idx = props.findIndex((p: any) => p.name === propName);
    // Empty cleanup: drop the entry entirely when records becomes empty,
    // matching writeDeclaredComposition's convention.
    if (next.length === 0) {
      if (idx >= 0) {
        const remaining = props.filter((_: unknown, i: number) => i !== idx);
        setEdited({ ...edited, properties: remaining.length > 0 ? remaining : undefined });
      }
      return;
    }
    if (idx >= 0) {
      props[idx] = { ...props[idx], records: next };
    } else {
      props.push({ kind: 'composition', name: propName, value: '', records: next });
    }
    setEdited({ ...edited, properties: props });
  };

  const updateRecordField = (recordIdx: number, fieldName: string, value: string) => {
    const next = records.map((r, i) => i === recordIdx ? { ...r, [fieldName]: value } : r);
    writeRecords(next);
  };
  const addRecord = () => {
    const blank: Record<string, string> = {};
    for (const p of innerDeclaredProps) blank[p.name] = '';
    writeRecords([...records, blank]);
  };
  const removeRecord = (recordIdx: number) => {
    writeRecords(records.filter((_, i) => i !== recordIdx));
  };

  return (
    <div className="form-group">
      <label title={tooltip}>{labelText}:</label>
      {innerClassName && innerDeclaredProps.length === 0 && (
        <div style={{ fontSize: '0.8em', color: '#888' }}>
          No editable DataProperties on <code>{innerClassName}</code>.
        </div>
      )}
      {records.map((record, recordIdx) => (
        <div
          key={recordIdx}
          style={{
            display: 'flex', gap: '6px', alignItems: 'flex-start',
            border: '1px solid #ddd', padding: '0.4em', borderRadius: '4px',
            marginTop: recordIdx === 0 ? 0 : '0.3em',
          }}
        >
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
            {innerDeclaredProps.map(innerProp => {
              const val = record[innerProp.name] ?? '';
              const enumLiterals = registry?.getEnumLiteralsForProperty(innerClassName ?? '', innerProp.name);
              const isEnum = enumLiterals !== null && enumLiterals !== undefined && enumLiterals.length > 0;
              const innerLabel = `${innerProp.name}${innerProp.lower >= 1 ? ' *' : ''}`;
              return (
                <label key={innerProp.name} style={{ fontSize: '0.85em', display: 'flex', flexDirection: 'column' }}>
                  <span style={{ color: '#666' }}>{innerLabel}</span>
                  {isEnum ? (
                    <select
                      value={val}
                      onChange={(e) => updateRecordField(recordIdx, innerProp.name, e.target.value)}
                    >
                      <option value=""></option>
                      {enumLiterals!.map(lit => (
                        <option key={lit} value={lit}>{lit}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={val}
                      onChange={(e) => updateRecordField(recordIdx, innerProp.name, e.target.value)}
                    />
                  )}
                </label>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => removeRecord(recordIdx)}
            style={{ flex: '0 0 auto', cursor: 'pointer' }}
            title="Remove record"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRecord}
        className="btn"
        style={{ marginTop: '0.4em', cursor: 'pointer' }}
        disabled={innerDeclaredProps.length === 0}
      >
        + Add {innerClassName ?? 'record'}
      </button>
    </div>
  );
};

/**
 * Editor for the generic list of scalar QualifiedValue properties on a
 * MaterialStateType (state.flow.scalars). No property name is special-cased;
 * the user picks one of the canonical CompositionProperty<Core/QualifiedValue>
 * names declared on MaterialStateType in Process.xml (registry-driven
 * dropdown), or types a custom name that the Profile generator will declare
 * as a CompositionProperty extension on MaterialStateType at export time.
 *
 * Same registry-driven dropdown + custom-extension pattern as the
 * DataObjectPropertiesPanel uses for instrumentation variables; both are
 * variants of "pick a canonical scalar QV property or invent one".
 */
interface ScalarPropertiesEditorProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  edited: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setEdited: (next: any) => void;
  registry: DexpiProcessClassRegistry | null;
}
const ScalarPropertiesEditor: React.FC<ScalarPropertiesEditorProps> = ({ edited, setEdited, registry }) => {
  const scalars: { property: string; value: string; unit?: string }[] =
    edited.flow?.scalars ?? [];

  // Canonical scalar QualifiedValue property names on MaterialStateType,
  // walked through the supertype chain. Filter to composition + Core/QualifiedValue.
  const canonical = registry?.isValidClass('MaterialStateType')
    ? registry.getProperties('MaterialStateType')
        .filter(p => p.kind === 'composition' &&
          (p.targetType === 'Core/QualifiedValue' || p.targetType?.endsWith('/QualifiedValue')))
        .map(p => p.name)
        .sort()
    : [];

  const writeScalars = (next: { property: string; value: string; unit?: string }[]) => {
    setEdited({
      ...edited,
      flow: { ...edited.flow, scalars: next },
    });
  };
  const updateRow = (i: number, patch: Partial<{ property: string; value: string; unit: string }>) => {
    const next = scalars.map((s, idx) => idx === i ? { ...s, ...patch } : s);
    writeScalars(next);
  };
  const addRow = () => writeScalars([...scalars, { property: '', value: '', unit: '' }]);
  const removeRow = (i: number) => writeScalars(scalars.filter((_, idx) => idx !== i));

  return (
    <div className="form-group">
      <label>Scalar properties:</label>
      {scalars.length === 0 && (
        <div style={{ fontSize: '0.8em', color: '#888' }}>
          No scalar properties authored. Click "+ Add property" to add a flow
          value (e.g. MassFlow, VolumeFlow, MoleFlow).
        </div>
      )}
      {scalars.map((s, i) => {
        const isCustom = !canonical.includes(s.property);
        return (
          <div
            key={i}
            style={{
              display: 'flex', gap: '6px', alignItems: 'flex-start',
              border: '1px solid #ddd', padding: '0.4em', borderRadius: '4px',
              marginTop: i === 0 ? 0 : '0.3em',
            }}
          >
            <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px' }}>
              <label style={{ fontSize: '0.85em', display: 'flex', flexDirection: 'column' }}>
                <span style={{ color: '#666' }}>Property</span>
                {canonical.length > 0 ? (
                  <select
                    value={isCustom && s.property ? '__custom__' : s.property}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '__custom__') {
                        updateRow(i, { property: s.property || '' });
                      } else {
                        updateRow(i, { property: v });
                      }
                    }}
                  >
                    <option value="">— choose —</option>
                    {canonical.map(p => <option key={p} value={p}>{p}</option>)}
                    <option value="__custom__">Custom (Profile-extension) …</option>
                  </select>
                ) : null}
                {(canonical.length === 0 || isCustom) ? (
                  <input
                    type="text"
                    value={s.property}
                    placeholder="e.g. MoleFlow"
                    onChange={(e) => updateRow(i, { property: e.target.value })}
                    style={{ marginTop: canonical.length > 0 ? '4px' : 0 }}
                  />
                ) : null}
              </label>
              <label style={{ fontSize: '0.85em', display: 'flex', flexDirection: 'column' }}>
                <span style={{ color: '#666' }}>Value</span>
                <input
                  type="text"
                  value={s.value}
                  onChange={(e) => updateRow(i, { value: e.target.value })}
                />
              </label>
              <label style={{ fontSize: '0.85em', display: 'flex', flexDirection: 'column' }}>
                <span style={{ color: '#666' }}>Unit</span>
                <input
                  type="text"
                  value={s.unit ?? ''}
                  placeholder="e.g. KilomolePerHour"
                  onChange={(e) => updateRow(i, { unit: e.target.value })}
                />
              </label>
            </div>
            <button
              type="button"
              onClick={() => removeRow(i)}
              style={{ flex: '0 0 auto', cursor: 'pointer' }}
              title="Remove row"
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={addRow}
        className="btn"
        style={{ marginTop: '0.4em', cursor: 'pointer' }}
      >
        + Add property
      </button>
    </div>
  );
};

interface MaterialEditorPanelProps {
  item: {
    type: 'template' | 'component' | 'state';
    data: any;
  };
  modeler: any;
  onClose: () => void;
}

export const MaterialEditorPanel: React.FC<MaterialEditorPanelProps> = ({ item, modeler, onClose }) => {
  const [edited, setEdited] = useState(item.data);

  // Update edited state when item changes
  useEffect(() => {
    setEdited(item.data);
  }, [item]);

  /**
   * Save the edited MaterialComponent back to the BPMN moddle tree using the
   * canonical DEXPI carrier shape (`<dexpi:data property="X">v</dexpi:data>`,
   * `<dexpi:components property="X"><dexpi:object type="Core/QualifiedValue">…
   * </dexpi:object></dexpi:components>`). Mirrors MaterialLibraryPanel's
   * saveMaterialData.componentLoop so a save through the side panel produces
   * exactly the same XML a save through the library panel would.
   *
   * The previous implementation set named JS properties directly on the
   * moddle businessObject (`component.chebiId = …`), which silently dropped
   * on serialisation because the moddle MaterialComponent definition only
   * declares `uid` / `data` / `references` / `components` as attributes —
   * everything else has to go through the canonical Data / Components carriers.
   */
  const handleSaveComponent = () => {
    const elementRegistry = modeler.get('elementRegistry');
    const modeling = modeler.get('modeling');
    const moddle = modeler.get('moddle');

    // Locate the MaterialComponent (by uid) in whichever DataObjectReference's
    // extensionElements actually hosts it. The legacy code used a name-based
    // probe ("MaterialStates"-or-includes-"Material") that could land on the
    // wrong DataObjectRef when both MaterialTemplates and MaterialStates
    // coexist. Searching by uid is unambiguous.
    const allDataObjs = elementRegistry.filter((el: any) => el.type === 'bpmn:DataObjectReference');
    let host: any = null;
    let componentModdle: any = null;
    for (const el of allDataObjs) {
      const vals = el.businessObject?.extensionElements?.values ?? [];
      const match = vals.find((v: any) =>
        (v.$type === 'MaterialComponent' || v.$type?.includes('MaterialComponent')) &&
        v.uid === edited.uid
      );
      if (match) { host = el; componentModdle = match; break; }
    }
    if (!host || !componentModdle) {
      alert(`MaterialComponent ${edited.uid} not found in the model`);
      return;
    }

    const buildDataChild = (property: string, body: string) =>
      moddle.create('dexpi:Data', { property, body });
    const buildQVComponents = (
      property: string,
      value: string,
      unit?: string,
      unitReference?: string,
      nameUri?: string,
    ) => {
      const qvData: unknown[] = [
        buildDataChild('Value', value),
        // DisplayText is required (lower=1) on Core/QualifiedValue per Core.xml;
        // derive deterministically from value + unit so the side panel emits
        // the same shape MaterialLibraryPanel.saveMaterialData does.
        buildDataChild('DisplayText', unit ? `${value} ${unit}` : value),
      ];
      if (unit) qvData.push(buildDataChild('Unit', unit));
      if (unitReference) qvData.push(buildDataChild('UnitReference', unitReference));
      const qvObjectProps: Record<string, unknown> = { type: 'Core/QualifiedValue', data: qvData };
      if (nameUri) {
        // Canonical attribute-URI encoding: <References property=
        // "QuantityKindReference" objects="URI"/> as a sibling of Data
        // inside the QualifiedValue Object. Mirrors the ProcessStep /
        // Stream attribute emit at BpmnToDexpiTransformer.ts:2261/2576.
        qvObjectProps.references = [
          moddle.create('dexpi:References', {
            property: 'QuantityKindReference',
            objects: nameUri,
          }),
        ];
      }
      return moddle.create('dexpi:Components', {
        property,
        objects: [moddle.create('dexpi:Object', qvObjectProps)],
      });
    };

    const dataChildren: unknown[] = [];
    if (edited.identifier) dataChildren.push(buildDataChild('Identifier', edited.identifier));
    if (edited.label) dataChildren.push(buildDataChild('Label', edited.label));
    if (edited.description) dataChildren.push(buildDataChild('Description', edited.description));

    const componentsChildren: unknown[] = [];
    for (const p of edited.properties ?? []) {
      // Empty rows (placeholder created by "+ Add property" but not filled in)
      // would emit invalid <Data property=""> children — drop them silently.
      if (!p.name || !p.value) continue;
      if (p.kind === 'data') {
        dataChildren.push(buildDataChild(p.name, p.value));
      } else {
        componentsChildren.push(buildQVComponents(p.name, p.value, p.unit, p.unitReference, p.nameUri));
      }
    }

    const moddleProps: Record<string, unknown> = {
      'xsi:type': edited.type,
      uid: edited.uid,
    };
    if (dataChildren.length > 0) moddleProps.data = dataChildren;
    if (componentsChildren.length > 0) moddleProps.components = componentsChildren;

    const newComponentElement = moddle.create('dexpi:MaterialComponent', moddleProps);

    const ext = host.businessObject.extensionElements;
    const idx = ext.values.findIndex((v: any) => v === componentModdle);
    if (idx >= 0) ext.values[idx] = newComponentElement;
    else ext.values.push(newComponentElement);

    modeling.updateProperties(host, { extensionElements: ext });
  };

  const handleSave = () => {
    if (item.type === 'component') {
      handleSaveComponent();
      onClose();
      return;
    }

    // Template / state save paths kept as-is — refactoring those is out of
    // scope for the schema-driven MaterialComponent editor PR. Their hosts
    // live under MaterialStates DataObjectReferences, the canonical save
    // path through MaterialLibraryPanel.saveMaterialData is already the
    // primary write surface for them.
    const modeling = modeler.get('modeling');
    const elementRegistry = modeler.get('elementRegistry');
    const allElements = elementRegistry.filter((el: any) => el.type === 'bpmn:DataObjectReference');
    const materialStatesElement = allElements.find((el: any) =>
      el.businessObject.name &&
      (el.businessObject.name === 'MaterialStates' || el.businessObject.name.includes('Material'))
    );
    if (!materialStatesElement) {
      alert('MaterialStates element not found');
      return;
    }
    const extensionElements = materialStatesElement.businessObject.extensionElements;
    if (!extensionElements) {
      alert('No extension elements found');
      return;
    }

    if (item.type === 'template') {
      const templates = extensionElements.get('values').filter((v: any) => v.$type === 'dexpi:MaterialTemplate');
      const template = templates.find((t: any) => t.uid === edited.uid);
      if (template) {
        template.identifier = edited.identifier;
        template.label = edited.label;
        template.description = edited.description;
        template.numberOfPhases = edited.numberOfPhases;
        modeling.updateProperties(materialStatesElement, { extensionElements });
      }
    } else if (item.type === 'state') {
      const cases = extensionElements.get('values').filter((v: any) => v.$type === 'dexpi:Case');
      let found = false;
      for (const caseEl of cases) {
        if (caseEl.materialStates) {
          const state = caseEl.materialStates.find((s: any) => s.uid === edited.uid);
          if (state) {
            state.identifier = edited.identifier;
            state.label = edited.label;
            state.description = edited.description;
            if (!state.flow) state.flow = {};
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            state.flow.scalars = (edited.flow?.scalars ?? []).filter((s: any) =>
              s && s.property && s.value !== '' && s.value !== undefined && s.value !== null
            );
            if (edited.flow?.composition?.fractions) {
              if (!state.flow.composition) state.flow.composition = {};
              state.flow.composition.fractions = edited.flow.composition.fractions.map((f: any) => ({
                componentReference: f.componentReference,
                value: f.value,
              }));
            }
            found = true;
            break;
          }
        }
      }
      if (found) {
        modeling.updateProperties(materialStatesElement, { extensionElements });
      }
    }

    onClose();
  };

  return (
    <div className="properties-panel-content">
      <div className="panel-header">
        <h3>
          {item.type === 'template' && '📋 Material Template'}
          {item.type === 'component' && '🧪 Material Component'}
          {item.type === 'state' && '⚗️ Material State'}
        </h3>
        <button onClick={onClose} className="btn-close" title="Close">×</button>
      </div>

      <div className="panel-body">
        {item.type === 'template' && (
          <>
            <div className="form-group">
              <label>Identifier:</label>
              <input
                type="text"
                value={edited.identifier || ''}
                onChange={(e) => setEdited({ ...edited, identifier: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Label:</label>
              <input
                type="text"
                value={edited.label || ''}
                onChange={(e) => setEdited({ ...edited, label: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Description:</label>
              <textarea
                value={edited.description || ''}
                onChange={(e) => setEdited({ ...edited, description: e.target.value })}
                rows={3}
              />
            </div>
            <div className="form-group">
              <label>Number of Components:</label>
              <input
                type="number"
                value={edited.numberOfComponents || 0}
                readOnly
                disabled
                title="Calculated automatically from components"
              />
            </div>
            <div className="form-group">
              <label>Number of Phases:</label>
              <input
                type="number"
                value={edited.numberOfPhases || 1}
                onChange={(e) => setEdited({ ...edited, numberOfPhases: parseInt(e.target.value) || 1 })}
                min="1"
              />
            </div>
          </>
        )}

        {item.type === 'component' && (
          <ComponentSchemaDrivenForm edited={edited} setEdited={setEdited} />
        )}

        {item.type === 'state' && (
          <>
            <div className="form-group">
              <label>Identifier:</label>
              <input
                type="text"
                value={edited.identifier || ''}
                onChange={(e) => setEdited({ ...edited, identifier: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Label:</label>
              <input
                type="text"
                value={edited.label || ''}
                onChange={(e) => setEdited({ ...edited, label: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Description:</label>
              <textarea
                value={edited.description || ''}
                onChange={(e) => setEdited({ ...edited, description: e.target.value })}
                rows={3}
              />
            </div>
            <ScalarPropertiesEditor edited={edited} setEdited={setEdited} registry={baseRegistry} />
            <div className="form-group">
              <label>Template Reference:</label>
              <input
                type="text"
                value={edited.templateRef || ''}
                readOnly
                disabled
                title="Set by material template"
              />
            </div>
            {edited.flow?.composition?.fractions && edited.flow.composition.fractions.length > 0 && (
              <div className="form-group">
                <label>Composition (Mole Fractions):</label>
                <div style={{
                  border: '1px solid #dee2e6',
                  borderRadius: '4px',
                  padding: '8px',
                  background: '#f8f9fa',
                }}>
                  {edited.flow.composition.fractions.map((fraction: any, index: number) => (
                    <div key={index} style={{
                      display: 'flex',
                      gap: '8px',
                      marginBottom: '6px',
                      alignItems: 'center',
                    }}>
                      <input
                        type="text"
                        value={fraction.componentReference || ''}
                        onChange={(e) => {
                          const newFractions = [...edited.flow.composition.fractions];
                          newFractions[index] = { ...newFractions[index], componentReference: e.target.value };
                          setEdited({
                            ...edited,
                            flow: {
                              ...edited.flow,
                              composition: {
                                ...edited.flow.composition,
                                fractions: newFractions,
                              },
                            },
                          });
                        }}
                        placeholder="Component"
                        style={{ flex: 1 }}
                      />
                      <input
                        type="number"
                        step="0.0001"
                        // ?? not || — a real 0 is not "missing data"; PFD
                        // composition tables conventionally show explicit
                        // zeros for components that aren't present, and
                        // the row's existence implies the component is in
                        // the template's ListOfComponents whether or not
                        // its fraction is non-zero.
                        value={fraction.value ?? ''}
                        onChange={(e) => {
                          const newFractions = [...edited.flow.composition.fractions];
                          newFractions[index] = { ...newFractions[index], value: e.target.value };
                          setEdited({
                            ...edited,
                            flow: {
                              ...edited.flow,
                              composition: {
                                ...edited.flow.composition,
                                fractions: newFractions,
                              },
                            },
                          });
                        }}
                        placeholder="Fraction"
                        style={{ width: '100px' }}
                      />
                    </div>
                  ))}
                  <div style={{
                    marginTop: '8px',
                    paddingTop: '8px',
                    borderTop: '1px solid #dee2e6',
                    fontSize: '0.85em',
                    color: '#666',
                  }}>
                    Total: {edited.flow.composition.fractions.reduce((sum: number, f: any) => sum + (parseFloat(f.value) || 0), 0).toFixed(4)}
                  </div>
                </div>
              </div>
            )}
            {edited.referencedByStreams && edited.referencedByStreams.length > 0 && (
              <div className="form-group">
                <label>Used by Streams:</label>
                <div style={{
                  padding: '8px',
                  background: '#e3f2fd',
                  borderRadius: '4px',
                  fontSize: '0.9em',
                  color: '#1976d2',
                }}>
                  {edited.referencedByStreams.join(', ')}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="panel-footer">
        <button onClick={handleSave} className="btn btn-primary">
          Save Changes
        </button>
        <button onClick={onClose} className="btn">
          Cancel
        </button>
      </div>
    </div>
  );
};

// ── MaterialComponent: schema-driven form ────────────────────────────────────
//
// Renders a row per data-kind property declared on `edited.type`'s class in
// Process.xml (or inherited from MaterialComponent's superclass chain), plus
// any project-extension rows the user has authored beyond the schema. There
// are no class-specific hardcoded inputs (no ChEBI / IUPAC / CAS) — when
// Process.xml gains or drops a property on PureMaterialComponent or
// CustomMaterialComponent, the editor follows automatically because every
// row is derived from `registry.getProperties(className)`.
//
// Three property buckets:
//   1. Structural (Identifier / Label / Description) — bound to the typed
//      fields on `MaterialComponent` because the rest of the codebase reads
//      them as named JS properties for cross-reference and list display.
//   2. Schema-declared, non-structural (e.g. ChEBI_identifier on
//      PureMaterialComponent, ProjectReference on CustomMaterialComponent) —
//      stored in `edited.properties` with kind='data'. A row always
//      materialises so the user knows the property exists, even when not
//      yet authored.
//   3. Project-extension (anything in `edited.properties` whose name isn't
//      a declared property) — rendered as ad-hoc rows with full
//      AttributeNameValueRow editing (name dropdown + Custom escape hatch)
//      and a Kind toggle for QualifiedValue-shaped composition properties.

interface ComponentSchemaDrivenFormProps {
  edited: MaterialComponent;
  setEdited: (next: MaterialComponent) => void;
}

const ComponentSchemaDrivenForm: React.FC<ComponentSchemaDrivenFormProps> = ({ edited, setEdited }) => {
  const className = edited.type;

  // All data-kind + composition-kind properties declared (or inherited) on
  // this class. When Process.xml adds a new DataProperty or
  // CompositionProperty to PureMaterialComponent / CustomMaterialComponent /
  // MaterialComponent (abstract base), it shows up here automatically.
  // Reference kinds are still skipped — those need a different uid-picker
  // UI that doesn't fit a generic row, and the audit task tracks reference
  // coverage separately.
  const declaredProps: DexpiProperty[] = useMemo(() => {
    if (!baseRegistry || !baseRegistry.isValidClass(className)) return [];
    return baseRegistry.getProperties(className)
      .filter(p => p.kind === 'data' || p.kind === 'composition');
  }, [className]);

  // Set lookup for "is this name schema-declared?" — drives whether a
  // row in `edited.properties` renders here as a declared row or as an
  // ad-hoc project-extension row below.
  const declaredNames = useMemo(
    () => new Set(declaredProps.map(p => p.name)),
    [declaredProps],
  );

  // Concrete subclasses of MaterialComponent the user can switch between.
  // Derived from the registry — when Process.xml adds a new subclass
  // (e.g. BiologicalMaterialComponent in some future DEXPI release) it
  // appears in the Type dropdown automatically with no UI changes.
  const subclassOptions = useMemo<string[]>(() => {
    if (!baseRegistry) return ['PureMaterialComponent', 'CustomMaterialComponent'];
    return baseRegistry
      .concreteClasses()
      .filter(c => baseRegistry.hasAncestor(c, 'MaterialComponent'));
  }, []);

  // Project-extension rows: anything in properties[] whose name isn't on
  // the schema. Includes user-added composition rows (MolecularWeight,
  // AntoineA, …) which live as Components/QualifiedValue carriers on emit.
  const adHocRows = (edited.properties ?? []).filter(p => !declaredNames.has(p.name));

  // ── Helpers to read / write a single declared property ─────────────────
  // Data-kind: structural fields (Identifier/Label/Description) bind to the
  // typed JS fields; everything else binds to a single string in
  // properties[]. Composition-kind: always binds to properties[] with a
  // QualifiedValue-shaped {value, unit, unitReference} payload — same shape
  // ad-hoc composition rows use, so save/load paths handle both uniformly.
  const readDeclaredValue = (name: string): string => {
    if (name === 'Identifier') return edited.identifier ?? '';
    if (name === 'Label') return edited.label ?? '';
    if (name === 'Description') return edited.description ?? '';
    return (edited.properties ?? []).find(p => p.name === name)?.value ?? '';
  };

  const writeDeclaredValue = (name: string, value: string) => {
    if (name === 'Identifier') return setEdited({ ...edited, identifier: value });
    if (name === 'Label') return setEdited({ ...edited, label: value });
    if (name === 'Description') return setEdited({ ...edited, description: value });
    const props = [...(edited.properties ?? [])];
    const idx = props.findIndex(p => p.name === name);
    if (value === '') {
      // Drop the entry entirely when the user blanks it out — keeps the
      // serialised <dexpi:data> children tight, and an empty entry would
      // re-render as an empty row at the same position on next load.
      if (idx >= 0) {
        const next = props.filter((_, i) => i !== idx);
        setEdited({ ...edited, properties: next.length > 0 ? next : undefined });
      }
      return;
    }
    if (idx >= 0) {
      props[idx] = { ...props[idx], value };
    } else {
      props.push({ kind: 'data', name, value });
    }
    setEdited({ ...edited, properties: props });
  };

  /** Read a declared composition row's current QualifiedValue payload. */
  const readDeclaredComposition = (name: string) =>
    (edited.properties ?? []).find(p => p.name === name && p.kind === 'composition');

  /**
   * Patch one field on a declared composition row in properties[]. Creates
   * the entry on first edit; drops it when value+unit+unitReference all blank
   * (mirrors writeDeclaredValue's empty-cleanup behaviour).
   */
  const writeDeclaredComposition = (
    name: string,
    patch: Partial<Pick<MaterialComponentProperty, 'value' | 'unit' | 'unitReference' | 'nameUri'>>,
  ) => {
    const props = [...(edited.properties ?? [])];
    const idx = props.findIndex(p => p.name === name);
    const merged: MaterialComponentProperty = idx >= 0
      ? { ...props[idx], ...patch }
      : { kind: 'composition', name, value: '', ...patch };
    const isEmpty = !merged.value && !merged.unit && !merged.unitReference && !merged.nameUri;
    if (isEmpty) {
      if (idx >= 0) {
        const next = props.filter((_, i) => i !== idx);
        setEdited({ ...edited, properties: next.length > 0 ? next : undefined });
      }
      return;
    }
    if (idx >= 0) props[idx] = merged;
    else props.push(merged);
    setEdited({ ...edited, properties: props });
  };

  // ── Ad-hoc row mutators (operate on the project-extension subset) ──────
  const updateAdHoc = (filteredIndex: number, updates: Partial<MaterialComponentProperty>) => {
    const all = [...(edited.properties ?? [])];
    // Map the filtered-array index back to the absolute index in `properties`.
    let seen = -1;
    for (let i = 0; i < all.length; i++) {
      if (declaredNames.has(all[i].name)) continue;
      seen += 1;
      if (seen === filteredIndex) {
        all[i] = { ...all[i], ...updates };
        setEdited({ ...edited, properties: all });
        return;
      }
    }
  };
  const removeAdHoc = (filteredIndex: number) => {
    const all = [...(edited.properties ?? [])];
    let seen = -1;
    for (let i = 0; i < all.length; i++) {
      if (declaredNames.has(all[i].name)) continue;
      seen += 1;
      if (seen === filteredIndex) {
        const next = all.filter((_, j) => j !== i);
        setEdited({ ...edited, properties: next.length > 0 ? next : undefined });
        return;
      }
    }
  };
  const addAdHoc = () => {
    const next: MaterialComponentProperty = { kind: 'composition', name: '', value: '' };
    setEdited({ ...edited, properties: [...(edited.properties ?? []), next] });
  };

  // Description and any future MultiLanguageString-typed property gets a
  // textarea. Driven entirely by the schema's targetType — no name list.
  const isMultiLineString = (prop: DexpiProperty): boolean =>
    !!prop.targetType?.includes('MultiLanguageString');

  return (
    <>
      {/* Type discriminator (xsi:type). Switching this re-runs
          `declaredProps` against the new class, so PureMaterial-only
          properties (ChEBI_identifier / IUPAC_identifier) and Custom-only
          properties (ProjectReference) appear or disappear based on the
          schema's own subclass declarations — no UI hardcoding. */}
      <div className="form-group">
        <label>Type:</label>
        <select
          value={edited.type}
          onChange={(e) => setEdited({ ...edited, type: e.target.value as MaterialComponent['type'] })}
        >
          {subclassOptions.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      {/* Schema-declared rows. Identifier / Label / Description bind to the
          typed structural fields; data-kind properties bind to properties[]
          as a flat string; composition-kind properties bind to properties[]
          as a QualifiedValue payload (value + unit + unitReference). */}
      {declaredProps.length === 0 && (
        <div style={{ padding: '0.5em', color: '#a44', fontSize: '0.9em' }}>
          ⚠ Class <code>{className}</code> not found in the loaded schema.
        </div>
      )}
      {declaredProps.map(prop => {
        const required = prop.lower >= 1;
        const labelText = `${prop.name}${required ? ' *' : ''}`;
        const isStructural = STRUCTURAL_PROPS.has(prop.name);
        const tooltip = `Declared on ${prop.declaredOn}${prop.targetType ? ` (${prop.targetType})` : ''}${
          isStructural ? ' — structural field' : ''
        } [kind=${prop.kind}]`;

        if (prop.kind === 'composition') {
          // Dispatch by inner Object type. CompositionProperty whose inner
          // class is Core/QualifiedValue (the vast majority — MolecularWeight,
          // VapourHeatCapacity, etc.) gets the canonical Value+Unit+URIs UI.
          // Anything else (e.g. PersistentIdentifiers → Core/PersistentIdentifier
          // with Context+Value fields) gets a generic list-of-records editor
          // that introspects the inner class's DataProperties from the
          // registry — text input by default, <select> for fields whose
          // targetType matches a declared Enumeration.
          const innerClassName = baseRegistry?.getCompositionInnerClassName(className, prop.name) ?? null;
          const isQualifiedValue = innerClassName === 'QualifiedValue' || innerClassName === null;
          if (!isQualifiedValue) {
            return (
              <NonQvCompositionField
                key={`${className}::${prop.name}`}
                propName={prop.name}
                labelText={labelText}
                tooltip={tooltip}
                innerClassName={innerClassName}
                registry={baseRegistry}
                edited={edited}
                setEdited={setEdited}
              />
            );
          }
          const entry = readDeclaredComposition(prop.name);
          return (
            <div className="form-group" key={`${className}::${prop.name}`}>
              <label title={tooltip}>{labelText}:</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  placeholder="Value"
                  value={entry?.value ?? ''}
                  onChange={(e) => writeDeclaredComposition(prop.name, { value: e.target.value })}
                  style={{ flex: 1 }}
                />
                <input
                  type="text"
                  placeholder="Unit"
                  value={entry?.unit ?? ''}
                  onChange={(e) => writeDeclaredComposition(prop.name, { unit: e.target.value })}
                  style={{ width: '90px' }}
                />
              </div>
              <input
                type="text"
                placeholder="Attribute URI (e.g. https://qudt.org/vocab/quantitykind/MolarMass)"
                value={entry?.nameUri ?? ''}
                onChange={(e) => writeDeclaredComposition(prop.name, { nameUri: e.target.value })}
                style={{ fontFamily: 'monospace', fontSize: '0.85em', marginTop: '0.3em' }}
              />
              <input
                type="text"
                placeholder="Unit URI (e.g. https://qudt.org/vocab/unit/GM-PER-MOL)"
                value={entry?.unitReference ?? ''}
                onChange={(e) => writeDeclaredComposition(prop.name, { unitReference: e.target.value })}
                style={{ fontFamily: 'monospace', fontSize: '0.85em', marginTop: '0.3em' }}
              />
            </div>
          );
        }

        // data-kind row
        const value = readDeclaredValue(prop.name);
        return (
          <div className="form-group" key={`${className}::${prop.name}`}>
            <label title={tooltip}>{labelText}:</label>
            {isMultiLineString(prop) ? (
              <textarea
                value={value}
                onChange={(e) => writeDeclaredValue(prop.name, e.target.value)}
                rows={3}
              />
            ) : (
              <input
                type="text"
                value={value}
                onChange={(e) => writeDeclaredValue(prop.name, e.target.value)}
              />
            )}
          </div>
        );
      })}

      {/* Project-extension properties — rows for anything in properties[] not
          declared on the class. Authoring controls match the existing PR #32
          editor: full AttributeNameValueRow + kind toggle + unit / unit URI
          for composition rows. */}
      <div className="form-group" style={{ marginTop: '0.75em' }}>
        <label style={{ fontWeight: 600 }}>
          Project-extension properties ({adHocRows.length})
        </label>
        <div style={{ fontSize: '0.85em', color: '#666', marginBottom: '0.4em', fontStyle: 'italic' }}>
          Properties beyond the {declaredProps.length} the schema declares for {className}.
          Round-tripped through the BPMN extensionElements and the DEXPI export.
        </div>

        {adHocRows.map((p, i) => (
          <div
            key={i}
            style={{
              border: '1px solid #ddd',
              borderRadius: '4px',
              padding: '0.5em 0.6em',
              marginBottom: '0.4em',
              background: '#fafafa',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4em' }}>
              <strong style={{ fontFamily: 'monospace' }}>{p.name || '(unnamed)'}</strong>
              <button
                onClick={() => removeAdHoc(i)}
                style={{ border: 'none', background: 'transparent', color: '#a44', cursor: 'pointer', fontSize: '1em' }}
                title="Remove this property"
              >
                ×
              </button>
            </div>

            <AttributeNameValueRow
              attr={{ name: p.name, value: p.value }}
              registry={baseRegistry}
              className={className}
              onChange={(updates) => updateAdHoc(i, {
                ...(updates.name !== undefined ? { name: updates.name } : {}),
                ...(updates.value !== undefined ? { value: updates.value } : {}),
              })}
              betweenNameAndValue={p.kind === 'composition' ? (
                // Attribute URI mirrors the DexpiPropertiesPanel pattern —
                // shown between Name and Value. Composition-only because
                // DEXPI canonical only defines a slot for it inside the
                // QualifiedValue Object (References > QuantityKindReference).
                // Non-canonical URIs on data rows are deferred to the
                // Profile-extension mechanism (Task B audit territory).
                <label>
                  Attribute URI:
                  <input
                    type="text"
                    value={p.nameUri ?? ''}
                    onChange={(e) => updateAdHoc(i, { nameUri: e.target.value })}
                    placeholder="e.g. https://qudt.org/vocab/quantitykind/MolarMass"
                    style={{ fontFamily: 'monospace', fontSize: '0.85em' }}
                  />
                </label>
              ) : undefined}
            />

            <label style={{ display: 'block', marginTop: '0.3em' }}>
              Kind:
              <select
                value={p.kind}
                onChange={(e) => updateAdHoc(i, { kind: e.target.value as MaterialComponentProperty['kind'] })}
              >
                <option value="composition">measurement (Value + Unit)</option>
                <option value="data">data (flat value)</option>
              </select>
            </label>

            {p.kind === 'composition' && (
              <>
                <label style={{ display: 'block', marginTop: '0.3em' }}>
                  Unit:
                  <input
                    type="text"
                    value={p.unit ?? ''}
                    onChange={(e) => updateAdHoc(i, { unit: e.target.value })}
                    placeholder="e.g. g/mol, K, kJ/(kg·K)"
                  />
                </label>
                <label style={{ display: 'block', marginTop: '0.3em' }}>
                  Unit URI:
                  <input
                    type="text"
                    value={p.unitReference ?? ''}
                    onChange={(e) => updateAdHoc(i, { unitReference: e.target.value })}
                    placeholder="e.g. https://qudt.org/vocab/unit/GM-PER-MOL"
                    style={{ fontFamily: 'monospace', fontSize: '0.85em' }}
                  />
                </label>
              </>
            )}
          </div>
        ))}

        <button
          onClick={addAdHoc}
          className="btn"
          style={{ marginTop: '0.3em' }}
        >
          + Add property
        </button>
      </div>
    </>
  );
};
