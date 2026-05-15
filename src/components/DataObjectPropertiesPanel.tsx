/**
 * DataObjectPropertiesPanel — UI for the BPMN DataObjectReference that mediates
 * an instrumentation flow between a ProcessStep and an InstrumentationActivity.
 *
 * Per DEXPI 2.0 spec p.900, the variable being measured / controlled is a
 * parameter on the connected ProcessStep, referenced by the
 * InstrumentationActivity via MeasuredVariableReference. This panel writes the
 * canonical authoring shape onto the dataObjectReference's extensionElements:
 *
 *   <bpmn:extensionElements>
 *     <dexpi:components property="<VarName>">
 *       <dexpi:object type="Core/QualifiedValue">
 *         <dexpi:data property="Provenance">Observed</dexpi:data>
 *         <dexpi:data property="Range">Nominal</dexpi:data>
 *         <dexpi:data property="Value">…</dexpi:data>
 *         <dexpi:data property="Unit">…</dexpi:data>
 *       </dexpi:object>
 *     </dexpi:components>
 *   </bpmn:extensionElements>
 *
 * which the transformer reads at extract time
 * (extractQualifiedValueFromDataObjectExtension) and emits as a Components
 * carrier on the connected ProcessStep on export.
 *
 * UI behaviour:
 *  - Detects the connected ProcessStep by walking the BPMN graph from the
 *    DataObject through any intermediate InstrumentationActivity.
 *  - Variable property dropdown is populated from the connected step's
 *    declared CompositionProperty<Core/QualifiedValue> properties (registry-
 *    driven, walks supertype chain). User can also type a custom name —
 *    the Profile generator declares it as a CompositionProperty extension on
 *    that step's class at export time.
 *  - Provenance / Range dropdowns expose the canonical Core enum literals
 *    (QuantityProvenance / QuantityRange in Core.xml). Default Provenance is
 *    "Observed" (canonical literal for instrument-derived values); default
 *    Range is "Nominal".
 *  - Value / Unit are free-text optional. Empty Value/Unit emit as
 *    <Undefined/> placeholders on the ProcessStep slot per the schema's
 *    lower=1 requirement on Core/QualifiedValue.Value / DisplayText.
 *  - The DataObject's `name=` is kept in sync with the selected property name
 *    for diagram readability (consistent with the paper's representation
 *    text: "its identity ... in the Data Object's name attribute").
 */

import React, { useEffect, useMemo, useState } from 'react';
import { DexpiProcessClassRegistry } from '../transformer/DexpiProcessClassRegistry';
import processXmlRaw from '../../dexpi-schema-files/Process.xml?raw';
import coreXmlRaw from '../../dexpi-schema-files/Core.xml?raw';

// Build from both Process.xml + Core.xml so Core-declared enums
// (QuantityProvenance, QuantityRange) resolve via getEnumerationLiterals.
// Same pattern as DexpiPropertiesPanel + MaterialEditorPanel.
const REGISTRY = DexpiProcessClassRegistry.fromXmlSources([
  { name: 'Process.xml', xml: processXmlRaw },
  { name: 'Core.xml', xml: coreXmlRaw },
]);

// Enum literal lists sourced from the schema so a future DEXPI version
// that adds / renames a literal is picked up automatically. Default
// values stay as plain constants because they're UX choices ("Observed"
// is the canonical literal for instrument-derived values; "Nominal" is
// the typical range qualifier), not enum-membership claims.
const PROVENANCE_LITERALS = REGISTRY.getEnumerationLiterals('QuantityProvenance') ?? [];
const DEFAULT_PROVENANCE = 'Observed';
const RANGE_LITERALS = REGISTRY.getEnumerationLiterals('QuantityRange') ?? [];
const DEFAULT_RANGE = 'Nominal';

interface QualifiedValueDraft {
  property: string;     // matches the dataObjectReference.name and the Components.property
  provenance: string;
  range: string;
  value: string;
  unit: string;
}

const EMPTY_DRAFT: QualifiedValueDraft = {
  property: '',
  provenance: DEFAULT_PROVENANCE,
  range: DEFAULT_RANGE,
  value: '',
  unit: '',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractDraftFromBusinessObject(bo: any): QualifiedValueDraft {
  const draft: QualifiedValueDraft = { ...EMPTY_DRAFT };
  draft.property = bo?.name || '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ext = bo?.extensionElements?.values as any[] | undefined;
  if (!ext) return draft;
  // Find the canonical <dexpi:components property="X"><dexpi:object type="Core/QualifiedValue">…
  for (const carrier of ext) {
    if (carrier?.$type !== 'dexpi:Components') continue;
    if (carrier.property) draft.property = carrier.property;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qv = (carrier.objects as any[] | undefined)?.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (o: any) => o?.$type === 'dexpi:Object' && o?.type === 'Core/QualifiedValue'
    );
    if (!qv) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = qv.data as any[] | undefined;
    if (!data) continue;
    for (const d of data) {
      if (d?.$type !== 'dexpi:Data') continue;
      const body = d.body ?? '';
      switch (d.property) {
        case 'Provenance': draft.provenance = body || DEFAULT_PROVENANCE; break;
        case 'Range':      draft.range      = body || DEFAULT_RANGE; break;
        case 'Value':      draft.value      = body; break;
        case 'Unit':       draft.unit       = body; break;
      }
    }
    break;
  }
  return draft;
}

