import React from 'react';
import type { DexpiElement, DexpiPort, DexpiStream } from '../dexpi/moddle';
import { DexpiEnumerations } from '../utils/dexpiEnumerations';
import { DexpiProcessClassRegistry } from '../transformer/DexpiProcessClassRegistry';
// Vite ?raw import — bundles Process.xml as a string at build time (no runtime fetch needed)
import processXmlRaw from '../../dexpi-schema-files/Process.xml?raw';

// Build registry once at module load — synchronous, browser-safe
const DEXPI_REGISTRY = DexpiProcessClassRegistry.fromXml(processXmlRaw);

/** All concrete DEXPI Process step classes grouped for the dropdown. */
const STEP_CLASSES = DEXPI_REGISTRY.concreteClasses().filter(c =>
  // Exclude non-step classes (ports, flows, templates, etc.)
  !['MaterialPort', 'EnergyPort', 'InformationPort', 'ThermalEnergyPort',
    'MechanicalEnergyPort', 'ElectricalEnergyPort', 'MaterialFlow', 'EnergyFlow',
    'ElectricalEnergyFlow', 'MechanicalEnergyFlow', 'ThermalEnergyFlow',
    'InformationFlow', 'InformationVariant', 'MaterialTemplate', 'MaterialState',
    'MaterialStateType', 'ListOfMaterialComponents', 'MaterialComponent',
    'PureMaterialComponent', 'CustomMaterialComponent', 'Composition',
    'ProcessModel', 'Stream'].includes(c)
  // Source and Sink are excluded per representation methodology:
  // they map exclusively to StartEvent and EndEvent, never to Task elements
  && c !== 'Source' && c !== 'Sink'
);

interface DexpiPropertiesPanelProps {
  element: any;
  modeler: any;
}

