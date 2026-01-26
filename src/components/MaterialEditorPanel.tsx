import React, { useState, useEffect } from 'react';

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

  const handleSave = () => {
    const modeling = modeler.get('modeling');
    const elementRegistry = modeler.get('elementRegistry');
    
    // Find the MaterialStates DataObjectReference
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
      // Update template
      const templates = extensionElements.get('values').filter((v: any) => v.$type === 'dexpi:MaterialTemplate');
      const template = templates.find((t: any) => t.uid === edited.uid);
      
      if (template) {
        template.identifier = edited.identifier;
        template.label = edited.label;
        template.description = edited.description;
        template.numberOfPhases = edited.numberOfPhases;
        
        modeling.updateProperties(materialStatesElement, {
          extensionElements: extensionElements
        });
      }
    } else if (item.type === 'component') {
      // Update component
      const components = extensionElements.get('values').filter((v: any) => v.$type === 'dexpi:MaterialComponent');
      const component = components.find((c: any) => c.uid === edited.uid);
      
      if (component) {
        component.identifier = edited.identifier;
        component.label = edited.label;
        component.description = edited.description;
        component.chebiId = edited.chebiId;
        component.iupacName = edited.iupacName;
        component.casNumber = edited.casNumber;
        
        modeling.updateProperties(materialStatesElement, {
          extensionElements: extensionElements
        });
      }
    } else if (item.type === 'state') {
      // Update state - need to find within Cases
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
            if (!state.flow.moleFlow) state.flow.moleFlow = {};
            state.flow.moleFlow.value = edited.flow?.moleFlow?.value || '';
            state.flow.moleFlow.unit = edited.flow?.moleFlow?.unit || 'kmol/h';
            
            // Update composition fractions
            if (edited.flow?.composition?.fractions) {
              if (!state.flow.composition) state.flow.composition = {};
              state.flow.composition.fractions = edited.flow.composition.fractions.map((f: any) => ({
                componentReference: f.componentReference,
                value: f.value
              }));
            }
            
            found = true;
            break;
          }
        }
      }
      
      if (found) {
        modeling.updateProperties(materialStatesElement, {
          extensionElements: extensionElements
        });
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
              <label>ChEBI ID:</label>
              <input
                type="text"
                value={edited.chebiId || ''}
                onChange={(e) => setEdited({ ...edited, chebiId: e.target.value })}
                placeholder="e.g., CHEBI:17234"
              />
            </div>
            <div className="form-group">
              <label>IUPAC Name:</label>
              <input
                type="text"
                value={edited.iupacName || ''}
                onChange={(e) => setEdited({ ...edited, iupacName: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>CAS Number:</label>
              <input
                type="text"
                value={edited.casNumber || ''}
                onChange={(e) => setEdited({ ...edited, casNumber: e.target.value })}
                placeholder="e.g., 64-17-5"
              />
            </div>
          </>
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
            <div className="form-group">
              <label>Mole Flow:</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="number"
                  value={edited.flow?.moleFlow?.value || ''}
                  onChange={(e) => setEdited({
                    ...edited,
                    flow: {
                      ...edited.flow,
                      moleFlow: { 
                        ...(edited.flow?.moleFlow || {}), 
                        value: e.target.value 
                      }
                    }
                  })}
                  placeholder="Value"
                  style={{ flex: 1 }}
                />
                <input
                  type="text"
                  value={edited.flow?.moleFlow?.unit || 'kmol/h'}
                  onChange={(e) => setEdited({
                    ...edited,
                    flow: {
                      ...edited.flow,
                      moleFlow: { 
                        ...(edited.flow?.moleFlow || {}), 
                        unit: e.target.value 
                      }
                    }
                  })}
                  placeholder="Unit"
                  style={{ width: '80px' }}
                />
              </div>
            </div>
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
                  background: '#f8f9fa'
                }}>
                  {edited.flow.composition.fractions.map((fraction: any, index: number) => (
                    <div key={index} style={{ 
                      display: 'flex', 
                      gap: '8px', 
                      marginBottom: '6px',
                      alignItems: 'center'
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
                                fractions: newFractions
                              }
                            }
                          });
                        }}
                        placeholder="Component"
                        style={{ flex: 1 }}
                      />
                      <input
                        type="number"
                        step="0.0001"
                        value={fraction.value || ''}
                        onChange={(e) => {
                          const newFractions = [...edited.flow.composition.fractions];
                          newFractions[index] = { ...newFractions[index], value: e.target.value };
                          setEdited({
                            ...edited,
                            flow: {
                              ...edited.flow,
                              composition: {
                                ...edited.flow.composition,
                                fractions: newFractions
                              }
                            }
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
                    color: '#666'
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
                  color: '#1976d2'
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
