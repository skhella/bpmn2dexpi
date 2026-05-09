// TODO: type-shape mismatch on composition fractions (TS errors at lines ~1242,
// 1366, 1369, 1385, 1413). The UI treats `fractions` as plain numbers
// (parseFloat, sum + f, fraction * 100), but `MaterialState.flow.composition.fractions`
// is typed as `{ componentReference: string; value: number; unit?: string }[]`,
// and the transformer's internal `FractionData` is yet a third shape
// (`{ value: string; componentRef: string }`). Three competing representations,
// no canonical source of truth. Fixing requires a deliberate data-model decision
// (which shape wins?), migration of any saved models, and updates across the
// importer/exporter — out of scope for the Profile-generator branch.
import React from 'react';
import type { MaterialTemplate, MaterialComponent, MaterialState } from '../dexpi/moddle/materials';
import { DexpiProcessClassRegistry } from '../transformer/DexpiProcessClassRegistry';
import processXmlRaw from '../../dexpi-schema-files/Process.xml?raw';
import coreXmlRaw from '../../dexpi-schema-files/Core.xml?raw';

// Registry built once per module — used by ComponentEditor to enumerate
// concrete subclasses of MaterialComponent for the Type dropdown so new
// Process.xml subclasses surface automatically.
const MATERIAL_REGISTRY: DexpiProcessClassRegistry | null = (() => {
  try {
    return DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: processXmlRaw },
      { name: 'Core.xml', xml: coreXmlRaw },
    ]);
  } catch {
    return null;
  }
})();
const MATERIAL_COMPONENT_SUBCLASSES = MATERIAL_REGISTRY
  ? MATERIAL_REGISTRY.concreteClasses().filter(c => MATERIAL_REGISTRY.hasAncestor(c, 'MaterialComponent'))
  : ['PureMaterialComponent', 'CustomMaterialComponent'];

interface MaterialLibraryPanelProps {
  modeler: any;
  initialTab?: 'templates' | 'components' | 'states';
  onSelectItem?: (item: { type: 'template' | 'component' | 'state', data: any }) => void;
  selectedItemId?: string;
}