export const DexpiPropertiesPanel: React.FC<DexpiPropertiesPanelProps> = ({ element, modeler }) => {
  const [dexpiType, setDexpiType] = React.useState<string>('');
  const [identifier, setIdentifier] = React.useState<string>('');
  const [uid, setUid] = React.useState<string>('');
  const [customUri, setCustomUri] = React.useState<string>('');
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
      // Detect if loaded type is a custom (non-DEXPI) type
      const isCustom = !!dtype && !DEXPI_REGISTRY.isValidClass(dtype) && dtype !== 'Source' && dtype !== 'Sink';
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
      // Don't write to element yet — wait for user to type the custom name
    } else {
      setIsCustomType(false);
      setCustomTypeName('');
      setDexpiType(newType);
      updateDexpiElement({ dexpiType: newType, customUri: undefined });
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
          // For dexpi:Port objects, create proper moddle instance
          const moddle = modeler.get('moddle');
          const updatedPort = moddle.create('dexpi:Port', {
            portId: updates.portId !== undefined ? updates.portId : p.portId,
            name: updates.name !== undefined ? updates.name : p.name,
            portType: updates.portType !== undefined ? updates.portType : p.portType,
            direction: updates.direction !== undefined ? updates.direction : p.direction,
            anchorSide: updates.anchorSide !== undefined ? updates.anchorSide : p.anchorSide,
            anchorOffset: updates.anchorOffset !== undefined ? updates.anchorOffset : p.anchorOffset,
            anchorX: updates.anchorX !== undefined ? updates.anchorX : p.anchorX,
            anchorY: updates.anchorY !== undefined ? updates.anchorY : p.anchorY
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
    return <div className="dexpi-properties-panel">Element does not support DEXPI properties</div>;
  }

  return (
    <div className="dexpi-properties-panel">
      <h3>DEXPI Properties</h3>
      
      {/* Status banner */}
      {hasData && dexpiType && DEXPI_REGISTRY.isValidClass(dexpiType) && !isCustomType && (
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
                {/* Populated from dexpi-schema-files/Process.xml — replace file to update */}
                {STEP_CLASSES.map(cls => (
                  <option key={cls} value={cls}>{cls}</option>
                ))}
                <option value="__custom__">— Custom / external RDL type...</option>
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
          UID:
          <input 
            type="text" 
            value={uid} 
            onChange={handleUidChange}
            placeholder="Enter unique ID..."
          />
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

      {/* Custom type — shown when user selects "Custom / external RDL type..." */}
      {isCustomType && (
        <div className="property-group">
          <label>
            Custom type name:
            <input
              type="text"
              value={customTypeName}
              onChange={handleCustomTypeChange}
              placeholder="e.g. ElectrolyticReduction, MyReactor..."
              autoFocus
            />
          </label>
          <div style={{ fontSize: '0.78rem', color: '#555', marginTop: '3px' }}>
            Output will use <code>ProcessStep</code> as DEXPI type. Add a URI below to reference the class definition.
          </div>
          {customTypeName && (
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
          )}
          {customTypeName && (
            <div style={{ fontSize: '0.78rem', color: '#555', marginTop: '3px' }}>
              URI referencing the class in an external RDL (ISO 15926, OntoCAPE, company RDL).
              Stored as <code>ReferenceUri</code> in the DEXPI output.
            </div>
          )}
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
            
            {isPortConnected(port) && (
              <div style={{ fontSize: '0.85em', color: '#666', fontStyle: 'italic', marginTop: '8px' }}>
                Position automatically determined by connection
              </div>
            )}
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
        <ProcessStepAttributesSection element={element} modeler={modeler} />
      )}
    </div>
  );
};

// ProcessStep Attributes Component
const ProcessStepAttributesSection: React.FC<{ element: any; modeler: any }> = ({ element, modeler }) => {
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
          const attrs = dexpiElement.attributes || [];
          setAttributes(Array.isArray(attrs) ? attrs : []);
        }
      }
    }
  }, [element]);

  const addAttribute = () => {
    const moddle = modeler.get('moddle');
    const newAttr = moddle.create('dexpi:Attribute', {
      name: `Attribute ${attributes.length + 1}`,
      value: '',
      unit: '',
      scope: 'Design',
      range: 'Nominal',
      provenance: 'Calculated'
    });

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
    const moddle = modeler.get('moddle');
    const updatedAttrs = attributes.map((attr, i) => {
      if (i === index) {
        return moddle.create('dexpi:Attribute', {
          name: updates.name !== undefined ? updates.name : attr.name,
          value: updates.value !== undefined ? updates.value : attr.value,
          unit: updates.unit !== undefined ? updates.unit : attr.unit,
          scope: updates.scope !== undefined ? updates.scope : attr.scope,
          range: updates.range !== undefined ? updates.range : attr.range,
          provenance: updates.provenance !== undefined ? updates.provenance : attr.provenance
        });
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

    dexpiElement.attributes = updatedAttrs;

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
          
          <label>
            Name:
            <input 
              type="text" 
              value={attr.name || ''} 
              onChange={(e) => updateAttribute(index, { name: e.target.value })}
            />
          </label>

          <label>
            Value:
            <input 
              type="text" 
              value={attr.value || ''} 
              onChange={(e) => updateAttribute(index, { value: e.target.value })}
            />
          </label>

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
            Scope:
            <select 
              value={attr.scope || 'Design'} 
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
              value={attr.range || 'Actual'} 
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
              value={attr.provenance || 'Calculated'} 
              onChange={(e) => updateAttribute(index, { provenance: e.target.value })}
            >
              <option value="">-- Select Provenance --</option>
              {DexpiEnumerations.Provenance.map(prov => (
                <option key={prov} value={prov}>{prov}</option>
              ))}
            </select>
          </label>
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
}

export const StreamPropertiesPanel: React.FC<StreamPropertiesPanelProps> = ({ element, modeler }) => {
  const [streamData, setStreamData] = React.useState<Partial<DexpiStream>>({});
  const [streamName, setStreamName] = React.useState<string>('');
  const [attributes, setAttributes] = React.useState<any[]>([]);
  const [hasData, setHasData] = React.useState<boolean>(false);
  const [materialState, setMaterialState] = React.useState<any>(null);
  const [materialTemplate, setMaterialTemplate] = React.useState<any>(null);
  const [allMaterialStates, setAllMaterialStates] = React.useState<any[]>([]);
  const [currentStateUidRef, setCurrentStateUidRef] = React.useState<string>('');

  React.useEffect(() => {
    // Load all material states for dropdown
    const elementRegistry = modeler.get('elementRegistry');
    const allElements = elementRegistry.getAll();
    const stateDataObjs = allElements.filter((el: any) => 
      el.type === 'bpmn:DataObjectReference' && 
      (el.businessObject.name?.includes('MaterialStates') || el.businessObject.name === 'MaterialStates')
    );
    
    const states: any[] = [];
    stateDataObjs.forEach((dataObj: any) => {
      if (dataObj?.businessObject?.extensionElements?.values) {
        dataObj.businessObject.extensionElements.values.forEach((val: any) => {
          if (val.$type === 'MaterialState' || val.$type?.includes('MaterialState')) {
            states.push(val);
          }
        });
      }
    });
    setAllMaterialStates(states);

    if (element && element.type === 'bpmn:SequenceFlow') {
      const businessObject = element.businessObject;
      const extensionElements = businessObject.extensionElements;
      
      
      if (extensionElements && extensionElements.values) {
        extensionElements.values.forEach((_val: any, _idx: number) => {
        });
        
        // Look for dexpi:Stream with various possible type names, or legacy <Stream>
        const dexpiStream = extensionElements.values.find(
          (e: any) => {
            const type = e.$type || '';
            return type === 'dexpi:Stream' || 
                   type === 'dexpi:stream' || 
                   type === 'Stream' ||  // Legacy format
                   type.toLowerCase().includes('stream');
          }
        );
        
        
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
          let sourcePortRef = dexpiStream.sourcePortRef || '';
          let targetPortRef = dexpiStream.targetPortRef || '';
          
          const flowName = businessObject.name || '';
          
          if (flowName && !sourcePortRef && !targetPortRef) {
            // Parse the flow name to extract port names
            const parts = flowName.split(' - ').map((p: string) => p.trim());
            
            if (parts.length === 2) {
              // Format: "SourcePort - TargetPort"
              const sourcePortName = parts[0];
              const targetPortName = parts[1];
              
              
              // Find actual port IDs from source and target elements
              if (businessObject.sourceRef) {
                const sourcePort = findPortByName(businessObject.sourceRef, sourcePortName);
                if (sourcePort) {
                  // Use unique port ID format: elementId_portName
                  sourcePortRef = `${businessObject.sourceRef.id}_${sourcePortName}`;
                }
              }
              if (businessObject.targetRef) {
                const targetPort = findPortByName(businessObject.targetRef, targetPortName);
                if (targetPort) {
                  // Use unique port ID format: elementId_portName
                  targetPortRef = `${businessObject.targetRef.id}_${targetPortName}`;
                }
              }
            } else if (parts.length === 3) {
              // Format: "SourcePort - Stream ID - TargetPort"
              const sourcePortName = parts[0];
              const targetPortName = parts[2];
              
              
              // Find actual port IDs
              if (businessObject.sourceRef) {
                const sourcePort = findPortByName(businessObject.sourceRef, sourcePortName);
                if (sourcePort) {
                  // Use unique port ID format: elementId_portName
                  sourcePortRef = `${businessObject.sourceRef.id}_${sourcePortName}`;
                }
              }
              if (businessObject.targetRef) {
                const targetPort = findPortByName(businessObject.targetRef, targetPortName);
                if (targetPort) {
                  // Use unique port ID format: elementId_portName
                  targetPortRef = `${businessObject.targetRef.id}_${targetPortName}`;
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
          
          // Try multiple ways to access attributes
          let attrs = dexpiStream.attributes || [];
          if (typeof dexpiStream.get === 'function') {
            attrs = dexpiStream.get('attributes') || attrs;
          }
          
          // Check if this is legacy format with XML child elements
          // Legacy format: <Stream><MassFlow><Value>...</Value><Unit>...</Unit></MassFlow></Stream>
          if (attrs.length === 0 && dexpiStream.$children) {
            
            attrs = dexpiStream.$children
              .filter((child: any) => child.$type !== 'TemplateReference' && child.$type !== 'MaterialStateReference')
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
          
          // Extract MaterialStateReference and TemplateReference
          if (dexpiStream.$children) {
            const stateRef = dexpiStream.$children.find((c: any) => c.$type === 'MaterialStateReference');
            const templateRef = dexpiStream.$children.find((c: any) => c.$type === 'TemplateReference');
            
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

    Object.assign(dexpiStream, updates);
    setStreamData({ ...streamData, ...updates });

    modeling.updateProperties(element, {
      extensionElements
    });
  };

  const addAttribute = () => {
    const moddle = modeler.get('moddle');
    const newAttr = moddle.create('dexpi:StreamAttribute', {
      name: 'New Attribute',
      value: '',
      unit: '',
      scope: 'Design',
      range: 'Nominal',
      provenance: 'Calculated',
      qualifier: 'Average'
    });

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
    const moddle = modeler.get('moddle');
    const updatedAttrs = attributes.map((attr, i) => {
      if (i === index) {
        return moddle.create('dexpi:StreamAttribute', {
          name: updates.name !== undefined ? updates.name : attr.name,
          nameUri: updates.nameUri !== undefined ? updates.nameUri : attr.nameUri,
          value: updates.value !== undefined ? updates.value : attr.value,
          unit: updates.unit !== undefined ? updates.unit : attr.unit,
          unitUri: updates.unitUri !== undefined ? updates.unitUri : attr.unitUri,
          scope: updates.scope !== undefined ? updates.scope : attr.scope,
          range: updates.range !== undefined ? updates.range : attr.range,
          provenance: updates.provenance !== undefined ? updates.provenance : attr.provenance,
          qualifier: updates.qualifier !== undefined ? updates.qualifier : attr.qualifier
        });
      }
      return attr;
    });
    setAttributes(updatedAttrs);
    updateStream({ attributes: updatedAttrs });
  };

  if (!element || (element.type !== 'bpmn:SequenceFlow' && element.type !== 'bpmn:Association')) {
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
        <label>
          Stream Type:
          <select 
            value={streamData.streamType || (element.type === 'bpmn:Association' ? 'InformationFlow' : 'MaterialFlow')}
            onChange={(e) => updateStream({ streamType: e.target.value as any })}
          >
            <option value="MaterialFlow">Material Flow</option>
            <option value="ThermalEnergyFlow">Thermal Energy Flow</option>
            <option value="MechanicalEnergyFlow">Mechanical Energy Flow</option>
            <option value="ElectricalEnergyFlow">Electrical Energy Flow</option>
            <option value="EnergyFlow">Energy Flow — generic</option>
            {/* InformationFlow only valid for Associations, not SequenceFlows */}
            {element.type === 'bpmn:Association' && (
              <option value="InformationFlow">Information Flow</option>
            )}
          </select>
        </label>
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
            value={streamData.sourcePortRef || ''} 
            onChange={(e) => updateStream({ sourcePortRef: e.target.value })}
            placeholder="Source port ID..."
          />
        </label>
      </div>

      <div className="property-group">
        <label>
          Target Port Ref:
          <input 
            type="text" 
            value={streamData.targetPortRef || ''} 
            onChange={(e) => updateStream({ targetPortRef: e.target.value })}
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
              const label = state.$children?.find((c: any) => c.$type === 'Label')?.$body || 'N/A';
              const identifier = state.$children?.find((c: any) => c.$type === 'Identifier')?.$body || 'N/A';
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
          <div><strong>Label:</strong> {materialState.$children?.find((c: any) => c.$type === 'Label')?.$body || 'N/A'}</div>
          <div><strong>Identifier:</strong> {materialState.$children?.find((c: any) => c.$type === 'Identifier')?.$body || 'N/A'}</div>
          <div><strong>UID:</strong> <code style={{ background: 'rgba(0,0,0,0.1)', padding: '2px 6px', borderRadius: '3px', fontSize: '0.85em' }}>{materialState.uid}</code></div>
            {(materialState._refProvenance || materialState._refRange) && (
              <div style={{ marginTop: '8px', padding: '6px', background: 'rgba(255,255,255,0.7)', borderRadius: '3px', fontSize: '0.85rem' }}>
                {materialState._refProvenance && <div><strong>Reference Provenance:</strong> {materialState._refProvenance}</div>}
                {materialState._refRange && <div><strong>Reference Range:</strong> {materialState._refRange}</div>}
              </div>
            )}
            {materialState.$children?.find((c: any) => c.$type === 'Flow') && (
              <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #90caf9' }}>
                <strong>Flow Properties:</strong>
                {(() => {
                  const flowChild = materialState.$children.find((c: any) => c.$type === 'Flow');
                  const moleFlowChild = flowChild?.$children?.find((c: any) => c.$type === 'MoleFlow');
                  const compositionChild = flowChild?.$children?.find((c: any) => c.$type === 'Composition');
                  
                  return (
                    <>
                      {moleFlowChild && (
                        <div>• Mole Flow: {moleFlowChild.$children?.find((c: any) => c.$type === 'Value')?.$body} {moleFlowChild.$children?.find((c: any) => c.$type === 'Unit')?.$body}</div>
                      )}
                      {compositionChild && (
                        <div style={{ marginTop: '8px' }}>
                          <strong>Composition:</strong>
                          <div style={{ marginLeft: '12px', fontSize: '0.85rem' }}>
                            <div>Basis: {compositionChild.$children?.find((c: any) => c.$type === 'Basis')?.$body || 'N/A'}</div>
                            <div>Display: {compositionChild.$children?.find((c: any) => c.$type === 'Display')?.$body || 'N/A'}</div>
                            {compositionChild.$children?.filter((c: any) => c.$type === 'Fraction').length > 0 && (
                              <div style={{ marginTop: '4px' }}>
                                <strong>Fractions:</strong>
                                {compositionChild.$children
                                  .filter((c: any) => c.$type === 'Fraction')
                                  .map((f: any, idx: number) => {
                                    const value = parseFloat(f.$children?.find((c: any) => c.$type === 'Value')?.$body || '0');
                                    const percentage = (value * 100).toFixed(2);
                                    return <div key={idx}>  Component {idx + 1}: {percentage}%</div>;
                                  })}
                                <div style={{ marginTop: '2px', fontWeight: 'bold' }}>
                                  Total: {compositionChild.$children
                                    .filter((c: any) => c.$type === 'Fraction')
                                    .reduce((sum: number, f: any) => {
                                      const value = parseFloat(f.$children?.find((c: any) => c.$type === 'Value')?.$body || '0');
                                      return sum + value;
                                    }, 0) * 100}%
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Material Template Information */}
      {materialTemplate && (
        <div className="property-group" style={{ background: '#f3e5f5', padding: '12px', borderRadius: '4px', marginTop: '12px' }}>
          <h4 style={{ margin: '0 0 8px 0', color: '#7b1fa2' }}>🧪 Material Template</h4>
          <div style={{ fontSize: '0.9rem' }}>
            <div><strong>Label:</strong> {materialTemplate.$children?.find((c: any) => c.$type === 'Label')?.$body || 'N/A'}</div>
            <div><strong>Identifier:</strong> {materialTemplate.$children?.find((c: any) => c.$type === 'Identifier')?.$body || 'N/A'}</div>
            <div><strong>Components:</strong> {materialTemplate.$children?.find((c: any) => c.$type === 'NumberOfMaterialComponents')?.$body || 'N/A'}</div>
            <div><strong>Phases:</strong> {materialTemplate.$children?.find((c: any) => c.$type === 'NumberOfPhases')?.$body || 'N/A'}</div>
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
            
            <label>
              Name:
              <input 
                type="text" 
                value={attr.name || ''} 
                onChange={(e) => updateAttribute(index, { name: e.target.value })}
              />
            </label>

            <label>
              Name URI:
              <input
                type="text"
                value={attr.nameUri || ''}
                onChange={(e) => updateAttribute(index, { nameUri: e.target.value })}
                placeholder="e.g. https://qudt.org/vocab/quantitykind/MassFlowRate"
                style={{ fontFamily: 'monospace', fontSize: '0.85em' }}
              />
            </label>

            <label>
              Value:
              <input 
                type="text" 
                value={attr.value || ''} 
                onChange={(e) => updateAttribute(index, { value: e.target.value })}
              />
            </label>

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
                value={attr.scope || 'Design'} 
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
                value={attr.range || 'Nominal'} 
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
                value={attr.provenance || 'Calculated'} 
                onChange={(e) => updateAttribute(index, { provenance: e.target.value })}
              >
                <option value="">-- Select Provenance --</option>
                {DexpiEnumerations.Provenance.map(prov => (
                  <option key={prov} value={prov}>{prov}</option>
                ))}
              </select>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
};
