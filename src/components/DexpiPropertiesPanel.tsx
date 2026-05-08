import React from 'react';
import type { DexpiElement, DexpiPort, DexpiStream } from '../dexpi/moddle';
import { DexpiEnumerations } from '../utils/dexpiEnumerations';
import { DexpiProcessClassRegistry } from '../transformer/DexpiProcessClassRegistry';
// Vite ?raw import — bundles Process.xml as a string at build time (no runtime fetch needed)
import processXmlRaw from '../../dexpi-schema-files/Process.xml?raw';

// Build registry once at module load — synchronous, browser-safe. This is
// the *base* registry (Process.xml only); when the user has imported DEXPI
// Profiles, the panel rebuilds an augmented registry on demand via
// useStepClasses() below, so Profile-declared classes (e.g. BiologicalReactor)
// surface in the dexpiType dropdown alongside the standard DEXPI 2.0 classes.
const DEXPI_REGISTRY = DexpiProcessClassRegistry.fromXml(processXmlRaw);

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
  // Augmented class list: Process.xml + any loaded Profiles. Recomputed
  // when the Profile list changes; profile-loading errors here would have
  // already been caught in App.handleImportProfile, so this is a hot path
  // that should never throw — wrap defensively just in case.
  const dropdownClasses = React.useMemo<string[]>(() => {
    if (!loadedProfiles || loadedProfiles.length === 0) return STEP_CLASSES;
    try {
      const augmented = DexpiProcessClassRegistry.fromXmlSources([
        { name: 'Process.xml', xml: processXmlRaw },
        ...loadedProfiles,
      ], { strictSupertypes: false });
      return filterTaskClasses(augmented.concreteClasses());
    } catch {
      // Defensive: if a Profile that passed import-time validation now fails
      // to merge with the panel's reduced source set, fall back to the base
      // class list rather than break the dropdown entirely.
      return STEP_CLASSES;
    }
  }, [loadedProfiles]);
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
            anchorY: updates.anchorY !== undefined ? updates.anchorY : p.anchorY,
            subReference: updates.subReference !== undefined ? updates.subReference : (p as any).subReference,
            superReference: updates.superReference !== undefined ? updates.superReference : (p as any).superReference,
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
          provenance: updates.provenance !== undefined ? updates.provenance : attr.provenance,
          required: updates.required !== undefined ? updates.required : attr.required
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

          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
            <input
              type="checkbox"
              checked={!!attr.required}
              onChange={(e) => updateAttribute(index, { required: e.target.checked || undefined })}
            />
            <span>Required in generated Profile</span>
          </label>
          {attr.required && (
            <div style={{ fontSize: '0.75rem', color: '#555', marginTop: '2px', marginLeft: '22px' }}>
              The Profile generator will narrow this property's lower bound to 1
              for the wrapping class. DEXPI's lower=0 default is overridden — on
              reload, the loaded Profile takes precedence.
            </div>
          )}
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
              return {
                name: propertyName,
                value: readData('Value'),
                unit: readData('Unit'),
                scope: readData('Scope') || 'Design',
                range: readData('Range') || 'Nominal',
                provenance: readData('Provenance') || 'Calculated',
                qualifier: readData('Qualifier') || 'Average',
              };
            }).filter((a: any) => a.value);
            if (carrierAttrs.length > 0) attrs = carrierAttrs;
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

    Object.assign(dexpiStream, updates);
    setStreamData({ ...streamData, ...updates });

    modeling.updateProperties(element, {
      extensionElements
    });
  };

  const addAttribute = () => {
    const moddle = modeler.get('moddle');
    const newAttr = moddle.create('dexpi:Attribute', {
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
        return moddle.create('dexpi:Attribute', {
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