/**
 * Walk the BPMN graph from the selected dataObjectReference to find the
 * connected ProcessStep. Two-hop search: DataObject → connected task; if
 * that task is itself an InstrumentationActivity, traverse one more hop
 * via its sequence flows to find the actual ProcessStep being measured /
 * controlled. Returns the first non-instrumentation task encountered, or
 * undefined when no step is reachable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findConnectedProcessStep(element: any): { step: any; className: string } | undefined {
  if (!element) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collectConnected = (el: any): any[] => {
    const out: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const c of [...(el.incoming || []), ...(el.outgoing || [])] as any[]) {
      const other = c.source === el ? c.target : c.source;
      if (other) out.push(other);
    }
    return out;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dexpiTypeOf = (task: any): string | undefined => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ext = task?.businessObject?.extensionElements?.values as any[] | undefined;
    if (!ext) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dexpiEl = ext.find((e: any) => e?.$type === 'dexpi:Element' || e?.$type === 'dexpi:element');
    return dexpiEl?.dexpiType;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isInstrumentationActivity = (task: any): boolean => {
    const dt = dexpiTypeOf(task);
    if (!dt) return false;
    return REGISTRY.hasAncestor(dt, 'InstrumentationActivity');
  };
  const firstHop = collectConnected(element).filter(t => t.type?.includes?.('Task') || t.type?.includes?.('SubProcess'));
  for (const task of firstHop) {
    if (!isInstrumentationActivity(task)) {
      const dt = dexpiTypeOf(task);
      if (dt && REGISTRY.isValidClass(dt)) return { step: task, className: dt };
    }
  }
  // Second hop: connected task is itself instrumentation; follow its
  // sequence flows to a non-instrumentation task.
  for (const ia of firstHop) {
    if (!isInstrumentationActivity(ia)) continue;
    for (const next of collectConnected(ia)) {
      if (next === element) continue;
      if (!isInstrumentationActivity(next)) {
        const dt = dexpiTypeOf(next);
        if (dt && REGISTRY.isValidClass(dt)) return { step: next, className: dt };
      }
    }
  }
  return undefined;
}

/**
 * Composition properties of a ProcessStep class whose binding targets
 * Core/QualifiedValue — these are the variable parameters an
 * InstrumentationActivity can measure / control on this step. Walks the
 * supertype chain via DexpiProcessClassRegistry.getProperties().
 */
function qualifiedValuePropertiesOf(className: string): string[] {
  if (!REGISTRY.isValidClass(className)) return [];
  return REGISTRY.getProperties(className)
    .filter(p => p.kind === 'composition' && (p.targetType === 'Core/QualifiedValue' || p.targetType?.endsWith('/QualifiedValue')))
    .map(p => p.name)
    .sort();
}

interface DataObjectPropertiesPanelProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  element: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modeler: any;
}

