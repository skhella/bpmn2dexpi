import { useRef, useEffect, useState } from 'react';
import BpmnModeler from 'bpmn-js/lib/Modeler';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import dexpiExtension from './dexpi';
import dexpiDescriptor from './dexpi/moddle/dexpi.json';
import { DexpiPropertiesPanel, StreamPropertiesPanel } from './components/DexpiPropertiesPanel';
import { MaterialLibraryPanel } from './components/MaterialLibraryPanel';
import { MaterialEditorPanel } from './components/MaterialEditorPanel';
import { Neo4jExportModal } from './components/Neo4jExportModal';
import { transformer } from './transformer/BpmnToDexpiTransformer';
import { DexpiToBpmnTransformer } from './transformer/DexpiToBpmnTransformer';
import { exportToNeo4j } from './utils/neo4jExporter';
import type { Neo4jConfig } from './utils/neo4jExporter';
import logoImg from './assets/cropped_logo_B2P.png';
import './App.css';

// Normalize BPMN XML: fix ns0:ports ↔ ports round-trip issue.
// bpmn-js assigns ns0: prefix to unknown <ports> elements; we strip it back.
const normalizeBpmnXml = (xml: string): string =>
  xml.replace(/<(\/?)ns\d+:ports/g, '<$1ports')
     .replace(/xmlns:ns\d+=""/g, '');

