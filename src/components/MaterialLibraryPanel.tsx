import React from 'react';
import type { MaterialTemplate, MaterialComponent, MaterialState } from '../dexpi/moddle/materials';

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

  React.useEffect(() => {
    if (modeler) {
      loadMaterialData();
    }
  }, [modeler]);

  const loadMaterialData = () => {
    const elementRegistry = modeler.get('elementRegistry');
    const allElements = elementRegistry.getAll();

    // Find MaterialTemplates DataObjectReference
    const templatesDataObj = allElements.find((el: any) => 
      el.type === 'bpmn:DataObjectReference' && 
      el.businessObject.name === 'MaterialTemplates'
    );

    // Find MaterialStates DataObjectReference
    const statesDataObj = allElements.find((el: any) => 
      el.type === 'bpmn:DataObjectReference' && 
      (el.businessObject.name === 'Base Case MaterialStates' || el.businessObject.name === 'MaterialStates')
    );

    const loadedTemplates: MaterialTemplate[] = [];
    const loadedComponents: MaterialComponent[] = [];

    // Helper functions to extract text from $children structure
    const getChildText = (parent: any, childType: string): string => {
      const child = parent.$children?.find((c: any) => c.$type === childType);
      return child?.$body || '';
    };
    
    const getChildValue = (parent: any, childType: string): number => {
      const child = parent.$children?.find((c: any) => c.$type === childType);
      return parseInt(child?.$body) || 0;
    };

    if (templatesDataObj?.businessObject?.extensionElements?.values) {
      templatesDataObj.businessObject.extensionElements.values.forEach((val: any) => {
        if (val.$type === 'MaterialTemplate' || val.$type?.includes('MaterialTemplate')) {
          console.log('Raw MaterialTemplate:', val);
          console.log('$children:', val.$children);
          
          // Extract component identifiers from MaterialComponentIdentifier array
          const componentRefs = val.ListOfMaterialComponents?.MaterialComponentIdentifier 
            ? (Array.isArray(val.ListOfMaterialComponents.MaterialComponentIdentifier)
                ? val.ListOfMaterialComponents.MaterialComponentIdentifier.map((c: any) => c.Identifier)
                : [val.ListOfMaterialComponents.MaterialComponentIdentifier.Identifier])
            : [];
          
          loadedTemplates.push({
            uid: val.uid || '',
            identifier: getChildText(val, 'Identifier'),
            label: getChildText(val, 'Label'),
            description: getChildText(val, 'Description'),
            numberOfComponents: getChildValue(val, 'NumberOfMaterialComponents'),
            numberOfPhases: getChildValue(val, 'NumberOfPhases'),
            componentRefs: componentRefs,
            phases: val.ListOfPhases?.PhaseIdentifier?.map((p: any) => p.Identifier) || []
          });
        }
        if (val.$type === 'MaterialComponent' || val.$type?.includes('MaterialComponent')) {
          loadedComponents.push({
            uid: val.uid || '',
            identifier: getChildText(val, 'Identifier'),
            label: getChildText(val, 'Label'),
            description: getChildText(val, 'Description'),
            type: val.xsi?.type === 'PureMaterialComponent' ? 'PureMaterialComponent' : 'CustomMaterialComponent',
            chebiId: getChildText(val, 'ChEBI_identifier'),
            iupacId: getChildText(val, 'IUPAC_identifier')
          });
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

    // First, build a map of which streams reference which states
    const streamsByState: { [uid: string]: string[] } = {};
    allElements.forEach((el: any) => {
      if (el.type === 'bpmn:SequenceFlow' && el.businessObject?.extensionElements?.values) {
        el.businessObject.extensionElements.values.forEach((ext: any) => {
          if (ext.$type === 'Stream' || ext.$type?.includes('Stream')) {
            const stateRef = ext.$children?.find((c: any) => c.$type === 'MaterialStateReference')?.uidRef;
            if (stateRef) {
              if (!streamsByState[stateRef]) {
                streamsByState[stateRef] = [];
              }
              const streamName = el.businessObject.name || ext.$children?.find((c: any) => c.$type === 'Identifier')?.$body || el.id;
              streamsByState[stateRef].push(streamName);
            }
          }
        });
      }
    });

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

              // Extract MaterialStates from this Case
              const statesInCase = val.$children?.filter((c: any) => c.$type === 'MaterialState' || c.$type?.includes('MaterialState')) || [];
              statesInCase.forEach((stateVal: any) => {
                const flowChild = stateVal.$children?.find((c: any) => c.$type === 'Flow');
                const moleFlowChild = flowChild?.$children?.find((c: any) => c.$type === 'MoleFlow');
                const compositionChild = flowChild?.$children?.find((c: any) => c.$type === 'Composition');
                const templateRefUid = stateVal.$children?.find((c: any) => c.$type === 'TemplateReference')?.uidRef;
                
                // Load fractions from BPMN
                let fractions = compositionChild?.$children
                  ?.filter((c: any) => c.$type === 'Fraction')
                  .map((f: any) => ({
                    componentReference: f.$children?.find((c: any) => c.$type === 'ComponentReference')?.$body || '',
                    value: f.$children?.find((c: any) => c.$type === 'Value')?.$body || '0'
                  })) || [];
                
                // If template is referenced and fractions are missing or incomplete, populate from template
                if (templateRefUid) {
                  const template = loadedTemplates.find(t => t.uid === templateRefUid);
                  if (template && template.componentRefs && template.componentRefs.length > 0) {
                    // Create a map of existing fractions by component ref
                    const existingFractionsMap = new Map(
                      fractions.map(f => [f.componentReference, f.value])
                    );
                    
                    // Build fractions array based on template components
                    fractions = template.componentRefs.map(componentRef => ({
                      componentReference: componentRef,
                      value: existingFractionsMap.get(componentRef) || '0'
                    }));
                  }
                }
                
                const state: MaterialState = {
                  uid: stateVal.uid || '',
                  identifier: getChildText(stateVal, 'Identifier'),
                  label: getChildText(stateVal, 'Label'),
                  description: getChildText(stateVal, 'Description'),
                  flow: flowChild ? {
                    moleFlow: moleFlowChild ? {
                      value: parseFloat(moleFlowChild.$children?.find((c: any) => c.$type === 'Value')?.$body || '0'),
                      unit: moleFlowChild.$children?.find((c: any) => c.$type === 'Unit')?.$body || ''
                    } : undefined,
                    composition: compositionChild || fractions.length > 0 ? {
                      basis: compositionChild?.$children?.find((c: any) => c.$type === 'Basis')?.$body || '',
                      display: compositionChild?.$children?.find((c: any) => c.$type === 'Display')?.$body || '',
                      fractions: fractions
                    } : undefined
                  } : undefined,
                  templateRef: templateRefUid,
                  streamRef: stateVal.$children?.find((c: any) => c.$type === 'StreamReference')?.uidRef,
                  referencedByStreams: streamsByState[stateVal.uid] || []
                };
                
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

          // Extract MaterialStates directly from extensionElements
          extValues.forEach((val: any) => {
            if (val.$type === 'MaterialState' || val.$type?.includes('MaterialState')) {
              const flowChild = val.$children?.find((c: any) => c.$type === 'Flow');
              const moleFlowChild = flowChild?.$children?.find((c: any) => c.$type === 'MoleFlow');
              const compositionChild = flowChild?.$children?.find((c: any) => c.$type === 'Composition');
              const templateRefUid = val.$children?.find((c: any) => c.$type === 'TemplateReference')?.uidRef;
              
              // Load fractions from BPMN
              let fractions = compositionChild?.$children
                ?.filter((c: any) => c.$type === 'Fraction')
                .map((f: any) => ({
                  componentReference: f.$children?.find((c: any) => c.$type === 'ComponentReference')?.$body || '',
                  value: f.$children?.find((c: any) => c.$type === 'Value')?.$body || '0'
                })) || [];
              
              // If template is referenced and fractions are missing or incomplete, populate from template
              if (templateRefUid) {
                const template = loadedTemplates.find(t => t.uid === templateRefUid);
                if (template && template.componentRefs && template.componentRefs.length > 0) {
                  // Create a map of existing fractions by component ref
                  const existingFractionsMap = new Map(
                    fractions.map(f => [f.componentReference, f.value])
                  );
                  
                  // Build fractions array based on template components
                  fractions = template.componentRefs.map(componentRef => ({
                    componentReference: componentRef,
                    value: existingFractionsMap.get(componentRef) || '0'
                  }));
                }
              }
              
              const state: MaterialState = {
                uid: val.uid || '',
                identifier: getChildText(val, 'Identifier'),
                label: getChildText(val, 'Label'),
                description: getChildText(val, 'Description'),
                flow: flowChild ? {
                  moleFlow: moleFlowChild ? {
                    value: parseFloat(moleFlowChild.$children?.find((c: any) => c.$type === 'Value')?.$body || '0'),
                    unit: moleFlowChild.$children?.find((c: any) => c.$type === 'Unit')?.$body || ''
                  } : undefined,
                  composition: compositionChild || fractions.length > 0 ? {
                    basis: compositionChild?.$children?.find((c: any) => c.$type === 'Basis')?.$body || '',
                    display: compositionChild?.$children?.find((c: any) => c.$type === 'Display')?.$body || '',
                    fractions: fractions
                  } : undefined
                } : undefined,
                templateRef: templateRefUid,
                streamRef: val.$children?.find((c: any) => c.$type === 'StreamReference')?.uidRef,
                referencedByStreams: streamsByState[val.uid] || []
              };
              
              loadedStates.push(state);
              groupedStates[groupName].push(state);
            }
          });
        }
      }
    });

    console.log('Loaded materials:', { 
      templates: loadedTemplates, 
      components: loadedComponents, 
      states: loadedStates,
      stateGroups: groupedStates
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
    updatedStates: MaterialState[]
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
    
    // Add templates
    updatedTemplates.forEach(template => {
      const templateElement = moddle.create('MaterialTemplate', {
        uid: template.uid,
        Identifier: template.identifier,
        Label: template.label,
        Description: template.description,
        NumberOfMaterialComponents: template.numberOfComponents,
        NumberOfPhases: template.numberOfPhases,
        ListOfMaterialComponents: {
          MaterialComponentIdentifier: template.componentRefs
        },
        ListOfPhases: {
          PhaseIdentifier: template.phases.map(p => ({ Identifier: p }))
        }
      });
      values.push(templateElement);
    });

    // Add components
    updatedComponents.forEach(component => {
      const componentElement = moddle.create('MaterialComponent', {
        'xsi:type': component.type,
        uid: component.uid,
        Identifier: component.identifier,
        Label: component.label,
        Description: component.description,
        ChEBI_identifier: component.chebiId,
        IUPAC_identifier: component.iupacId
      });
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
      
      const materialStates = (statesInCase as MaterialState[]).map(state => {
        return moddle.create('dexpi:MaterialState', {
          uid: state.uid,
          Identifier: state.identifier,
          Label: state.label,
          Description: state.description,
          Flow: state.flow ? {
            MoleFlow: state.flow.moleFlow ? {
              Value: state.flow.moleFlow.value.toString(),
              Unit: state.flow.moleFlow.unit
            } : undefined,
            Composition: state.flow.composition ? {
              Basis: state.flow.composition.basis,
              Display: state.flow.composition.display,
              Fraction: state.flow.composition.fractions.map(f => ({
                Value: f.toString(),
                Unit: 'Fraction'
              }))
            } : undefined
          } : undefined,
          TemplateReference: state.templateRef ? { uidRef: state.templateRef } : undefined,
          StreamReference: state.streamRef ? { uidRef: state.streamRef } : undefined
        });
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
          onClick={() => setActiveTab('templates')}
        >
          Templates ({templates.length})
        </button>
        <button 
          className={activeTab === 'components' ? 'active' : ''} 
          onClick={() => setActiveTab('components')}
        >
          Components ({components.length})
        </button>
        <button 
          className={activeTab === 'states' ? 'active' : ''} 
          onClick={() => setActiveTab('states')}
        >
          States ({states.length})
        </button>
      </div>

      {activeTab === 'templates' && (
        <div className="templates-section">
          <button onClick={addTemplate} className="btn-add">+ Add Template</button>
          <div className="material-list">
            {templates.map(template => (
              <div 
                key={template.uid} 
                className={`item ${selectedItemId === template.uid ? 'item-selected' : ''}`}
                onClick={() => onSelectItem?.({ type: 'template', data: template })}
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
      )}

      {activeTab === 'components' && (
        <div className="components-section">
          <button onClick={addComponent} className="btn-add">+ Add Component</button>
          <div className="material-list">
            {components.map(component => (
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
            ))}
          </div>
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
            onChange={(e) => setEdited({ ...edited, type: e.target.value as any })}
          >
            <option value="PureMaterialComponent">Pure Material</option>
            <option value="CustomMaterialComponent">Custom Material</option>
          </select>
        </label>
        <label>
          ChEBI ID:
          <input
            type="text"
            value={edited.chebiId || ''}
            onChange={(e) => setEdited({ ...edited, chebiId: e.target.value })}
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
                    value={fraction}
                    onChange={(e) => {
                      const newFractions = [...(edited.flow?.composition?.fractions || [])];
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