export const MaterialLibraryPanel: React.FC<MaterialLibraryPanelProps> = ({ 
  modeler, 
  initialTab = 'templates',
  onSelectItem,
  selectedItemId
}) => {
  const [templates, setTemplates] = React.useState<MaterialTemplate[]>([]);
  const [components, setComponents] = React.useState<MaterialComponent[]>([]);
  const [states, setStates] = React.useState<MaterialState[]>([]);
  const [stateGroups, setStateGroups] = React.useState<{ [key: string]: MaterialState[] }>({});
  const [expandedGroups, setExpandedGroups] = React.useState<{ [key: string]: boolean }>({});
  const [activeTab, setActiveTab] = React.useState<'templates' | 'components' | 'states'>(initialTab);
  const [selectedTemplate, setSelectedTemplate] = React.useState<MaterialTemplate | null>(null);
  const [editingTemplate, setEditingTemplate] = React.useState<MaterialTemplate | null>(null);
  const [editingComponent, setEditingComponent] = React.useState<MaterialComponent | null>(null);
  const [editingState, setEditingState] = React.useState<MaterialState | null>(null);

  // Update active tab when initialTab prop changes
  React.useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Listen for tab change events from parent
  React.useEffect(() => {
    const handleTabChange = (e: any) => {
      if (e.detail?.tab) {
        setActiveTab(e.detail.tab);
      }
    };
    window.addEventListener('material-library-tab', handleTabChange);
    return () => window.removeEventListener('material-library-tab', handleTabChange);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (modeler) {
      loadMaterialData();
    }
  // eslint-disable-next-line no-use-before-define
  }, [modeler]);

  // ── Carrier-aware moddle accessors ───────────────────────────────────
  //
  // After the Process.xml-aligned restructure, MaterialState / MaterialStateType
  // / Composition / Stream all use DEXPI carriers (<dexpi:data property="X">,
  // <dexpi:references property="X" uidRef="..."/>, <dexpi:components
  // property="X"><dexpi:object>...). bpmn-moddle parses these into typed
  // arrays (parent.data, parent.references, parent.components) when the
  // wrapper class declares those slots; falls back to $children walking
  // for legacy bare-name content. These helpers handle both.

  /** Read a DataProperty body as text. Carrier form preferred, bare-name fallback. */
  const readData = (parent: any, propertyName: string): string => {
    if (!parent) return '';
    if (Array.isArray(parent.data)) {
      for (const d of parent.data) {
        const prop = d.property ?? d.$attrs?.property;
        if (prop === propertyName) return d.body ?? d.$body ?? d._ ?? '';
      }
    }
    if (parent.$children) {
      for (const c of parent.$children) {
        const t = (c.$type || '').toLowerCase();
        if ((t === 'dexpi:data' || t === 'data') &&
            (c.property === propertyName || c.$attrs?.property === propertyName)) {
          return c.body ?? c.$body ?? c._ ?? '';
        }
      }
      const bare = parent.$children.find((c: any) => c.$type === propertyName);
      if (bare) return bare.$body || '';
    }
    return '';
  };

  /** Read a ReferenceProperty's uidRef. Carrier form preferred, bare-name fallback. */
  const readRef = (parent: any, propertyName: string): string => {
    if (!parent) return '';
    if (Array.isArray(parent.references)) {
      for (const r of parent.references) {
        const prop = r.property ?? r.$attrs?.property;
        if (prop === propertyName) {
          return r.uidRef ?? r.$attrs?.uidRef ??
            (r.objects ?? '').replace(/^#/, '') ?? '';
        }
      }
    }
    if (parent.$children) {
      for (const c of parent.$children) {
        const t = (c.$type || '').toLowerCase();
        if ((t === 'dexpi:references' || t === 'references') &&
            (c.property === propertyName || c.$attrs?.property === propertyName)) {
          return c.uidRef ?? c.$attrs?.uidRef ?? '';
        }
        if (c.$type === propertyName) return c.uidRef ?? c.$attrs?.uidRef ?? '';
      }
    }
    return '';
  };

  /**
   * Locate the inner <dexpi:object> of a Components carrier with the given
   * property name. Used to read QualifiedValue payloads.
   */
  const readComponentsObject = (parent: any, propertyName: string): any => {
    if (!parent) return null;
    if (Array.isArray(parent.components)) {
      for (const carrier of parent.components) {
        const prop = carrier.property ?? carrier.$attrs?.property;
        if (prop !== propertyName) continue;
        const obj = (carrier.objects ?? carrier.$children ?? []).find((o: any) =>
          (o.$type || '').toLowerCase().includes('object')
        );
        if (obj) return obj;
      }
    }
    if (parent.$children) {
      for (const carrier of parent.$children) {
        const t = (carrier.$type || '').toLowerCase();
        if ((t === 'dexpi:components' || t === 'components') &&
            (carrier.property ?? carrier.$attrs?.property) === propertyName) {
          const obj = (carrier.$children ?? []).find((o: any) =>
            (o.$type || '').toLowerCase().includes('object')
          );
          if (obj) return obj;
        }
      }
    }
    return null;
  };

  /**
   * Read a QualifiedValue's typed Values + Unit. Returns multi-valued vector
   * for PhysicalQuantityVector targets; for scalar QualifiedValue,
   * `values[0]` is the single value.
   */
  const readQualifiedValueVector = (qvObj: any): { values: string[]; unit: string } => {
    if (!qvObj) return { values: [], unit: '' };
    const dataList = qvObj.data ?? qvObj.$children ?? [];
    const values: string[] = [];
    let unit = '';
    for (const d of dataList) {
      const t = (d.$type || '').toLowerCase();
      if (t && t !== 'dexpi:data' && t !== 'data') continue;
      const prop = d.property ?? d.$attrs?.property;
      const body = d.body ?? d.$body ?? d._ ?? '';
      if (prop === 'Value' || prop === 'Values') values.push(body);
      else if (prop === 'Unit') unit = body;
    }
    return { values, unit };
  };

  const loadMaterialData = () => {
    const elementRegistry = modeler.get('elementRegistry');
    const allElements = elementRegistry.getAll();

    // Find MaterialTemplates DataObjectReference
    const templatesDataObj = allElements.find((el: any) => 
      el.type === 'bpmn:DataObjectReference' && 
      el.businessObject.name === 'MaterialTemplates'
    );

    const loadedTemplates: MaterialTemplate[] = [];
    const loadedComponents: MaterialComponent[] = [];

    // Helper functions to extract text from a moddle parent. Prefers
    // carrier-wrapped form first via the typed `data` array bpmn-moddle
    // now exposes for classes that declared `data` as a child slot
    // (MaterialState, MaterialStateType, Stream, etc.); falls back to
    // walking $children for legacy bare-name <X>v</X> content.
    const getChildText = (parent: any, childType: string): string => {
      if (!parent) return '';
      // Typed accessor (preferred for carrier-form parents)
      if (Array.isArray(parent.data)) {
        for (const d of parent.data) {
          const prop = d.property ?? d.$attrs?.property;
          if (prop === childType) return d.body ?? d.$body ?? d._ ?? '';
        }
      }
      // $children form fallback (carriers under opaque pass-through, or
      // legacy bare-name children).
      if (parent.$children) {
        for (const c of parent.$children) {
          const t = (c.$type || '').toLowerCase();
          if ((t === 'dexpi:data' || t === 'data') &&
              (c.property === childType || c.$attrs?.property === childType)) {
            return c.body ?? c.$body ?? c._ ?? '';
          }
        }
        const bareChild = parent.$children.find((c: any) => c.$type === childType);
        if (bareChild) return bareChild.$body || '';
      }
      return '';
    };

    const getChildValue = (parent: any, childType: string): number => {
      const text = getChildText(parent, childType);
      return parseInt(text) || 0;
    };

    if (templatesDataObj?.businessObject?.extensionElements?.values) {
      templatesDataObj.businessObject.extensionElements.values.forEach((val: any) => {
        if (val.$type === 'MaterialTemplate' || val.$type?.includes('MaterialTemplate')) {
          // Component refs: canonical form is <dexpi:references
          // property="ListOfComponents" objects="#X #Y..."/> or uidRef
          // (space-separated multi-valued). Legacy form is the bare-name
          // <ListOfMaterialComponents> wrapper with
          // <MaterialComponentIdentifier uidRef="..."/> children. We accept
          // both for back-compat with older saves.
          const componentRefs: string[] = [];
          // Carrier form: typed `references` array on dexpi:MaterialTemplate.
          if (Array.isArray(val.references)) {
            for (const r of val.references) {
              if ((r.property ?? r.$attrs?.property) === 'ListOfComponents') {
                const ids = r.objects ?? r.uidRef ?? '';
                for (const tok of ids.split(/\s+/).filter(Boolean)) {
                  componentRefs.push(tok.replace(/^#/, ''));
                }
              }
            }
          }
          // Legacy bare-name fallback.
          if (componentRefs.length === 0) {
            const listOfComponents = val.$children?.find((c: any) =>
              c.$type === 'ListOfComponents' ||
              c.$type === 'ListOfMaterialComponents' ||
              c.$type?.includes('ListOfMaterialComponents')
            );
            if (listOfComponents?.$children) {
              listOfComponents.$children.forEach((child: any) => {
                if (child.$type === 'Component' ||
                    child.$type === 'MaterialComponentIdentifier' ||
                    child.$type?.includes('MaterialComponentIdentifier')) {
                  const uidRef = child.uidRef || child.$attrs?.uidRef;
                  if (uidRef) componentRefs.push(uidRef);
                }
              });
            }
          }

          // PhaseLabel: canonical is repeated <dexpi:data property="PhaseLabel">v</dexpi:data>
          // siblings; legacy was <ListOfPhases><PhaseIdentifier Identifier="X"/>...
          const phases: string[] = [];
          if (Array.isArray(val.data)) {
            for (const d of val.data) {
              if ((d.property ?? d.$attrs?.property) === 'PhaseLabel') {
                const body = d.body ?? d.$body ?? d._ ?? '';
                if (body) phases.push(body);
              }
            }
          }
          if (phases.length === 0 && val.$children) {
            for (const c of val.$children) {
              if (c.$type === 'PhaseLabel') {
                const body = c.$body || c.body || '';
                if (body) phases.push(body);
              } else if (c.$type === 'ListOfPhases' && c.$children) {
                for (const p of c.$children) {
                  if ((p.$type || '').toLowerCase().includes('phaseidentifier')) {
                    const id = p.Identifier ?? p.$attrs?.Identifier;
                    if (id) phases.push(id);
                  }
                }
              }
            }
          }

          const template = {
            uid: val.uid || '',
            identifier: getChildText(val, 'Identifier'),
            label: getChildText(val, 'Label'),
            description: getChildText(val, 'Description'),
            numberOfComponents: getChildValue(val, 'NumberOfMaterialComponents'),
            numberOfPhases: getChildValue(val, 'NumberOfPhases'),
            componentRefs: componentRefs,
            phases,
          };
          loadedTemplates.push(template);
        }
        if (val.$type === 'MaterialComponent' || val.$type?.includes('MaterialComponent')) {
          // Check for xsi:type attribute - it can be stored in various ways in the moddle
          const xsiType = val.$attrs?.['xsi:type'] || val['xsi:type'] ||
                         (val.$type === 'dexpi:PureMaterialComponent' ? 'PureMaterialComponent' : null);

          // Walk children to capture every property beyond the structural
          // typed fields (Identifier / Label / Description) into the generic
          // `properties[]` array. Schema-declared properties for the
          // concrete class — ChEBI_identifier / IUPAC_identifier on
          // PureMaterialComponent, ProjectReference on CustomMaterialComponent —
          // and project-extension thermo data (MolecularWeight, AntoineA,
          // IsEffectivelyNoncondensable, …) all flow through the same shape so
          // the schema-driven editor in MaterialEditorPanel can render them
          // from a single registry-derived loop.
          const STRUCTURAL_DATA = new Set(['Identifier', 'Label', 'Description']);
          const properties: MaterialComponent['properties'] = [];
          const dataChildren = Array.isArray(val.data) ? val.data : [];
          for (const d of dataChildren) {
            const propName = d.property ?? d.$attrs?.property ?? '';
            if (!propName || STRUCTURAL_DATA.has(propName)) continue;
            const text = (d.body ?? d.$body ?? '').toString().trim();
            if (!text) continue;
            properties.push({ kind: 'data', name: propName, value: text });
          }
          const componentsChildren = Array.isArray(val.components) ? val.components : [];
          for (const carrier of componentsChildren) {
            const propName = carrier.property ?? carrier.$attrs?.property ?? '';
            if (!propName) continue;
            const objs = carrier.objects ?? carrier.$children ?? [];
            const qv = (Array.isArray(objs) ? objs : []).find((o: any) =>
              (o.$type || '').toLowerCase().includes('object') &&
              (o.type === 'Core/QualifiedValue' || o.$attrs?.type === 'Core/QualifiedValue')
            );
            if (!qv) continue;
            const qvData = Array.isArray(qv.data) ? qv.data : (qv.$children ?? []);
            let value = '';
            let unit: string | undefined;
            let unitReference: string | undefined;
            for (const dc of qvData) {
              const dp = dc.property ?? dc.$attrs?.property;
              const dv = (dc.body ?? dc.$body ?? '').toString().trim();
              if (dp === 'Value') value = dv;
              else if (dp === 'Unit') unit = dv;
              else if (dp === 'UnitReference') unitReference = dv;
            }
            // QuantityKindReference (the canonical attribute-URI carrier)
            // sits as a sibling References child on the same QV Object,
            // not as a Data child — same encoding the ProcessStep / Stream
            // attribute editors emit.
            const qvRefs = Array.isArray(qv.references) ? qv.references : [];
            let nameUri: string | undefined;
            for (const r of qvRefs) {
              const rp = r.property ?? r.$attrs?.property;
              if (rp === 'QuantityKindReference') {
                nameUri = r.objects ?? r.uidRef ?? r.$attrs?.objects ?? r.$attrs?.uidRef;
                break;
              }
            }
            if (!value) continue;
            properties.push({ kind: 'composition', name: propName, value, unit, unitReference, nameUri });
          }

          const component: MaterialComponent = {
            uid: val.uid || '',
            identifier: getChildText(val, 'Identifier'),
            label: getChildText(val, 'Label'),
            description: getChildText(val, 'Description'),
            type: (xsiType === 'PureMaterialComponent' ? 'PureMaterialComponent' : 'CustomMaterialComponent') as MaterialComponent['type'],
            properties: properties.length > 0 ? properties : undefined,
          };
          loadedComponents.push(component);
        }
      });
    }

    // Load states from ALL DataObjectReference elements with MaterialStates
    const allStateDataObjs = allElements.filter((el: any) => 
      el.type === 'bpmn:DataObjectReference' && 
      (el.businessObject.name?.includes('MaterialStates') || el.businessObject.name === 'MaterialStates')
    );

    const loadedStates: MaterialState[] = [];
    const groupedStates: { [key: string]: MaterialState[] } = {};
    const initialExpandedState: { [key: string]: boolean } = {};

    // Build maps of which streams reference which states + which template
    // each state's host stream uses. The MaterialTemplate reference lives
    // on the Stream (canonical direction); when an editor needs to display
    // per-component fractions for a state, we look up the state's host
    // stream's template to align fraction indices with component uids.
    const streamsByState: { [uid: string]: string[] } = {};
    const templateByState: { [uid: string]: string } = {};
    allElements.forEach((el: any) => {
      if (el.type === 'bpmn:SequenceFlow' && el.businessObject?.extensionElements?.values) {
        el.businessObject.extensionElements.values.forEach((ext: any) => {
          if (ext.$type === 'Stream' || ext.$type?.includes('Stream')) {
            const stateRef = readRef(ext, 'MaterialStateReference');
            if (stateRef) {
              if (!streamsByState[stateRef]) streamsByState[stateRef] = [];
              const streamName = el.businessObject.name || readData(ext, 'Identifier') || el.id;
              streamsByState[stateRef].push(streamName);
              const templateRef = readRef(ext, 'MaterialTemplateReference');
              if (templateRef && !templateByState[stateRef]) {
                templateByState[stateRef] = templateRef;
              }
            }
          }
        });
      }
    });

    /**
     * Build a MaterialState record by following the Process.xml-aligned
     * MaterialState → MaterialStateType → Composition chain. siblings is
     * the array of all DataObject extension entries within the same scope
     * (Case or extensionElements directly), used to resolve uid references.
     */
    const buildState = (stateVal: any, siblings: any[], groupName: string): MaterialState => {
      const stateTypeUid = readRef(stateVal, 'State');
      const stateType = stateTypeUid
        ? siblings.find((v: any) => v.uid === stateTypeUid)
        : null;
      const compositionUid = stateType ? readRef(stateType, 'Composition') : '';
      const composition = compositionUid
        ? siblings.find((v: any) => v.uid === compositionUid)
        : null;

      // MoleFlow scalar lives on MaterialStateType (Profile-extension fill
      // for DEXPI 2.0's vocabulary gap). Read via the Components carrier.
      let moleFlow: { value: number; unit: string } | undefined;
      if (stateType) {
        const moleFlowQv = readComponentsObject(stateType, 'MoleFlow');
        if (moleFlowQv) {
          const { values, unit } = readQualifiedValueVector(moleFlowQv);
          if (values[0]) moleFlow = { value: parseFloat(values[0]) || 0, unit };
        }
      }

      // Composition's per-component fractions live on Composition.MoleFractiona
      // (sic — Process.xml typo) / MassFractions / VolumeFractions, encoded
      // as a multi-valued PhysicalQuantityVector inside QualifiedValue.
      // Each fraction is paired with its MaterialComponent uid via the
      // host Stream's MaterialTemplateReference (lookup at index N matches
      // the template's ListOfComponents at index N).
      let basis = '';
      let fractionUnit = 'Fraction';
      let rawFractionValues: number[] = [];
      let display = '';
      if (composition) {
        display = readData(composition, 'Display');
        for (const [propName, basisLabel] of [
          ['MoleFractiona', 'Mole'],
          ['MassFractions', 'Mass'],
          ['VolumeFractions', 'Volume'],
        ] as const) {
          const qv = readComponentsObject(composition, propName);
          if (qv) {
            basis = basisLabel;
            const { values, unit } = readQualifiedValueVector(qv);
            rawFractionValues = values.map(v => parseFloat(v) || 0);
            if (unit) fractionUnit = unit;
            break;
          }
        }
      }
      // Legacy inline-Flow fallback (for fixtures saved before the
      // MaterialState restructure). Runs BEFORE the rich-object mapping
      // so it can contribute raw values to rawFractionValues, which then
      // get paired with component refs in a single mapping step below.
      if (!moleFlow || rawFractionValues.length === 0) {
        const flowChild = stateVal.$children?.find((c: any) => c.$type === 'Flow');
        if (flowChild) {
          const moleFlowChild = flowChild.$children?.find((c: any) => c.$type === 'MoleFlow');
          if (moleFlowChild && !moleFlow) {
            moleFlow = {
              value: parseFloat(moleFlowChild.$children?.find((c: any) => c.$type === 'Value')?.$body || '0'),
              unit: moleFlowChild.$children?.find((c: any) => c.$type === 'Unit')?.$body || '',
            };
          }
          const compositionChild = flowChild.$children?.find((c: any) => c.$type === 'Composition');
          if (compositionChild && rawFractionValues.length === 0) {
            display = display || compositionChild.$children?.find((c: any) => c.$type === 'Display')?.$body || '';
            basis = basis || compositionChild.$children?.find((c: any) => c.$type === 'Basis')?.$body || '';
            rawFractionValues = (compositionChild.$children
              ?.filter((c: any) => c.$type === 'Fraction')
              .map((f: any) =>
                parseFloat(f.$children?.find((c: any) => c.$type === 'Value')?.$body || '0'))) || [];
          }
        }
      }

      // Resolve component refs for this state via the host stream's template.
      const templateUid = templateByState[stateVal.uid];
      const template = templateUid
        ? loadedTemplates.find(t => t.uid === templateUid)
        : undefined;
      const componentRefs = template?.componentRefs || [];
      const fractions = rawFractionValues.map((value, i) => ({
        componentReference: componentRefs[i] || '',
        value,
        unit: fractionUnit,
      }));

      return {
        uid: stateVal.uid || '',
        identifier: readData(stateVal, 'Identifier') || getChildText(stateVal, 'Identifier'),
        label: readData(stateVal, 'Label') || getChildText(stateVal, 'Label'),
        description: readData(stateVal, 'Description') || getChildText(stateVal, 'Description'),
        flow: (moleFlow || fractions.length > 0) ? {
          moleFlow,
          composition: (display || fractions.length > 0) ? { basis, display, fractions } : undefined,
        } : undefined,
        templateRef: undefined, // No longer carried on MaterialState (redundant inverse ref dropped during restructure)
        streamRef: undefined,   // Same (Stream → MaterialStateReference is the canonical direction)
        referencedByStreams: streamsByState[stateVal.uid] || [],
        // Track the case for grouping; used by the caller to push into groupedStates.
        ...(groupName ? { _caseName: groupName } : {}),
      } as MaterialState;
    };

    allStateDataObjs.forEach((statesDataObj: any) => {
      if (statesDataObj?.businessObject?.extensionElements?.values) {
        const extValues = statesDataObj.businessObject.extensionElements.values;

        // Check if we have new Case structure or legacy direct MaterialStates
        const hasCaseElements = extValues.some((v: any) => v.$type === 'Case' || v.$type === 'dexpi:Case');
        
        if (hasCaseElements) {
          // NEW STRUCTURE: Process Case elements containing CaseName and MaterialStates
          extValues.forEach((val: any) => {
            if (val.$type === 'Case' || val.$type === 'dexpi:Case') {
              // Extract case name from nested CaseName element
              const caseNameElement = val.$children?.find((c: any) => c.$type === 'CaseName' || c.$type === 'dexpi:CaseName');
              const groupName = caseNameElement?.$body || 'Unnamed Case';
              
              if (!groupedStates[groupName]) {
                groupedStates[groupName] = [];
                initialExpandedState[groupName] = true;
              }

              // Extract MaterialStates from this Case. Siblings for State /
              // Composition uid resolution are the Case's own children
              // (where MaterialStateType + Composition blocks live alongside
              // the MaterialStates).
              const caseSiblings = val.$children || [];
              const statesInCase = caseSiblings.filter((c: any) =>
                (c.$type === 'MaterialState' ||
                  (c.$type?.includes('MaterialState') && !c.$type?.includes('MaterialStateType')))
              );
              statesInCase.forEach((stateVal: any) => {
                const state = buildState(stateVal, caseSiblings, groupName);
                loadedStates.push(state);
                groupedStates[groupName].push(state);
              });
            }
          });
        } else {
          // LEGACY STRUCTURE: MaterialStates directly in extensionElements
          // Get case name from standalone CaseName element or DataObject name
          let groupName = statesDataObj.businessObject.name || 'Material States';
          const caseNameElement = extValues.find((v: any) => v.$type === 'CaseName' || v.$type === 'dexpi:CaseName');
          if (caseNameElement && caseNameElement.$body) {
            groupName = caseNameElement.$body;
          }
          
          if (!groupedStates[groupName]) {
            groupedStates[groupName] = [];
            initialExpandedState[groupName] = true;
          }

          // Extract MaterialStates directly from extensionElements. Sibling
          // resolution scope is the DataObject's full extension values
          // array (where MaterialStateType + Composition entries also live).
          extValues.forEach((val: any) => {
            if (val.$type === 'MaterialState' ||
                (val.$type?.includes('MaterialState') && !val.$type?.includes('MaterialStateType'))) {
              const state = buildState(val, extValues, groupName);
              loadedStates.push(state);
              groupedStates[groupName].push(state);
            }
          });
        }
      }
    });

    setTemplates(loadedTemplates);
    setComponents(loadedComponents);
    setStates(loadedStates);
    setStateGroups(groupedStates);
    setExpandedGroups(initialExpandedState);
  };

  const addTemplate = () => {
    const newTemplate: MaterialTemplate = {
      uid: `uuid_template_${Date.now()}`,
      identifier: `Template_${templates.length + 1}`,
      label: `New Template ${templates.length + 1}`,
      description: '',
      numberOfComponents: 0,
      numberOfPhases: 0,
      componentRefs: [],
      phases: []
    };
    setEditingTemplate(newTemplate);
  };

  const saveTemplate = (template: MaterialTemplate) => {
    const updatedTemplates = editingTemplate && templates.find(t => t.uid === editingTemplate.uid)
      ? templates.map(t => t.uid === template.uid ? template : t)
      : [...templates, template];
    
    setTemplates(updatedTemplates);
    saveMaterialData(updatedTemplates, components, states);
    setEditingTemplate(null);
  };

  const deleteTemplate = (uid: string) => {
    if (confirm('Delete this template?')) {
      const updatedTemplates = templates.filter(t => t.uid !== uid);
      setTemplates(updatedTemplates);
      saveMaterialData(updatedTemplates, components, states);
    }
  };

  const addComponent = () => {
    const newComponent: MaterialComponent = {
      uid: `uuid_component_${Date.now()}`,
      identifier: `Component_${components.length + 1}`,
      label: `New Component ${components.length + 1}`,
      description: '',
      type: 'CustomMaterialComponent'
    };
    setEditingComponent(newComponent);
  };

  const saveComponent = (component: MaterialComponent) => {
    const updatedComponents = editingComponent && components.find(c => c.uid === editingComponent.uid)
      ? components.map(c => c.uid === component.uid ? component : c)
      : [...components, component];
    
    setComponents(updatedComponents);
    saveMaterialData(templates, updatedComponents, states);
    setEditingComponent(null);
  };

  const deleteComponent = (uid: string) => {
    if (confirm('Delete this component?')) {
      const updatedComponents = components.filter(c => c.uid !== uid);
      setComponents(updatedComponents);
      saveMaterialData(templates, updatedComponents, states);
    }
  };

  const addState = () => {
    const newState: MaterialState = {
      uid: `uuid_state_${Date.now()}`,
      identifier: `State_${states.length + 1}`,
      label: `New State ${states.length + 1}`,
      description: '',
      flow: {
        moleFlow: { value: 0, unit: 'KilomolePerHour' },
        composition: { basis: 'Mole', display: 'Fraction', fractions: [] }
      }
    };
    setEditingState(newState);
  };

  const addCase = () => {
    const caseName = prompt('Enter name for new material states case:', 'New Case');
    if (!caseName) return;

    const elementRegistry = modeler.get('elementRegistry');
    const modeling = modeler.get('modeling');
    const moddle = modeler.get('moddle');
    
    // Find or create the MaterialStates DataObjectReference
    const allElements = elementRegistry.getAll();
    let statesDataObj = allElements.find((el: any) => 
      el.type === 'bpmn:DataObjectReference' && 
      (el.businessObject.name === 'MaterialStates' || 
       el.businessObject.name?.includes('MaterialStates'))
    );

    if (!statesDataObj) {
      // Create new MaterialStates DataObjectReference if it doesn't exist
      const canvas = modeler.get('canvas');
      const rootElement = canvas.getRootElement();
      const process = rootElement.businessObject;

      const dataObject = moddle.create('bpmn:DataObject', { id: `DataObject_${Date.now()}` });
      const dataObjectRef = moddle.create('bpmn:DataObjectReference', {
        id: `DataObjectReference_${Date.now()}`,
        name: 'MaterialStates',
        dataObjectRef: dataObject
      });

      const extensionElements = moddle.create('bpmn:ExtensionElements');
      extensionElements.values = [];
      dataObjectRef.extensionElements = extensionElements;

      if (!process.flowElements) {
        process.flowElements = [];
      }
      process.flowElements.push(dataObjectRef);

      statesDataObj = modeling.createShape(
        { type: 'bpmn:DataObjectReference', businessObject: dataObjectRef },
        { x: 100, y: 100 },
        rootElement
      );
    }

    // Create Case element with CaseName and empty states
    const bo = statesDataObj.businessObject;
    if (!bo.extensionElements) {
      bo.extensionElements = moddle.create('bpmn:ExtensionElements');
      bo.extensionElements.values = [];
    }

    const caseElement = moddle.create('dexpi:Case');
    const caseNameElement = moddle.create('dexpi:CaseName');
    caseNameElement.$body = caseName;
    
    caseElement.$children = [caseNameElement];
    
    bo.extensionElements.values.push(caseElement);

    // Update the model
    modeling.updateProperties(statesDataObj, {
      extensionElements: bo.extensionElements
    });

    // Reload data to show new case
    loadMaterialData();
  };

  const editCase = (currentName: string) => {
    const newName = prompt('Enter new name for this material states case:', currentName);
    if (!newName || newName === currentName) return;

    const elementRegistry = modeler.get('elementRegistry');
    const modeling = modeler.get('modeling');
    const moddle = modeler.get('moddle');

    // Find the MaterialStates DataObjectReference
    const allElements = elementRegistry.getAll();
    const statesDataObj = allElements.find((el: any) => 
      el.type === 'bpmn:DataObjectReference' && 
      (el.businessObject.name === 'MaterialStates' || 
       el.businessObject.name?.includes('MaterialStates') ||
       el.businessObject.name === currentName)
    );

    if (statesDataObj) {
      const bo = statesDataObj.businessObject;
      
      if (!bo.extensionElements || !bo.extensionElements.values) return;
      
      const extValues = bo.extensionElements.values;
      const hasCaseElements = extValues.some((v: any) => v.$type === 'Case' || v.$type === 'dexpi:Case');
      
      if (hasCaseElements) {
        // NEW STRUCTURE: Find and update Case element
        const caseElement = extValues.find((v: any) => {
          if (v.$type === 'Case' || v.$type === 'dexpi:Case') {
            const caseNameElement = v.$children?.find((c: any) => c.$type === 'CaseName' || c.$type === 'dexpi:CaseName');
            return caseNameElement?.$body === currentName;
          }
          return false;
        });

        if (caseElement) {
          const caseNameElement = caseElement.$children?.find((c: any) => c.$type === 'CaseName' || c.$type === 'dexpi:CaseName');
          if (caseNameElement) {
            caseNameElement.$body = newName;
            
            modeling.updateProperties(statesDataObj, {
              extensionElements: bo.extensionElements
            });
            
            setTimeout(() => {
              loadMaterialData();
            }, 50);
          }
        }
      } else {
        // LEGACY STRUCTURE: Find or create standalone CaseName element
        let caseNameElement = extValues.find((v: any) => v.$type === 'CaseName' || v.$type === 'dexpi:CaseName');
        
        if (caseNameElement) {
          // Update existing CaseName
          caseNameElement.$body = newName;
        } else {
          // Create new CaseName element
          caseNameElement = moddle.create('dexpi:CaseName');
          caseNameElement.$body = newName;
          bo.extensionElements.values = [caseNameElement, ...bo.extensionElements.values];
        }
        
        modeling.updateProperties(statesDataObj, {
          extensionElements: bo.extensionElements
        });
        
        setTimeout(() => {
          loadMaterialData();
        }, 50);
      }
    }
  };

  const saveState = (state: MaterialState) => {
    const updatedStates = editingState && states.find(s => s.uid === editingState.uid)
      ? states.map(s => s.uid === state.uid ? state : s)
      : [...states, state];
    
    setStates(updatedStates);
    saveMaterialData(templates, components, updatedStates);
    setEditingState(null);
  };

  const deleteState = (uid: string) => {
    if (confirm('Delete this state?')) {
      const updatedStates = states.filter(s => s.uid !== uid);
      setStates(updatedStates);
      saveMaterialData(templates, components, updatedStates);
    }
  };

  const saveMaterialData = (
    updatedTemplates: MaterialTemplate[],
    updatedComponents: MaterialComponent[],
    _updatedStates: MaterialState[]
  ) => {
    const modeling = modeler.get('modeling');
    const moddle = modeler.get('moddle');
    const elementRegistry = modeler.get('elementRegistry');
    const elementFactory = modeler.get('elementFactory');
    
    // Find or create MaterialTemplates DataObjectReference
    let templatesDataObj = elementRegistry.getAll().find((el: any) => 
      el.type === 'bpmn:DataObjectReference' && 
      el.businessObject.name === 'MaterialTemplates'
    );

    if (!templatesDataObj) {
      // Create new DataObjectReference for templates
      const dataObject = elementFactory.createShape({ type: 'bpmn:DataObjectReference' });
      modeling.createShape(dataObject, { x: 100, y: 100 }, modeler.get('canvas').getRootElement());
      templatesDataObj = dataObject;
      modeling.updateProperties(templatesDataObj, { name: 'MaterialTemplates' });
    }

    // Update templates extensionElements
    let extensionElements = templatesDataObj.businessObject.extensionElements;
    if (!extensionElements) {
      extensionElements = moddle.create('bpmn:ExtensionElements');
    }

    const values: any[] = [];

    // Helper: build a <dexpi:data property="X">v</dexpi:data> moddle child.
    // Same shape used below for MaterialComponent and MaterialState.
    // Hoisted here so all three Material* save loops can share it; declared
    // before the first user.
    const buildDataChild = (property: string, body: string) =>
      moddle.create('dexpi:Data', { property, body });

    const buildReferenceChild = (property: string, uidRefOrObjects: string | string[]) => {
      // <dexpi:references property="..." uidRef="..."/> or, for multi-object
      // refs (e.g. ListOfComponents), <dexpi:references property="..." objects="#a #b ..."/>
      if (Array.isArray(uidRefOrObjects)) {
        return moddle.create('dexpi:References', {
          property,
          objects: uidRefOrObjects.map(u => `#${u}`).join(' '),
        });
      }
      return moddle.create('dexpi:References', { property, uidRef: uidRefOrObjects });
    };

    // Add templates.
    //
    // Same fix pattern as MaterialComponent below: replace the old
    // moddle.create('MaterialTemplate', { Identifier: ..., Label: ..., ...})
    // call (which silently produced XML attributes because the moddle
    // definition declares only uid as an attr) with explicit Data/References
    // children matching the canonical DEXPI form.
    updatedTemplates.forEach(template => {
      const dataChildren: unknown[] = [];
      if (template.identifier) dataChildren.push(buildDataChild('Identifier', template.identifier));
      if (template.label) dataChildren.push(buildDataChild('Label', template.label));
      if (template.description) dataChildren.push(buildDataChild('Description', template.description));
      if (template.numberOfComponents != null) dataChildren.push(buildDataChild('NumberOfMaterialComponents', String(template.numberOfComponents)));
      if (template.numberOfPhases != null) dataChildren.push(buildDataChild('NumberOfPhases', String(template.numberOfPhases)));
      // Phase labels: each as a separate <dexpi:data property="PhaseLabel">v</dexpi:data>
      // (canonical form for multi-valued DataProperty per Process.xml).
      for (const phase of template.phases ?? []) {
        if (phase) dataChildren.push(buildDataChild('PhaseLabel', phase));
      }

      const referencesChildren: unknown[] = [];
      // Component references: List of MaterialComponent uids → multi-target
      // ReferenceProperty serialised as <dexpi:references property="..." objects="#u1 #u2 ..."/>.
      const componentUidRefs = (template.componentRefs ?? [])
        .map(r => typeof r === 'string' ? r : r.uidRef)
        .filter((u): u is string => Boolean(u));
      if (componentUidRefs.length > 0) {
        referencesChildren.push(buildReferenceChild('ListOfComponents', componentUidRefs));
      }

      const moddleProps: Record<string, unknown> = { uid: template.uid };
      if (dataChildren.length > 0) moddleProps.data = dataChildren;
      if (referencesChildren.length > 0) moddleProps.references = referencesChildren;

      const templateElement = moddle.create('dexpi:MaterialTemplate', moddleProps);
      values.push(templateElement);
    });

    // Add components.
    //
    // Important: passing canonical-field names like Identifier / Label /
    // Description as named props to moddle.create('MaterialComponent', {…})
    // serialises them as XML *attributes* on the <dexpi:materialComponent>
    // element (because the moddle definition doesn't declare them as Data
    // sub-element properties — only `data`, `references`, `components` are
    // declared). The transformer expects them as <dexpi:data property="X">v
    // </dexpi:data> children, so the legacy attribute form was being silently
    // dropped on every save through this panel.
    //
    // Reuses buildDataChild defined above for the templates loop. Adds a
    // QualifiedValue-shaped Components carrier helper specific to the
    // MaterialComponent + MaterialState save paths.
    const buildQualifiedValueComponentsChild = (
      property: string,
      value: string,
      unit?: string,
      unitReference?: string,
      nameUri?: string,
    ) => {
      const qvData: unknown[] = [buildDataChild('Value', value)];
      // DisplayText (lower=1 on Core/QualifiedValue per Core.xml). Derive
      // deterministically from value + unit, mirroring transformer.ts:2237.
      const displayText = unit ? `${value} ${unit}` : value;
      qvData.push(buildDataChild('DisplayText', displayText));
      if (unit) qvData.push(buildDataChild('Unit', unit));
      if (unitReference) qvData.push(buildDataChild('UnitReference', unitReference));
      const qvObjectProps: Record<string, unknown> = {
        type: 'Core/QualifiedValue',
        data: qvData,
      };
      // nameUri → canonical QuantityKindReference carrier inside the QV
      // Object. Mirrors the same encoding ProcessStep / Stream attribute
      // editors emit (BpmnToDexpiTransformer.ts:2261, 2576).
      if (nameUri) {
        qvObjectProps.references = [
          moddle.create('dexpi:References', {
            property: 'QuantityKindReference',
            objects: nameUri,
          }),
        ];
      }
      const qvObject = moddle.create('dexpi:Object', qvObjectProps);
      return moddle.create('dexpi:Components', {
        property,
        objects: [qvObject],
      });
    };

    updatedComponents.forEach(component => {
      const dataChildren: unknown[] = [];
      // Identifier / Label / Description stay as typed structural fields on
      // MaterialComponent because they're used as cross-reference targets
      // and list-display labels throughout the codebase. Every other DEXPI
      // DataProperty (ChEBI_identifier on PureMaterialComponent,
      // ProjectReference on CustomMaterialComponent, project-extension
      // thermo data) flows through the generic `properties[]` loop below
      // — keeps the editor schema-driven and the save path data-shape-agnostic.
      if (component.identifier) dataChildren.push(buildDataChild('Identifier', component.identifier));
      if (component.label) dataChildren.push(buildDataChild('Label', component.label));
      if (component.description) dataChildren.push(buildDataChild('Description', component.description));

      const componentsChildren: unknown[] = [];
      if (component.properties) {
        for (const p of component.properties) {
          if (p.kind === 'data') {
            dataChildren.push(buildDataChild(p.name, p.value));
          } else {
            componentsChildren.push(
              buildQualifiedValueComponentsChild(p.name, p.value, p.unit, p.unitReference, p.nameUri),
            );
          }
        }
      }

      const moddleProps: Record<string, unknown> = {
        'xsi:type': component.type,
        uid: component.uid,
      };
      if (dataChildren.length > 0) moddleProps.data = dataChildren;
      if (componentsChildren.length > 0) moddleProps.components = componentsChildren;

      const componentElement = moddle.create('dexpi:MaterialComponent', moddleProps);
      values.push(componentElement);
    });

    extensionElements.values = values;
    modeling.updateProperties(templatesDataObj, { extensionElements });

    // Find or create MaterialStates DataObjectReference
    let statesDataObj = elementRegistry.getAll().find((el: any) => 
      el.type === 'bpmn:DataObjectReference' && 
      (el.businessObject.name === 'Base Case MaterialStates' || el.businessObject.name === 'MaterialStates')
    );

    if (!statesDataObj) {
      const dataObject = elementFactory.createShape({ type: 'bpmn:DataObjectReference' });
      modeling.createShape(dataObject, { x: 100, y: 200 }, modeler.get('canvas').getRootElement());
      statesDataObj = dataObject;
      modeling.updateProperties(statesDataObj, { name: 'MaterialStates' });
    }

    // Update states extensionElements with Case structure
    let statesExtensionElements = statesDataObj.businessObject.extensionElements;
    if (!statesExtensionElements) {
      statesExtensionElements = moddle.create('bpmn:ExtensionElements');
    }

    // Group states by case name (from stateGroups state variable)
    const caseElements: any[] = [];
    Object.entries(stateGroups).forEach(([caseName, statesInCase]) => {
      const caseElement = moddle.create('dexpi:Case');
      const caseNameElement = moddle.create('dexpi:CaseName');
      caseNameElement.$body = caseName;
      
      // Same fix pattern: build canonical Data + References + Components
      // children explicitly. The legacy code passed Identifier/Label/Description/
      // Flow/TemplateReference/StreamReference as named props to moddle.create,
      // which (per the moddle MaterialState definition declaring none of those
      // as attrs) silently produced XML attributes the transformer can't read.
      const buildQVComponents = (
        property: string,
        value: string,
        unit?: string,
      ): unknown => {
        const qvData: unknown[] = [
          buildDataChild('Value', value),
          buildDataChild('DisplayText', unit ? `${value} ${unit}` : value),
        ];
        if (unit) qvData.push(buildDataChild('Unit', unit));
        return moddle.create('dexpi:Components', {
          property,
          objects: [
            moddle.create('dexpi:Object', {
              type: 'Core/QualifiedValue',
              data: qvData,
            }),
          ],
        });
      };

      const materialStates = (statesInCase as MaterialState[]).map(state => {
        const dataChildren: unknown[] = [];
        if (state.identifier) dataChildren.push(buildDataChild('Identifier', state.identifier));
        if (state.label) dataChildren.push(buildDataChild('Label', state.label));
        if (state.description) dataChildren.push(buildDataChild('Description', state.description));

        const componentsChildren: unknown[] = [];
        // Scalar MoleFlow as its own QualifiedValue carrier.
        if (state.flow?.moleFlow?.value != null) {
          componentsChildren.push(
            buildQVComponents(
              'MoleFlow',
              String(state.flow.moleFlow.value),
              state.flow.moleFlow.unit,
            ),
          );
        }
        // Composition: nested Components carrier with a Core/QualifiedValue
        // Object holding a multi-valued <Data property="Values">…</Data> per
        // fraction (canonical DEXPI shape for vector quantities, mirroring
        // the existing fixture form).
        if (state.flow?.composition && state.flow.composition.fractions.length > 0) {
          const fracData: unknown[] = state.flow.composition.fractions.map(f =>
            buildDataChild('Values', String(f.value)),
          );
          fracData.push(buildDataChild('Unit', state.flow.composition.fractions[0]?.unit ?? 'Fraction'));
          // Display + Basis live as flat data props on the Composition object's
          // canonical form; we approximate the existing fixture shape here.
          componentsChildren.push(moddle.create('dexpi:Components', {
            property: 'Composition',
            objects: [
              moddle.create('dexpi:Object', {
                type: 'Core/QualifiedValue',
                data: fracData,
              }),
            ],
          }));
        }

        const referencesChildren: unknown[] = [];
        if (state.templateRef) referencesChildren.push(buildReferenceChild('MaterialTemplateReference', state.templateRef));
        if (state.streamRef) referencesChildren.push(buildReferenceChild('StreamReference', state.streamRef));

        const moddleProps: Record<string, unknown> = { uid: state.uid };
        if (dataChildren.length > 0) moddleProps.data = dataChildren;
        if (componentsChildren.length > 0) moddleProps.components = componentsChildren;
        if (referencesChildren.length > 0) moddleProps.references = referencesChildren;

        return moddle.create('dexpi:MaterialState', moddleProps);
      });
      
      caseElement.$children = [caseNameElement, ...materialStates];
      caseElements.push(caseElement);
    });

    statesExtensionElements.values = caseElements;
    modeling.updateProperties(statesDataObj, { extensionElements: statesExtensionElements });
  };

  return (
    <div className="material-library">
      <h2>Material Library</h2>
      
      <div className="tabs">
        <button 
          className={activeTab === 'templates' ? 'active' : ''} 
          onClick={() => { setActiveTab('templates'); setSelectedTemplate(null); }}
        >
          Templates ({templates.length})
        </button>
        <button 
          className={activeTab === 'states' ? 'active' : ''} 
          onClick={() => { setActiveTab('states'); setSelectedTemplate(null); }}
        >
          States ({states.length})
        </button>
      </div>

      {activeTab === 'templates' && (
        <div className="templates-section" style={{ display: 'flex', gap: '10px', height: 'calc(100vh - 200px)' }}>
          <div style={{ flex: selectedTemplate ? '0 0 45%' : '1', overflowY: 'auto' }}>
            <button onClick={addTemplate} className="btn-add">+ Add Template</button>
            <div className="material-list">
              {templates.map(template => (
                <div 
                  key={template.uid} 
                  className={`item ${selectedTemplate?.uid === template.uid ? 'item-selected' : ''}`}
                  onClick={() => {
                    setSelectedTemplate(template);
                    onSelectItem?.({ type: 'template', data: template });
                  }}
                >
                  <div className="item-header">
                    <strong>{template.label}</strong>
                    <div className="item-actions">
                      <button 
                        onClick={(e) => { e.stopPropagation(); deleteTemplate(template.uid); }} 
                        className="btn-icon" 
                        title="Delete"
                      >🗑️</button>
                    </div>
                  </div>
                  <div className="item-meta">
                    {template.identifier} • {template.numberOfComponents} components • {template.numberOfPhases} phases
                  </div>
                </div>
              ))}
            </div>
          </div>
          {selectedTemplate && (
            <div style={{ flex: '0 0 50%', overflowY: 'auto', borderLeft: '2px solid #ddd', paddingLeft: '10px' }}>
              <div style={{ position: 'sticky', top: 0, background: 'white', paddingBottom: '10px', borderBottom: '1px solid #eee', marginBottom: '10px' }}>
                <h3 style={{ margin: '0 0 5px 0' }}>📦 Components in {selectedTemplate.label}</h3>
                <button onClick={addComponent} className="btn-add" style={{ marginTop: '5px' }}>+ Add Component</button>
              </div>
              <div className="material-list">
                {selectedTemplate.componentRefs && selectedTemplate.componentRefs.length > 0 ? (
                  selectedTemplate.componentRefs.map(componentRef => {
                    const ref = typeof componentRef === 'string' ? componentRef : componentRef.uidRef;
                    const component = components.find(c => c.uid === ref || c.identifier === ref);
                    if (!component) {
                      return null;
                    }
                    return (
                      <div 
                        key={component.uid} 
                        className={`item ${selectedItemId === component.uid ? 'item-selected' : ''}`}
                        onClick={() => onSelectItem?.({ type: 'component', data: component })}
                      >
                        <div className="item-header">
                          <strong>{component.label}</strong>
                          <div className="item-actions">
                            <button 
                              onClick={(e) => { e.stopPropagation(); deleteComponent(component.uid); }} 
                              className="btn-icon" 
                              title="Delete"
                            >🗑️</button>
                          </div>
                        </div>
                        <div className="item-meta">
                          {component.identifier} • {component.type}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>
                    No components in this template
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}



      {activeTab === 'states' && (
        <div className="states-section">
          <div className="button-group">
            <button onClick={addCase} className="btn-add">+ Add Case</button>
            <button onClick={addState} className="btn-add">+ Add State</button>
          </div>
          <div className="material-list">
            {Object.entries(stateGroups).map(([groupName, groupStates]) => (
              <div key={groupName} className="state-group">
                <div className="state-group-header">
                  <div 
                    style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
                    onClick={() => setExpandedGroups(prev => ({ ...prev, [groupName]: !prev[groupName] }))}
                  >
                    <span>{expandedGroups[groupName] ? '▼' : '▶'}</span>
                    <strong>{groupName}</strong>
                    <span className="group-count">({groupStates.length})</span>
                  </div>
                  <button 
                    onClick={(e) => { e.stopPropagation(); editCase(groupName); }} 
                    className="btn-icon" 
                    title="Rename Case"
                    style={{ fontSize: '0.85em' }}
                  >
                    ✏️
                  </button>
                </div>
                {expandedGroups[groupName] && groupStates.map(state => (
                  <div 
                    key={state.uid} 
                    className={`item state-item ${selectedItemId === state.uid ? 'item-selected' : ''}`}
                    onClick={() => onSelectItem?.({ type: 'state', data: state })}
                  >
                    <div className="item-header">
                      <strong>{state.label}</strong>
                      <div className="item-actions">
                        <button onClick={(e) => { e.stopPropagation(); deleteState(state.uid); }} className="btn-icon" title="Delete">🗑️</button>
                      </div>
                    </div>
                    <div className="item-meta">
                      {state.identifier} • {state.flow?.moleFlow?.value} {state.flow?.moleFlow?.unit}
                    </div>
                    {state.referencedByStreams && state.referencedByStreams.length > 0 && (
                      <div className="item-streams">
                        📊 Used by: {state.referencedByStreams.join(', ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {editingTemplate && (
        <TemplateEditor
          template={editingTemplate}
          components={components}
          onSave={saveTemplate}
          onCancel={() => setEditingTemplate(null)}
        />
      )}

      {editingComponent && (
        <ComponentEditor
          component={editingComponent}
          onSave={saveComponent}
          onCancel={() => setEditingComponent(null)}
        />
      )}

      {editingState && (
        <StateEditor
          state={editingState}
          templates={templates}
          onSave={saveState}
          onCancel={() => setEditingState(null)}
        />
      )}
    </div>
  );
};

// Template Editor Modal
const TemplateEditor: React.FC<{
  template: MaterialTemplate;
  components: MaterialComponent[];
  onSave: (template: MaterialTemplate) => void;
  onCancel: () => void;
}> = ({ template, onSave, onCancel }) => {
  const [edited, setEdited] = React.useState(template);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h4>Edit Template</h4>
        <label>
          Identifier:
          <input
            type="text"
            value={edited.identifier}
            onChange={(e) => setEdited({ ...edited, identifier: e.target.value })}
          />
        </label>
        <label>
          Label:
          <input
            type="text"
            value={edited.label}
            onChange={(e) => setEdited({ ...edited, label: e.target.value })}
          />
        </label>
        <label>
          Description:
          <textarea
            value={edited.description}
            onChange={(e) => setEdited({ ...edited, description: e.target.value })}
          />
        </label>
        <label>
          Number of Phases:
          <input
            type="number"
            value={edited.numberOfPhases}
            onChange={(e) => setEdited({ ...edited, numberOfPhases: parseInt(e.target.value) })}
          />
        </label>
        <div className="modal-actions">
          <button className="btn-save" onClick={() => onSave(edited)}>Save</button>
          <button className="btn-cancel" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
};

// Component Editor Modal
const ComponentEditor: React.FC<{
  component: MaterialComponent;
  onSave: (component: MaterialComponent) => void;
  onCancel: () => void;
}> = ({ component, onSave, onCancel }) => {
  const [edited, setEdited] = React.useState(component);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h4>Edit Component</h4>
        <label>
          Identifier:
          <input
            type="text"
            value={edited.identifier}
            onChange={(e) => setEdited({ ...edited, identifier: e.target.value })}
          />
        </label>
        <label>
          Label:
          <input
            type="text"
            value={edited.label}
            onChange={(e) => setEdited({ ...edited, label: e.target.value })}
          />
        </label>
        <label>
          Type:
          <select
            value={edited.type}
            onChange={(e) => setEdited({ ...edited, type: e.target.value as MaterialComponent['type'] })}
          >
            {MATERIAL_COMPONENT_SUBCLASSES.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
        {/* The "+ Add Component" modal stays minimal — just the structural
            fields needed to seed a new component. ChEBI_identifier /
            IUPAC_identifier / ProjectReference and any project-extension
            thermo data are authored after creation in the schema-driven
            side-panel editor (MaterialEditorPanel), which renders all
            declared properties for the chosen type from Process.xml. */}
        <div className="modal-actions">
          <button className="btn-save" onClick={() => onSave(edited)}>Save</button>
          <button className="btn-cancel" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
};

// State Editor Modal
const StateEditor: React.FC<{
  state: MaterialState;
  templates: MaterialTemplate[];
  onSave: (state: MaterialState) => void;
  onCancel: () => void;
}> = ({ state, templates, onSave, onCancel }) => {
  const [edited, setEdited] = React.useState(state);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px', maxHeight: '80vh', overflow: 'auto' }}>
        <h4>Material State Details</h4>
        
        <div className="property-group">
          <label>
            Identifier:
            <input
              type="text"
              value={edited.identifier}
              onChange={(e) => setEdited({ ...edited, identifier: e.target.value })}
            />
          </label>
        </div>

        <div className="property-group">
          <label>
            Label:
            <input
              type="text"
              value={edited.label}
              onChange={(e) => setEdited({ ...edited, label: e.target.value })}
            />
          </label>
        </div>

        <div className="property-group">
          <label>
            Description:
            <textarea
              value={edited.description || ''}
              onChange={(e) => setEdited({ ...edited, description: e.target.value })}
            />
          </label>
        </div>

        <div className="property-group">
          <label>
            Template Reference:
            <select
              value={edited.templateRef || ''}
              onChange={(e) => {
                const selectedTemplateUid = e.target.value;
                const selectedTemplate = templates.find(t => t.uid === selectedTemplateUid);
                
                // Get number of components from template
                const numComponents = selectedTemplate?.numberOfComponents || 0;
                
                // Create or resize fractions array to match template's component count
                let newFractions = edited.flow?.composition?.fractions || [];
                if (numComponents > 0) {
                  // Resize array: keep existing values, pad with 0s, or trim
                  // @ts-expect-error — fractions type-shape mismatch (see TODO at top of file)
                  newFractions = Array(numComponents).fill(0).map((_, idx) =>
                    newFractions[idx] !== undefined ? newFractions[idx] : 0
                  );
                }
                
                setEdited({ 
                  ...edited, 
                  templateRef: selectedTemplateUid,
                  flow: {
                    ...edited.flow,
                    moleFlow: edited.flow?.moleFlow,
                    composition: numComponents > 0 ? {
                      basis: edited.flow?.composition?.basis || 'Mole',
                      display: edited.flow?.composition?.display || 'Percentage',
                      fractions: newFractions
                    } : edited.flow?.composition
                  }
                });
              }}
            >
              <option value="">None</option>
              {templates.map(t => (
                <option key={t.uid} value={t.uid}>
                  {t.label} ({t.numberOfComponents} components)
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="property-group">
          <h5>Flow Properties</h5>
          <label>
            Mole Flow Value:
            <input
              type="number"
              value={edited.flow?.moleFlow?.value || 0}
              onChange={(e) => setEdited({
                ...edited,
                flow: {
                  ...edited.flow,
                  moleFlow: { 
                    value: parseFloat(e.target.value), 
                    unit: edited.flow?.moleFlow?.unit || 'KilomolePerHour' 
                  },
                  composition: edited.flow?.composition
                }
              })}
            />
          </label>
          <label>
            Unit:
            <input
              type="text"
              value={edited.flow?.moleFlow?.unit || 'KilomolePerHour'}
              onChange={(e) => setEdited({
                ...edited,
                flow: {
                  ...edited.flow,
                  moleFlow: { 
                    value: edited.flow?.moleFlow?.value || 0, 
                    unit: e.target.value 
                  },
                  composition: edited.flow?.composition
                }
              })}
            />
          </label>
        </div>

        <div className="property-group" style={{ background: '#f5f5f5', padding: '12px', borderRadius: '4px' }}>
          <h5>Composition</h5>
          <label>
            Basis:
            <input
              type="text"
              value={edited.flow?.composition?.basis || ''}
              onChange={(e) => setEdited({
                ...edited,
                flow: {
                  ...edited.flow,
                  moleFlow: edited.flow?.moleFlow,
                  composition: {
                    basis: e.target.value,
                    display: edited.flow?.composition?.display || '',
                    fractions: edited.flow?.composition?.fractions || []
                  }
                }
              })}
              placeholder="e.g., Mole"
            />
          </label>
          <label>
            Display:
            <input
              type="text"
              value={edited.flow?.composition?.display || ''}
              onChange={(e) => setEdited({
                ...edited,
                flow: {
                  ...edited.flow,
                  moleFlow: edited.flow?.moleFlow,
                  composition: {
                    basis: edited.flow?.composition?.basis || '',
                    display: e.target.value,
                    fractions: edited.flow?.composition?.fractions || []
                  }
                }
              })}
              placeholder="e.g., Percentage"
            />
          </label>
          
          <div style={{ marginTop: '12px' }}>
            <strong>Fractions:</strong>
            <div style={{ maxHeight: '200px', overflow: 'auto', marginTop: '8px' }}>
              {(edited.flow?.composition?.fractions || []).map((fraction, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ minWidth: '100px' }}>Component {idx + 1}:</span>
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    max="1"
                    // @ts-expect-error — fractions type-shape mismatch (see TODO at top of file)
                    value={fraction}
                    onChange={(e) => {
                      const newFractions = [...(edited.flow?.composition?.fractions || [])];
                      // @ts-expect-error — fractions type-shape mismatch (see TODO at top of file)
                      newFractions[idx] = parseFloat(e.target.value) || 0;
                      setEdited({
                        ...edited,
                        flow: {
                          ...edited.flow,
                          moleFlow: edited.flow?.moleFlow,
                          composition: {
                            basis: edited.flow?.composition?.basis || '',
                            display: edited.flow?.composition?.display || '',
                            fractions: newFractions
                          }
                        }
                      });
                    }}
                    style={{ flex: 1, padding: '4px 8px' }}
                  />
                  {/* @ts-expect-error — fractions type-shape mismatch (see TODO at top of file) */}
                  <span style={{ minWidth: '80px' }}>{(fraction * 100).toFixed(3)}%</span>
                  <button
                    onClick={() => {
                      const newFractions = (edited.flow?.composition?.fractions || []).filter((_, i) => i !== idx);
                      setEdited({
                        ...edited,
                        flow: {
                          ...edited.flow,
                          moleFlow: edited.flow?.moleFlow,
                          composition: {
                            basis: edited.flow?.composition?.basis || '',
                            display: edited.flow?.composition?.display || '',
                            fractions: newFractions
                          }
                        }
                      });
                    }}
                    className="btn-icon"
                    title="Remove"
                    style={{ padding: '2px 6px' }}
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
            {(edited.flow?.composition?.fractions || []).length > 0 && (
              <div style={{ marginTop: '8px', fontSize: '0.85rem', color: '#666', fontWeight: 'bold' }}>
                {/* @ts-expect-error — fractions type-shape mismatch (see TODO at top of file) */}
                Total: {((edited.flow?.composition?.fractions || []).reduce((sum, f) => sum + f, 0) * 100).toFixed(3)}%
              </div>
            )}
          </div>
        </div>

        {edited.referencedByStreams && edited.referencedByStreams.length > 0 && (
          <div className="property-group" style={{ background: '#e3f2fd', padding: '12px', borderRadius: '4px' }}>
            <h5>📊 Used by Streams</h5>
            <div style={{ fontSize: '0.9rem' }}>
              {edited.referencedByStreams.map((stream, idx) => (
                <div key={idx} style={{ padding: '4px 0' }}>• {stream}</div>
              ))}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn-save" onClick={() => onSave(edited)}>Save</button>
          <button className="btn-cancel" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
};