const AUTOSAVE_KEY = 'bpmn2dexpi_autosave';

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
  const [_currentPlane, setCurrentPlane] = useState<string | null>(null);
  const [planeStack, setPlaneStack] = useState<string[]>([]);
  const [showPorts, setShowPorts] = useState<boolean>(false);
  const [showMaterialLibrary, setShowMaterialLibrary] = useState<boolean>(false);
  const [materialLibraryTab, setMaterialLibraryTab] = useState<'templates' | 'components' | 'states'>('templates');
  const [selectedMaterialItem, setSelectedMaterialItem] = useState<{type: 'template' | 'component' | 'state', data: any} | null>(null);
  const [showNeo4jModal, setShowNeo4jModal] = useState(false);
  const [neo4jExporting, setNeo4jExporting] = useState(false);
  const [neo4jProgress, setNeo4jProgress] = useState<{ current: number; total: number; stage: string } | null>(null);
  const isNavigatingBack = useRef(false);
  
  // Update global flag for port visibility
  useEffect(() => {
    (window as any).__dexpi_show_ports__ = showPorts;
    
    // Force canvas re-render when port visibility changes
    if (modeler) {
      const elementRegistry = modeler.get('elementRegistry') as any;
      const eventBus = modeler.get('eventBus') as any;
      
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
          
          // Check for port-based proxy (events WITH ports matching parent)
          if (extensionElements && extensionElements.values) {
            const portsContainer = extensionElements.values.find((e: any) => {
              const type = (e.$type || '').toLowerCase();
              return type === 'ports' || type.includes('ports') || e.port !== undefined;
            });
            
            if (portsContainer) {
              // Extract port name
              let portName: string | null = null;
              if (Array.isArray(portsContainer.port) && portsContainer.port.length > 0) {
                portName = portsContainer.port[0].name || portsContainer.port[0].label;
              } else if (portsContainer.port) {
                portName = portsContainer.port.name || portsContainer.port.label;
              } else if (portsContainer.$children && portsContainer.$children.length > 0) {
                portName = portsContainer.$children[0].name || portsContainer.$children[0].label;
              }
              
              if (portName) {
                // Check if parent has matching port
                const parent = element.parent;
                if (parent && (parent.type === 'bpmn:SubProcess' || parent.type === 'bpmn:Process')) {
                  const parentExtensions = parent.businessObject?.extensionElements;
                  if (parentExtensions && parentExtensions.values) {
                    const parentPortsContainer = parentExtensions.values.find((e: any) => {
                      const type = (e.$type || '').toLowerCase();
                      return type === 'ports' || type.includes('ports') || e.port !== undefined;
                    });
                    
                    if (parentPortsContainer) {
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
                      const hasMatchingParentPort = parentPorts.some((port: any) => {
                        const pName = port.name || port.label;
                        return pName === portName;
                      });
                      
                      if (hasMatchingParentPort) {
                        return true;
                      }
                    }
                  }
                }
              }
            }
          }
          
          // Check for portless proxy (events WITHOUT ports connecting to activities with matching ports)
          // This handles legacy BPMN files where events don't have extensionElements
          const eventName = businessObject?.name;
          if (!eventName || !eventName.trim()) {
            return false;
          }
          
          // Get all incoming/outgoing sequence flows
          const flows = [...(element.incoming || []), ...(element.outgoing || [])];
          
          for (const flow of flows) {
            // Get the other end of the connection
            const otherElement = flow.source?.id === element.id ? flow.target : flow.source;
            
            // Check if other element is an Activity (Task or SubProcess)
            if (otherElement && (
              otherElement.type === 'bpmn:Task' ||
              otherElement.type === 'bpmn:SubProcess' ||
              otherElement.type === 'bpmn:ServiceTask' ||
              otherElement.type === 'bpmn:UserTask' ||
              otherElement.type === 'bpmn:ManualTask' ||
              otherElement.type === 'bpmn:ScriptTask' ||
              otherElement.type === 'bpmn:BusinessRuleTask' ||
              otherElement.type === 'bpmn:SendTask' ||
              otherElement.type === 'bpmn:ReceiveTask'
            )) {
              const activityExtensions = otherElement.businessObject?.extensionElements;
              if (activityExtensions && activityExtensions.values) {
                const activityPortsContainer = activityExtensions.values.find((e: any) => {
                  const type = (e.$type || '').toLowerCase();
                  return type === 'ports' || type.includes('ports') || e.port !== undefined;
                });
                
                if (activityPortsContainer) {
                  let activityPorts: any[] = [];
                  if (Array.isArray(activityPortsContainer.port)) {
                    activityPorts = activityPortsContainer.port;
                  } else if (activityPortsContainer.port) {
                    activityPorts = [activityPortsContainer.port];
                  } else if (activityPortsContainer.$children) {
                    activityPorts = activityPortsContainer.$children;
                  }
                  
                  // Check if any activity port matches the event name
                  const hasMatchingPort = activityPorts.some((port: any) => {
                    const portName = port.name || port.label;
                    return portName === eventName;
                  });
                  
                  if (hasMatchingPort) {
                    return true;
                  }
                }
              }
            }
          }
          
          return false;
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

  const navigateToParent = () => {
    if (!modeler || planeStack.length === 0) return;

    isNavigatingBack.current = true;
    const canvas = modeler.get('canvas') as any;
    const elementRegistry = modeler.get('elementRegistry') as any;
    
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

    let isDestroyed = false;

    const bpmnModeler = new BpmnModeler({
      container: containerRef.current,
      moddleExtensions: {
        dexpi: dexpiDescriptor
      },
      additionalModules: [
        dexpiExtension
      ]
    });

    const eventBus = bpmnModeler.get('eventBus') as any;
    
    // Track current root to detect navigation
    let currentRootElement: any = null;
    
    eventBus.on('selection.changed', (e: any) => {
      if (isDestroyed) return;
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
      if (isDestroyed) return;
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

    // Restore autosaved diagram or use initial empty diagram
    const savedXml = localStorage.getItem(AUTOSAVE_KEY);
    const diagramToLoad = savedXml || initialDiagram;

    bpmnModeler.importXML(normalizeBpmnXml(diagramToLoad)).then(() => {
      if (isDestroyed) return;
      
      const canvas = bpmnModeler.get('canvas') as any;
      canvas.zoom('fit-viewport');
      
      // Initialize currentRootElement after import is complete
      currentRootElement = canvas.getRootElement();
      
      // Auto-save on every diagram change
      eventBus.on('commandStack.changed', () => {
        bpmnModeler.saveXML({ format: true }).then(({ xml }) => {
          if (xml) localStorage.setItem(AUTOSAVE_KEY, normalizeBpmnXml(xml));
        });
      });

      // Now set the modeler state - the app is ready
      setModeler(bpmnModeler);
      (window as any).__modeler = bpmnModeler;
      if (savedXml) setValidationMessage('Restored previous session');

      // Reanchor ports that lack explicit anchor positions after a short
      // delay to let the modeler fully settle (ports need to be in the registry)
      setTimeout(() => reanchorPortsAfterImport(bpmnModeler), 300);
    }).catch((err: any) => {
      if (isDestroyed) return;
      console.error('Failed to import BPMN:', err);
      // If autosaved data was corrupted, fall back to empty diagram
      if (savedXml) {
        localStorage.removeItem(AUTOSAVE_KEY);
        bpmnModeler.importXML(normalizeBpmnXml(initialDiagram)).then(() => {
          setModeler(bpmnModeler);
        });
      } else {
        setModeler(bpmnModeler);
      }
    });

    return () => {
      isDestroyed = true;
      bpmnModeler.destroy();
    };
  }, []);

  const handleExportBpmn = async () => {
    if (!modeler) return;

    try {
      const rawResult = await modeler.saveXML({ format: true });
      const result = { ...rawResult, xml: rawResult.xml ? normalizeBpmnXml(rawResult.xml) : rawResult.xml };
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
      const rawResult = await modeler.saveXML({ format: true });
      const result = { ...rawResult, xml: rawResult.xml ? normalizeBpmnXml(rawResult.xml) : rawResult.xml };
      const bpmnXml = result.xml;
      
      if (!bpmnXml) {
        setValidationMessage('No BPMN XML to transform');
        return;
      }


      // Step 2: Transform BPMN to DEXPI XML
      const dexpiXml = await transformer.transform(bpmnXml, {
        projectName: 'DEXPI Process Model',
        projectDescription: 'Generated from BPMN.io',
        author: 'bpmn2dexpi'
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

  const handleExportNeo4j = async (config: Neo4jConfig, _options: { clearDatabase: boolean }) => {
    if (!modeler) return;

    setNeo4jExporting(true);
    setNeo4jProgress({ current: 0, total: 100, stage: 'Starting...' });

    try {
      // Generate BPMN XML then transform to DEXPI
      const rawResult = await modeler.saveXML({ format: true });
      const result = { ...rawResult, xml: rawResult.xml ? normalizeBpmnXml(rawResult.xml) : rawResult.xml };
      const bpmnXml = result.xml;
      
      if (!bpmnXml) {
        setValidationMessage('No BPMN XML to export');
        setNeo4jExporting(false);
        return;
      }

      // Transform to DEXPI XML
      const dexpiXml = await transformer.transform(bpmnXml);
      
      // Export to Neo4j
      const exportResult = await exportToNeo4j(dexpiXml, config, (current: number, total: number) => {
        setNeo4jProgress({ current, total, stage: 'Executing queries...' });
      });

      if (exportResult.success) {
        setValidationMessage(`✅ ${exportResult.message}`);
        setShowNeo4jModal(false);
      } else {
        setValidationMessage(`❌ ${exportResult.message}`);
      }
    } catch (err) {
      console.error('Neo4j export failed:', err);
      setValidationMessage('Neo4j export failed: ' + (err as Error).message);
    } finally {
      setNeo4jExporting(false);
      setNeo4jProgress(null);
    }
  };

  /**
   * After importing a BPMN file, assign anchorSide/anchorOffset to any DEXPI
   * ports that lack them. Inlets → left side, Outlets → right side, spread
   * evenly. Matches AutoTypeBehavior logic for newly drawn connections.
   */
  const reanchorPortsAfterImport = (bpmnModelerInstance?: any) => {
    const m = bpmnModelerInstance || modeler;
    if (!m) return;
    try {
      const elementRegistry = m.get('elementRegistry') as any;
      const eventBus = m.get('eventBus') as any;

      elementRegistry.getAll().forEach((element: any) => {
        const bo = element.businessObject;
        const ext = bo?.extensionElements?.values;
        if (!ext?.length) return;

        const dexpiEl = ext.find((e: any) => e.$type === 'dexpi:Element');
        if (!dexpiEl?.ports?.length) return;

        const inlets  = dexpiEl.ports.filter((p: any) => p.direction === 'Inlet');
        const outlets = dexpiEl.ports.filter((p: any) => p.direction === 'Outlet');

        let changed = false;
        dexpiEl.ports.forEach((port: any) => {
          if (port.anchorSide) return;
          const isOutlet = port.direction === 'Outlet';
          const group = isOutlet ? outlets : inlets;
          const idx = group.indexOf(port);
          // Direct mutation — no command stack, no autosave trigger
          port.anchorSide = isOutlet ? 'right' : 'left';
          port.anchorOffset = group.length === 1 ? 0.5 : (idx + 1) / (group.length + 1);
          changed = true;
        });

        if (changed) {
          // Fire element-changed to trigger re-render without going through modeling API
          eventBus.fire('element.changed', { element });
        }
      });
    } catch (e) {
      // Never let port anchoring break the modeler
      console.warn('reanchorPortsAfterImport error (non-fatal):', e);
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
        await modeler.importXML(normalizeBpmnXml(text));
        reanchorPortsAfterImport();
        const { xml } = await modeler.saveXML({ format: true });
        if (xml) localStorage.setItem(AUTOSAVE_KEY, xml);
        setValidationMessage('BPMN imported successfully!');
        setPlaneStack([]);
        setCurrentPlane(null);
        const canvas = modeler.get('canvas') as any;
        canvas.zoom('fit-viewport');
      } catch (err) {
        console.error('Import failed:', err);
        setValidationMessage('Import failed: ' + (err as Error).message);
      }
    };
    input.click();
  };

  const handleImportDexpi = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xml';
    input.onchange = async (e: any) => {
      const file = e.target.files[0];
      if (!file || !modeler) return;

      setValidationMessage('⏳ Importing DEXPI XML...');

      // Yield to let the UI update before heavy processing
      await new Promise(resolve => setTimeout(resolve, 50));

      try {
        const dexpiXml = await file.text();
        const t = new DexpiToBpmnTransformer();
        const bpmnXml = t.transform(dexpiXml);

        await modeler.importXML(normalizeBpmnXml(bpmnXml));
        reanchorPortsAfterImport();
        setPlaneStack([]);
        setCurrentPlane(null);
        const canvas = modeler.get('canvas') as any;
        canvas.zoom('fit-viewport');
        setValidationMessage('✓ DEXPI imported successfully');
      } catch (err) {
        console.error('DEXPI import failed:', err);
        setValidationMessage('✗ DEXPI import failed: ' + (err as Error).message);
      }
    };
    input.click();
  };

  const handleNewDiagram = async () => {
    if (!modeler) return;
    if (!window.confirm('Start a new diagram? Any unsaved changes will be lost.')) return;
    await modeler.importXML(normalizeBpmnXml(initialDiagram));
    localStorage.removeItem(AUTOSAVE_KEY);
    setPlaneStack([]);
    setCurrentPlane(null);
    setSelectedElement(null);
    const canvas = modeler.get('canvas') as any;
    canvas.zoom('fit-viewport');
    setValidationMessage('New diagram created');
  };

  return (
    <div className="app">
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <img src={logoImg} alt="bpmn2dexpi logo" style={{ height: '40px' }} />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <h1 style={{ marginBottom: 0 }}>BPMN2DEXPI</h1>
            <span style={{ fontSize: '0.9rem', fontWeight: 'normal', marginTop: 0 }}>DEXPI Process Modeling Tool</span>
          </div>
        </div>
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
          <button onClick={handleNewDiagram} className="btn" title="Start a new empty diagram">New</button>
          <button onClick={handleImportBpmn} className="btn">Import BPMN</button>
          <button onClick={handleImportDexpi} className="btn">Import DEXPI XML</button>
          <button onClick={handleExportBpmn} className="btn">Export BPMN</button>
          <button onClick={handleExportSvg} className="btn">Export SVG</button>
          <button onClick={() => setShowNeo4jModal(true)} className="btn btn-neo4j" title="Export to Neo4j Graph Database">
            🔗 Neo4j
          </button>
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
          ) : selectedElement && selectedElement.type !== 'bpmn:SequenceFlow' && selectedElement.type !== 'bpmn:Association' && selectedElement.type !== 'bpmn:DataOutputAssociation' && selectedElement.type !== 'bpmn:DataInputAssociation' ? (
            <DexpiPropertiesPanel element={selectedElement} modeler={modeler} />
          ) : selectedElement && (selectedElement.type === 'bpmn:SequenceFlow' || selectedElement.type === 'bpmn:Association' || selectedElement.type === 'bpmn:DataOutputAssociation' || selectedElement.type === 'bpmn:DataInputAssociation') ? (
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
      
      <Neo4jExportModal
        isOpen={showNeo4jModal}
        onClose={() => setShowNeo4jModal(false)}
        onExport={handleExportNeo4j}
        isExporting={neo4jExporting}
        progress={neo4jProgress}
      />
    </div>
  );
}

export default App;
