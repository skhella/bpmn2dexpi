import React, { useRef, useEffect, useState } from 'react';
import BpmnModeler from 'bpmn-js/lib/Modeler';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import dexpiExtension from './dexpi';
import dexpiDescriptor from './dexpi/moddle/dexpi.json';
import { DexpiPropertiesPanel, StreamPropertiesPanel } from './components/DexpiPropertiesPanel';
import { MaterialLibraryPanel } from './components/MaterialLibraryPanel';
import { MaterialEditorPanel } from './components/MaterialEditorPanel';
import { transformer } from './transformer/BpmnToDexpiTransformer';
import './App.css';

const initialDiagram = '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"\n' +
  '                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"\n' +
  '                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"\n' +
  '                  xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"\n' +
  '                  id="Definitions_1"\n' +
  '                  targetNamespace="http://bpmn.io/schema/bpmn">\n' +
  '  <bpmn:process id="Process_1" isExecutable="false">\n' +
  '  </bpmn:process>\n' +
  '  <bpmndi:BPMNDiagram id="BPMNDiagram_1">\n' +
  '    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">\n' +
  '    </bpmndi:BPMNPlane>\n' +
  '  </bpmndi:BPMNDiagram>\n' +
  '</bpmn:definitions>';

function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [modeler, setModeler] = useState<BpmnModeler | null>(null);
  const [selectedElement, setSelectedElement] = useState<any>(null);
  const [validationMessage, setValidationMessage] = useState<string>('');
  const [currentPlane, setCurrentPlane] = useState<string | null>(null);
  const [planeStack, setPlaneStack] = useState<string[]>([]);
  const [showPorts, setShowPorts] = useState<boolean>(false);
  const [showMaterialLibrary, setShowMaterialLibrary] = useState<boolean>(false);
  const [materialLibraryTab, setMaterialLibraryTab] = useState<'templates' | 'components' | 'states'>('templates');
  const [selectedMaterialItem, setSelectedMaterialItem] = useState<{type: 'template' | 'component' | 'state', data: any} | null>(null);
  const isNavigatingBack = useRef(false);
  
  // Update global flag for port visibility
  useEffect(() => {
    (window as any).__dexpi_show_ports__ = showPorts;
    
    // Force canvas re-render when port visibility changes
    if (modeler) {
      const elementRegistry = modeler.get('elementRegistry');
      const eventBus = modeler.get('eventBus');
      
      // Get all elements to trigger re-render
      const allElements = elementRegistry.filter((el: any) => {
        // Only include elements that have graphics rendered
        const gfx = elementRegistry.getGraphics(el);
        return gfx && 
          el.type !== 'label' &&
          el.type !== 'bpmn:DataObjectReference' &&
          el.type !== 'bpmn:DataInputAssociation' &&
          el.type !== 'bpmn:DataOutputAssociation' &&
          !el.labelTarget;
      });
      
      // Trigger render events for all elements (shapes and connections)
      allElements.forEach((element: any) => {
        eventBus.fire('element.changed', { element });
      });
      
      // After re-render, directly update SequenceFlow graphics
      setTimeout(() => {
        // Helper function to check if an event is a port proxy
        const isPortProxyEvent = (element: any): boolean => {
          if (!element || (element.type !== 'bpmn:StartEvent' && element.type !== 'bpmn:EndEvent')) {
            return false;
          }
          
          const businessObject = element.businessObject;
          const extensionElements = businessObject?.extensionElements;
          if (!extensionElements || !extensionElements.values) return false;
          
          // Check if this event has a port definition
          const portsContainer = extensionElements.values.find((e: any) => {
            const type = (e.$type || '').toLowerCase();
            return type === 'ports' || type.includes('ports') || e.port !== undefined;
          });
          
          if (!portsContainer) return false;
          
          // Extract port name
          let portName: string | null = null;
          if (Array.isArray(portsContainer.port) && portsContainer.port.length > 0) {
            portName = portsContainer.port[0].name || portsContainer.port[0].label;
          } else if (portsContainer.port) {
            portName = portsContainer.port.name || portsContainer.port.label;
          } else if (portsContainer.$children && portsContainer.$children.length > 0) {
            portName = portsContainer.$children[0].name || portsContainer.$children[0].label;
          }
          
          if (!portName) return false;
          
          // Check if parent has matching port
          const parent = element.parent;
          if (!parent || (parent.type !== 'bpmn:SubProcess' && parent.type !== 'bpmn:Process')) {
            return false;
          }
          
          const parentExtensions = parent.businessObject?.extensionElements;
          if (!parentExtensions || !parentExtensions.values) return false;
          
          const parentPortsContainer = parentExtensions.values.find((e: any) => {
            const type = (e.$type || '').toLowerCase();
            return type === 'ports' || type.includes('ports') || e.port !== undefined;
          });
          
          if (!parentPortsContainer) return false;
          
          // Extract parent ports
          let parentPorts: any[] = [];
          if (Array.isArray(parentPortsContainer.port)) {
            parentPorts = parentPortsContainer.port;
          } else if (parentPortsContainer.port) {
            parentPorts = [parentPortsContainer.port];
          } else if (parentPortsContainer.$children) {
            parentPorts = parentPortsContainer.$children;
          }
          
          // Check if parent has matching port
          return parentPorts.some((port: any) => {
            const pName = port.name || port.label;
            return pName === portName;
          });
        };
        
        const allFlows = elementRegistry.filter((el: any) => el.type === 'bpmn:SequenceFlow');
        allFlows.forEach((flow: any) => {
          const gfx = elementRegistry.getGraphics(flow);
          if (!gfx) return;
          
          const source = flow.source;
          const target = flow.target;
          
          // Use proper proxy detection
          const isSourceProxy = isPortProxyEvent(source);
          const isTargetProxy = isPortProxyEvent(target);
          
          if (showPorts && (isSourceProxy || isTargetProxy)) {
            // Apply dimming to entire connection
            gfx.setAttribute('opacity', '0.1');
            
            // Also dim the label if it exists
            if (flow.label) {
              const labelGfx = elementRegistry.getGraphics(flow.label);
              if (labelGfx) {
                labelGfx.setAttribute('opacity', '0.1');
              }
            }
          } else {
            // Reset styling
            gfx.removeAttribute('opacity');
            
            // Reset label opacity
            if (flow.label) {
              const labelGfx = elementRegistry.getGraphics(flow.label);
              if (labelGfx) {
                labelGfx.removeAttribute('opacity');
              }
            }
          }
        });
      }, 100);
      
    }
  }, [showPorts, modeler]);

  const navigateToSubprocess = (subprocess: any) => {
    if (!modeler) return;

    const canvas = modeler.get('canvas');
    
    // Get the current root element before navigating
    const rootElement = canvas.getRootElement();
    if (rootElement) {
      setPlaneStack(prevStack => [...prevStack, rootElement.id]);
    }

    // Navigate to subprocess
    canvas.setRootElement(subprocess);
    canvas.zoom('fit-viewport');
  };

  const navigateToParent = () => {
    if (!modeler || planeStack.length === 0) return;

    isNavigatingBack.current = true;
    const canvas = modeler.get('canvas');
    const elementRegistry = modeler.get('elementRegistry');
    
    // Get parent plane ID from stack
    const newStack = [...planeStack];
    const parentId = newStack.pop();
    setPlaneStack(newStack);

    if (parentId) {
      const parentElement = elementRegistry.get(parentId);
      if (parentElement) {
        canvas.setRootElement(parentElement);
        canvas.zoom('fit-viewport');
      }
    }
    
    // Reset flag after a short delay to allow root.set to process
    setTimeout(() => {
      isNavigatingBack.current = false;
    }, 100);
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const bpmnModeler = new BpmnModeler({
      container: containerRef.current,
      keyboard: {
        bindTo: document
      },
      moddleExtensions: {
        dexpi: dexpiDescriptor
      },
      additionalModules: [
        dexpiExtension
      ]
    });

    bpmnModeler.importXML(initialDiagram).then(() => {
      const canvas = bpmnModeler.get('canvas');
      canvas.zoom('fit-viewport');
    }).catch((err: any) => {
      console.error('Failed to import BPMN:', err);
    });

    const eventBus = bpmnModeler.get('eventBus');
    const canvas = bpmnModeler.get('canvas');
    
    // Track current root to detect navigation
    let currentRootElement = canvas.getRootElement();
    
    eventBus.on('selection.changed', (e: any) => {
      const element = e.newSelection[0];
      setSelectedElement(element || null);
      
      // Close material editor when selecting a diagram element
      if (element) {
        setSelectedMaterialItem(null);
      }
      
      // Auto-open Material Library when clicking on material data objects
      if (element?.type === 'bpmn:DataObjectReference') {
        const name = element.businessObject?.name;
        if (name === 'MaterialTemplates' || name === 'MaterialStates' || name === 'Base Case MaterialStates') {
          const tab = name === 'MaterialTemplates' ? 'templates' : 'states';
          setMaterialLibraryTab(tab);
          setShowMaterialLibrary(true);
        }
      }
    });

    // Track ALL plane changes - fires when clicking marker or navigating
    eventBus.on('root.set', (e: any) => {
      const newRoot = e.element;
      
      // Skip tracking if we're navigating back (to prevent adding to stack)
      if (isNavigatingBack.current) {
        if (newRoot) {
          currentRootElement = newRoot;
          setCurrentPlane(newRoot.id);
        }
        return;
      }
      
      if (newRoot && currentRootElement) {
        // When clicking into a subprocess, the new root will be the subprocess
        if (newRoot.id !== currentRootElement.id) {
          // If we're going INTO a subprocess (the new root is a subprocess)
          // Add the PREVIOUS root (the parent) to the stack
          if (newRoot.type === 'bpmn:SubProcess' || newRoot.businessObject.$type === 'bpmn:SubProcess') {
            // IMPORTANT: Capture the previous root ID NOW before it changes
            const previousRootId = currentRootElement.id;
            setPlaneStack(prevStack => [...prevStack, previousRootId]);
          }
        }
      }
      
      // Update currentRootElement AFTER we've captured the previous value
      if (newRoot) {
        currentRootElement = newRoot;
        setCurrentPlane(newRoot.id);
      }
    });

    setModeler(bpmnModeler);

    return () => {
      bpmnModeler.destroy();
    };
  }, []);

  const handleExportBpmn = async () => {
    if (!modeler) return;

    try {
      const result = await modeler.saveXML({ format: true });
      const xml = result.xml;
      
      const blob = new Blob([xml || ''], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'process-model.bpmn';
      a.click();
      URL.revokeObjectURL(url);
      
      setValidationMessage('BPMN XML exported successfully!');
    } catch (err) {
      console.error('Export failed:', err);
      setValidationMessage('Export failed: ' + (err as Error).message);
    }
  };

  const handleExportDexpi = async () => {
    if (!modeler) return;

    try {
      // Step 1: Generate BPMN XML with DEXPI extensions
      const result = await modeler.saveXML({ format: true });
      const bpmnXml = result.xml;
      
      if (!bpmnXml) {
        setValidationMessage('No BPMN XML to transform');
        return;
      }


      // Step 2: Transform BPMN to DEXPI XML
      const dexpiXml = await transformer.transform(bpmnXml, {
        projectName: 'DEXPI Process Model',
        projectDescription: 'Generated from BPMN.io',
        author: 'DEXPI Process Tool'
      });
      
      
      // Step 3: Download DEXPI XML
      const blob = new Blob([dexpiXml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'process-model-dexpi.xml';
      a.click();
      URL.revokeObjectURL(url);
      
      setValidationMessage('DEXPI XML exported successfully! Check console for details.');
    } catch (err) {
      console.error('DEXPI transformation failed:', err);
      setValidationMessage('DEXPI export failed: ' + (err as Error).message);
    }
  };

  const handleExportSvg = async () => {
    if (!modeler) return;

    try {
      const canvas = modeler.get('canvas');
      const { svg } = await modeler.saveSVG();
      
      // Download SVG
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'process-diagram.svg';
      a.click();
      URL.revokeObjectURL(url);
      
      setValidationMessage('SVG exported successfully!');
    } catch (err) {
      console.error('SVG export failed:', err);
      setValidationMessage('SVG export failed: ' + (err as Error).message);
    }
  };

  const handleImportBpmn = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bpmn,.xml';
    input.onchange = async (e: any) => {
      const file = e.target.files[0];
      if (!file || !modeler) return;

      try {
        const text = await file.text();
        await modeler.importXML(text);
        setValidationMessage('BPMN imported successfully!');
        // Reset navigation state
        setPlaneStack([]);
        setCurrentPlane(null);
        const canvas = modeler.get('canvas');
        canvas.zoom('fit-viewport');
      } catch (err) {
        console.error('Import failed:', err);
        setValidationMessage('Import failed: ' + (err as Error).message);
      }
    };
    input.click();
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>DEXPI Process Tool</h1>
        <div className="toolbar">
          {planeStack.length > 0 && (
            <button onClick={navigateToParent} className="btn btn-nav" title="Back to parent">
              ← Back to Parent
            </button>
          )}
          <button 
            onClick={() => setShowPorts(!showPorts)} 
            className={`btn ${showPorts ? 'btn-active' : ''}`}
            title="Toggle port visibility"
          >
            {showPorts ? '● Ports: ON' : '○ Ports: OFF'}
          </button>
          <button 
            onClick={() => setShowMaterialLibrary(!showMaterialLibrary)} 
            className={`btn ${showMaterialLibrary ? 'btn-active' : ''}`}
            title="Toggle material library"
          >
            {showMaterialLibrary ? '📚 Materials' : '📚 Materials'}
          </button>
          <button onClick={handleImportBpmn} className="btn">Import BPMN</button>
          <button onClick={handleExportBpmn} className="btn">Export BPMN</button>
          <button onClick={handleExportSvg} className="btn">Export SVG</button>
          <button onClick={handleExportDexpi} className="btn btn-primary">Export DEXPI XML</button>
        </div>
      </header>
      
      <div className="app-content">
        <div 
          className="canvas-container" 
          ref={containerRef}
          onClick={() => {
            // Close material editor panel when clicking on canvas
            if (selectedMaterialItem) {
              setSelectedMaterialItem(null);
            }
          }}
        ></div>
        
        {showMaterialLibrary && (
          <>
            <div 
              className="material-library-overlay" 
              onClick={() => setShowMaterialLibrary(false)}
            ></div>
            <div className="material-library-container">
              <MaterialLibraryPanel 
                modeler={modeler} 
                initialTab={materialLibraryTab}
                onSelectItem={setSelectedMaterialItem}
                selectedItemId={selectedMaterialItem?.data.uid}
              />
            </div>
          </>
        )}
        
        <div className="properties-panel">
          {selectedMaterialItem ? (
            <MaterialEditorPanel 
              item={selectedMaterialItem} 
              modeler={modeler}
              onClose={() => setSelectedMaterialItem(null)}
            />
          ) : selectedElement && selectedElement.type !== 'bpmn:SequenceFlow' ? (
            <DexpiPropertiesPanel element={selectedElement} modeler={modeler} />
          ) : selectedElement && selectedElement.type === 'bpmn:SequenceFlow' ? (
            <StreamPropertiesPanel element={selectedElement} modeler={modeler} />
          ) : (
            <div className="no-selection">
              <p>Select an element to view properties</p>
            </div>
          )}
        </div>
      </div>
      
      {validationMessage && (
        <div className="validation-message">
          {validationMessage}
          <button onClick={() => setValidationMessage('')} className="btn-close">×</button>
        </div>
      )}
    </div>
  );
}

export default App;