export const DataObjectPropertiesPanel: React.FC<DataObjectPropertiesPanelProps> = ({ element, modeler }) => {
  const [draft, setDraft] = useState<QualifiedValueDraft>(EMPTY_DRAFT);
  const connected = useMemo(() => findConnectedProcessStep(element), [element]);
  const candidateProps = useMemo(
    () => connected ? qualifiedValuePropertiesOf(connected.className) : [],
    [connected],
  );

  useEffect(() => {
    if (!element) return;
    // Sync draft state from the newly selected element. Same pattern as
    // DexpiPropertiesPanel / StreamPropertiesPanel — load-from-businessObject
    // happens once per selection, then the user's edits drive subsequent
    // setDraft calls in writeDraft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(extractDraftFromBusinessObject(element.businessObject));
  }, [element]);

  if (!element) return null;
  const isUnconnected = (element.incoming?.length ?? 0) === 0 && (element.outgoing?.length ?? 0) === 0;
  if (isUnconnected) {
    return (
      <div className="dexpi-properties-panel">
        <h3>Material / Simulation Data</h3>
        <div style={{ padding: '8px', backgroundColor: '#f3e5f5', borderRadius: '4px', fontSize: '0.85rem', color: '#6a1b9a' }}>
          📊 MaterialTemplate or simulation case — edit via the <strong>Materials panel</strong> in the toolbar.
        </div>
      </div>
    );
  }

  const writeDraft = (next: QualifiedValueDraft) => {
    setDraft(next);
    if (!modeler) return;
    const modeling = modeler.get('modeling');
    const moddle = modeler.get('moddle');
    const businessObject = element.businessObject;

    let extensionElements = businessObject.extensionElements;
    if (!extensionElements) extensionElements = moddle.create('bpmn:ExtensionElements');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing: any[] = extensionElements.values || [];

    // Drop any existing dexpi:Components carriers (we own them on this element)
    // and re-emit a single canonical one. dexpi:Element / other annotations
    // (rare on a dataObjectReference, but possible) are preserved.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nextValues: any[] = existing.filter((v: any) => v?.$type !== 'dexpi:Components');

    if (next.property) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any[] = [];
      const buildData = (property: string, body: string) =>
        moddle.create('dexpi:Data', { property, body });
      // Provenance / Range emit only when truthy — Core/QualifiedValue declares
      // both as lower=0, so absence is canonical "not authored".
      if (next.provenance) data.push(buildData('Provenance', next.provenance));
      if (next.range)      data.push(buildData('Range',      next.range));
      if (next.value)      data.push(buildData('Value',      next.value));
      if (next.unit)       data.push(buildData('Unit',       next.unit));
      const qvObject = moddle.create('dexpi:Object', {
        type: 'Core/QualifiedValue',
        data,
      });
      const carrier = moddle.create('dexpi:Components', {
        property: next.property,
        objects: [qvObject],
      });
      nextValues.push(carrier);
    }

    extensionElements = moddle.create('bpmn:ExtensionElements', { values: nextValues });

    // Keep the BPMN-side `name=` in sync with the property identity for
    // diagram readability (DEXPI Process representation in BPMN: the data
    // object's name shows the variable identity in the diagram).
    modeling.updateProperties(element, {
      extensionElements,
      ...(next.property ? { name: next.property } : {}),
    });
  };

  const propertyOptions = candidateProps.length > 0 ? candidateProps : [];

  return (
    <div className="dexpi-properties-panel">
      <h3>Process Variable</h3>
      <div style={{ padding: '8px', backgroundColor: '#e8f5e9', borderRadius: '4px', fontSize: '0.85rem', color: '#2e7d32', marginBottom: '12px' }}>
        🔬 Carries a <code>Core/QualifiedValue</code> on the connected ProcessStep
        {connected ? <> (<strong>{connected.className}</strong>)</> : <> — <em>no ProcessStep reachable; pick any property name and the Profile generator will declare it</em></>}.
      </div>

      <div className="property-group">
        <label htmlFor="dop-property">Variable property</label>
        {propertyOptions.length > 0 ? (
          <select
            id="dop-property"
            value={propertyOptions.includes(draft.property) ? draft.property : '__custom__'}
            onChange={(e) => {
              const v = e.target.value;
              writeDraft({ ...draft, property: v === '__custom__' ? draft.property : v });
            }}
          >
            <option value="" disabled>— choose a parameter on {connected?.className} —</option>
            {propertyOptions.map(p => <option key={p} value={p}>{p}</option>)}
            <option value="__custom__">Custom (Profile-extension) …</option>
          </select>
        ) : null}
        {(propertyOptions.length === 0 || !propertyOptions.includes(draft.property)) ? (
          <input
            type="text"
            placeholder="e.g. Temperature"
            value={draft.property}
            onChange={(e) => writeDraft({ ...draft, property: e.target.value })}
            style={{ marginTop: propertyOptions.length > 0 ? '4px' : 0 }}
          />
        ) : null}
      </div>

      <div className="property-group">
        <label htmlFor="dop-provenance">Provenance</label>
        <select
          id="dop-provenance"
          value={draft.provenance}
          onChange={(e) => writeDraft({ ...draft, provenance: e.target.value })}
        >
          <option value="">—</option>
          {PROVENANCE_LITERALS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>

      <div className="property-group">
        <label htmlFor="dop-range">Range</label>
        <select
          id="dop-range"
          value={draft.range}
          onChange={(e) => writeDraft({ ...draft, range: e.target.value })}
        >
          <option value="">—</option>
          {RANGE_LITERALS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>

      <div className="property-group">
        <label htmlFor="dop-value">Value</label>
        <input
          id="dop-value"
          type="text"
          value={draft.value}
          onChange={(e) => writeDraft({ ...draft, value: e.target.value })}
          placeholder="optional — empty = <Undefined/> placeholder on export"
        />
      </div>

      <div className="property-group">
        <label htmlFor="dop-unit">Unit</label>
        <input
          id="dop-unit"
          type="text"
          value={draft.unit}
          onChange={(e) => writeDraft({ ...draft, unit: e.target.value })}
          placeholder="optional — e.g. degC, bar, kg/h"
        />
      </div>
    </div>
  );
};
