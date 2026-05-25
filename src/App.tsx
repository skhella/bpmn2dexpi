import { useRef, useEffect, useState } from 'react';
import BpmnModeler from 'bpmn-js/lib/Modeler';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import dexpiExtension from './dexpi';
import dexpiDescriptor from './dexpi/moddle/dexpi.json';
import { DexpiPropertiesPanel, StreamPropertiesPanel } from './components/DexpiPropertiesPanel';
import { DataObjectPropertiesPanel } from './components/DataObjectPropertiesPanel';
import { MaterialLibraryPanel } from './components/MaterialLibraryPanel';
import { MaterialEditorPanel } from './components/MaterialEditorPanel';
import { Neo4jExportModal } from './components/Neo4jExportModal';
import { BpmnToDexpiTransformer } from './transformer/BpmnToDexpiTransformer';
import { DexpiProcessClassRegistry } from './transformer/DexpiProcessClassRegistry';
import { generateProfileFromDexpiXml } from './transformer/DexpiProfileGenerator';
import processXmlRaw from '../dexpi-schema-files/Process.xml?raw';
import coreXmlRaw from '../dexpi-schema-files/Core.xml?raw';
import { exportToNeo4j, setNeo4jProcessXml } from './utils/neo4jExporter';
import type { Neo4jConfig } from './utils/neo4jExporter';

// Initialise the Neo4j exporter's DEXPI class registry once at module load.
// The exporter is environment-agnostic (also used by the Node CLI) and so
// doesn't import Process.xml itself — every caller supplies it.
setNeo4jProcessXml(processXmlRaw);
import {
  isMaterialStatesContainer,
  isMaterialTemplatesContainer,
} from './utils/materialContainers';
import logoImg from './assets/cropped_logo_B2P.png';
import './App.css';

const AUTOSAVE_KEY = 'bpmn2dexpi_autosave';

// localStorage helpers — wrap every access so disabled-storage contexts
// (Firefox strict-privacy, Safari ITP, sandboxed iframes, storage-quota
// errors) don't crash the modeler-init effect at app start.
const safeLocalGetItem = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const safeLocalSetItem = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* storage disabled or quota exceeded */ }
};
const safeLocalRemoveItem = (key: string): void => {
  try { localStorage.removeItem(key); } catch { /* storage disabled */ }
};

/**
 * Normalise BPMN XML before feeding it to bpmn-js so files from any source
 * (our UI, Camunda Modeler, hand-edited, legacy TEP) parse identically:
 *
 * 1. Inject xmlns:dexpi if missing — bpmn-js silently drops dexpi:* elements
 *    whose namespace URI isn't declared on the root, even if they look correct.
 * 2. Strip <dexpi:ports> wrappers — moddle descriptor expects port elements
 *    as direct children of <dexpi:element>. Kept as a backward-compat fallback
 *    for older files that used the wrapper; current canonical TEP is flat.
 * 3. Convert bare <port> elements (Camunda export of our annotations without
 *    a namespace prefix) to <dexpi:port> so they match the dexpi moddle type.
 *
 * Pure Camunda BPMNs (no ports, no dexpi content) pass through unchanged.
 */
function preprocessBpmnXml(xml: string): string {
  let result = xml;

  // 1. Ensure xmlns:dexpi is declared
  if (!result.includes('xmlns:dexpi=')) {
    result = result.replace(
      /(<(?:bpmn:)?definitions\b[^>]*?)(\/?>)/,
      `$1 xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"$2`
    );
  }

  // 2. Strip <dexpi:ports> / <ports> wrappers (legacy / Camunda formats)
  result = result
    .replace(/<dexpi:ports>/g, '')
    .replace(/<\/dexpi:ports>/g, '')
    .replace(/<ports>/g, '')
    .replace(/<\/ports>/g, '');

  // 3. Convert bare <port> → <dexpi:port>
  if (/<port\b/.test(result)) {
    result = result
      .replace(/<port\b/g, '<dexpi:port')
      .replace(/<\/port>/g, '</dexpi:port>');
  }

  return result;
}

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

/**
 * Force the renderer to re-run drawShape on every visible element after an
 * importXML completes. Two reasons it's needed:
 *
 * 1. InformationPort positions are computed from live association waypoints
 *    in DexpiRenderer.drawShape. On the initial render during importXML the
 *    waypoints aren't yet propagated to the elementRegistry, so ports land at
 *    fallback (anchorX/anchorY) positions until a re-render is triggered.
 *
 * 2. applyDexpiTypeColor (the green/blue task fill based on
 *    InstrumentationActivity vs ProcessStep ancestry) runs in drawShape too —
 *    same issue, fills don't show on imported diagrams until a re-render.
 *
 * Firing element.changed for every visible shape forces the renderer to
 * recompute both. Mirrors the no-op the port-visibility toggle effect runs.
 */
function refreshAllElementsAfterImport(bpmnModelerInstance: any): void {
  if (!bpmnModelerInstance) return;
  try {
    const elementRegistry = bpmnModelerInstance.get('elementRegistry');
    const eventBus = bpmnModelerInstance.get('eventBus');
    const all = elementRegistry.filter((el: any) => {
      const gfx = elementRegistry.getGraphics(el);
      return gfx &&
        el.type !== 'label' &&
        el.type !== 'bpmn:DataObjectReference' &&
        el.type !== 'bpmn:DataInputAssociation' &&
        el.type !== 'bpmn:DataOutputAssociation' &&
        !el.labelTarget;
    });
    all.forEach((element: any) => eventBus.fire('element.changed', { element }));
  } catch (e) {
    console.warn('refreshAllElementsAfterImport (non-fatal):', e);
  }
}

function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [modeler, setModeler] = useState<BpmnModeler | null>(null);
  const [selectedElement, setSelectedElement] = useState<any>(null);
  const [validationMessage, setValidationMessage] = useState<string>('');
  const [_currentPlane, setCurrentPlane] = useState<string | null>(null);
  const [planeStack, setPlaneStack] = useState<string[]>([]);
  const [showPorts, setShowPorts] = useState<boolean>(false);
  const [showMaterialLibrary, setShowMaterialLibrary] = useState<boolean>(false);
  // Strict-mode property-name fidelity validation toggle. Off by default
  // (DEXPI 2.0's permissive philosophy: any XSD-valid output is exchangeable,
  // so the user-facing default is XSD-only). When on, the next DEXPI export
  // additionally validates property names against Process.xml + Core.xml and
  // surfaces violations as warnings — but the export file is still produced
  // unconditionally.
  const [strictMode, setStrictMode] = useState<boolean>(false);

  // Loaded DEXPI Profile extensions (per-session only — not persisted to
  // localStorage; users must re-import after page reload). Each entry is
  // one Profile XML in the same DEXPI metamodel grammar Process.xml uses.
  // Profile classes are recognized as valid dexpiType targets in both
  // strict and non-strict mode, so importing a Profile silences the
  // "not a recognised DEXPI 2.0 Process class" warning for its classes.
  const [loadedProfiles, setLoadedProfiles] = useState<{ name: string; xml: string }[]>([]);
  // Hidden file-input ref for the "Import DEXPI Profile" button.
  const profileFileInputRef = useRef<HTMLInputElement>(null);
  // Popover state for the consolidated DEXPI menu (Strict + Import / Generate
  // Profile + loaded-profile chips + Clear). The toolbar got crowded once
  // every Profile-related control was top-level; collapsing them behind
  // one menu button keeps the header readable while leaving Export DEXPI
  // as the primary call-to-action.
  const [showDexpiMenu, setShowDexpiMenu] = useState<boolean>(false);
  // Same pattern for the consolidated Exports menu (Export BPMN / Export
  // SVG / Neo4j). Export DEXPI XML stays as the primary toolbar action
  // since it's the headline workflow; the secondary exports go behind one
  // menu button so the toolbar isn't a row of single-purpose buttons.
  const [showExportsMenu, setShowExportsMenu] = useState<boolean>(false);

  // Strict-mode export-time warning modal. Populated by handleExportDexpi
  // when strict mode is on and the property-name validator finds
  // violations. Per the design contract the export still succeeds (file is
  // already downloaded by the time this populates); the modal exists so
  // the user knows the deliverable has fidelity gaps and can take a
  // one-click action (Generate Profile) to close them.
  const [strictWarning, setStrictWarning] = useState<{
    totalCount: number;
    groups: { tier: string; key: string; count: number; sample: string }[];
  } | null>(null);
  const [materialLibraryTab, setMaterialLibraryTab] = useState<'templates' | 'components' | 'states'>('templates');
  const [selectedMaterialItem, setSelectedMaterialItem] = useState<{type: 'template' | 'component' | 'state', data: any} | null>(null);
  const [showNeo4jModal, setShowNeo4jModal] = useState(false);
  const [neo4jExporting, setNeo4jExporting] = useState(false);
  const [neo4jProgress, setNeo4jProgress] = useState<{ current: number; total: number; stage: string } | null>(null);

  // Pre-export dialog. Opens when the user clicks Export DEXPI XML; collects
  // the filename + model-metadata fields (projectName / projectDescription /
  // author) that previously hardcoded into handleExportDexpi. Values persist
  // across exports within the session so re-exports don't require retyping.
  const [showExportDialog, setShowExportDialog] = useState<boolean>(false);
  const [exportOptions, setExportOptions] = useState<{
    filename: string;
    projectName: string;
    projectDescription: string;
    author: string;
  }>({
    filename: 'process-model-dexpi.xml',
    projectName: 'DEXPI Process Model',
    projectDescription: 'Generated from BPMN.io',
    author: 'bpmn2dexpi',
  });

  // BPMN export filename dialog. BPMN doesn't carry the project / author
  // metadata DEXPI does, so this is a single-field modal — but kept as a
  // dedicated dialog rather than a native prompt() for visual consistency
  // with the DEXPI export flow.
  const [showBpmnExportDialog, setShowBpmnExportDialog] = useState<boolean>(false);
  const [bpmnExportFilename, setBpmnExportFilename] = useState<string>('process-model.bpmn');

  // SVG export filename dialog — same single-field pattern.
  const [showSvgExportDialog, setShowSvgExportDialog] = useState<boolean>(false);
  const [svgExportFilename, setSvgExportFilename] = useState<string>('process-diagram.svg');

  // Generate-Profile filename dialog. Derived output (not a user model
  // export) so it lives in its own state alongside the other filename
  // dialogs for consistency.
  const [showProfileExportDialog, setShowProfileExportDialog] = useState<boolean>(false);
  const [profileExportFilename, setProfileExportFilename] = useState<string>('generated-profile.xml');
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

  /**
   * Reset the entire UI to its default state. Triggered by clicking the
   * app logo / title (a familiar "home" affordance on most web apps).
   * The underlying BPMN model is untouched — this only resets transient
   * UI state, so it doesn't need a confirmation prompt:
   *   - pop the subprocess plane stack to root and fit-viewport the canvas
   *   - clear element / material-item selection
   *   - close the Material Library overlay
   *   - dismiss the DEXPI / Exports popover menus
   *   - dismiss the strict-mode warning + all export dialogs + Neo4j modal
   */
  const handleHomeReset = () => {
    if (!modeler) return;
    // Navigate back to the bottom of the plane stack in one step. The stack
    // holds parent ids in push order, so the bottom is the original top-level
    // plane.
    if (planeStack.length > 0) {
      isNavigatingBack.current = true;
      const elementRegistry = modeler.get('elementRegistry') as any;
      const canvas = modeler.get('canvas') as any;
      const rootId = planeStack[0];
      const rootElement = elementRegistry.get(rootId);
      if (rootElement) {
        canvas.setRootElement(rootElement);
      }
      setPlaneStack([]);
      setCurrentPlane(null);
      setTimeout(() => { isNavigatingBack.current = false; }, 100);
    }
    // Zoom-to-fit even when no plane navigation happened — handles the
    // common case of "I panned/zoomed and want to reset the view".
    const canvas = modeler.get('canvas') as any;
    canvas.zoom('fit-viewport');
    // Close every transient overlay so the user lands on a clean canvas.
    setSelectedElement(null);
    setSelectedMaterialItem(null);
    setShowMaterialLibrary(false);
    setShowDexpiMenu(false);
    setShowExportsMenu(false);
    setStrictWarning(null);
    setShowNeo4jModal(false);
    setShowExportDialog(false);
    setShowBpmnExportDialog(false);
    setShowSvgExportDialog(false);
    setShowProfileExportDialog(false);
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
      
      // Auto-open Material Library when clicking a DataObjectReference
      // that actually carries materials data. Content-based detection
      // (the same helper the panel and transformer use) — so a renamed
      // container still triggers the auto-open, matching the materials-
      // routing contract introduced in PR #61.
      if (element?.type === 'bpmn:DataObjectReference') {
        if (isMaterialTemplatesContainer(element)) {
          setMaterialLibraryTab('templates');
          setShowMaterialLibrary(true);
        } else if (isMaterialStatesContainer(element)) {
          setMaterialLibraryTab('states');
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
    const savedXml = safeLocalGetItem(AUTOSAVE_KEY);
    const diagramToLoad = savedXml || initialDiagram;

    const preprocessedToLoad = preprocessBpmnXml(diagramToLoad);
    bpmnModeler.importXML(preprocessedToLoad).then(() => {
      if (isDestroyed) return;

      refreshAllElementsAfterImport(bpmnModeler);

      const canvas = bpmnModeler.get('canvas') as any;
      canvas.zoom('fit-viewport');
      
      // Initialize currentRootElement after import is complete
      currentRootElement = canvas.getRootElement();
      
      // Auto-save on every diagram change
      eventBus.on('commandStack.changed', () => {
        bpmnModeler.saveXML({ format: true }).then(({ xml }) => {
          if (xml) safeLocalSetItem(AUTOSAVE_KEY, xml);
        });
      });

      // Now set the modeler state - the app is ready
      setModeler(bpmnModeler);
      if (savedXml) setValidationMessage('Restored previous session');
    }).catch((err: any) => {
      if (isDestroyed) return;
      console.error('Failed to import BPMN:', err);
      // If autosaved data was corrupted, fall back to empty diagram
      if (savedXml) {
        safeLocalRemoveItem(AUTOSAVE_KEY);
        bpmnModeler.importXML(preprocessBpmnXml(initialDiagram)).then(() => {
          refreshAllElementsAfterImport(bpmnModeler);
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

  /**
   * Run the full strict-mode validation pipeline against the current model
   * without producing a download. Mirrors the strict half of handleExportDexpi
   * — same registry, same transformer, same five-tier grouping — but skips
   * the Blob/download step and shows the strictWarning modal so users get
   * fidelity feedback on demand instead of having to export-then-read.
   * Produces a success banner when zero findings.
   */
  const handleValidateNow = async () => {
    if (!modeler) return;
    try {
      const result = await modeler.saveXML({ format: true });
      const bpmnXml = result.xml;
      if (!bpmnXml) {
        setValidationMessage('No BPMN XML to validate.');
        return;
      }
      const xmlForTransform = preprocessBpmnXml(bpmnXml);
      // Per-call transformer instance — see the same rationale in
      // handleExportDexpi. Without this, a concurrent Validate-now +
      // Export DEXPI XML would race on the module-singleton's
      // last*Validation fields and surface the wrong findings.
      const t = new BpmnToDexpiTransformer();
      await t.transform(xmlForTransform, {
        processXml: processXmlRaw,
        coreXml: coreXmlRaw,
        profileXmls: loadedProfiles,
        strict: true,
      });
      const tierResults: { tier: string; result: typeof t.lastPropertyNameValidation }[] = [
        { tier: 'property-name + kind',  result: t.lastPropertyNameValidation },
        { tier: 'data-type',             result: t.lastDataTypeValidation },
        { tier: 'reference target-class',result: t.lastReferenceValidation },
        { tier: 'cardinality',           result: t.lastCardinalityValidation },
        { tier: 'class existence',       result: t.lastClassExistenceValidation },
      ];
      const groupList: { tier: string; key: string; count: number; sample: string }[] = [];
      let total = 0;
      for (const { tier, result: tierResult } of tierResults) {
        if (!tierResult || tierResult.valid) continue;
        const groups = new Map<string, { count: number; sample: string }>();
        for (const err of tierResult.errors) {
          total++;
          const colon = err.indexOf(':');
          const key = colon >= 0 ? err.slice(0, colon) : err;
          const sample = colon >= 0 ? err.slice(colon + 1).trim() : '';
          const g = groups.get(key);
          if (g) g.count++;
          else groups.set(key, { count: 1, sample });
        }
        for (const [key, { count, sample }] of groups) {
          groupList.push({ tier, key, count, sample });
        }
      }
      if (total === 0) {
        setValidationMessage('✓ No strict-mode fidelity findings on the current model.');
      } else {
        setStrictWarning({ totalCount: total, groups: groupList });
      }
    } catch (err) {
      setValidationMessage(`Validation failed: ${(err as Error).message}`);
    }
  };

  const handleExportBpmn = async () => {
    if (!modeler) return;

    try {
      const result = await modeler.saveXML({ format: true });
      const xml = result.xml;

      const blob = new Blob([xml || ''], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const rawName = (bpmnExportFilename || '').trim() || 'process-model.bpmn';
      a.download = /\.bpmn$/i.test(rawName) ? rawName : `${rawName}.bpmn`;
      a.click();
      URL.revokeObjectURL(url);

      setValidationMessage('BPMN XML exported successfully!');
    } catch (err) {
      console.error('Export failed:', err);
      setValidationMessage('Export failed: ' + (err as Error).message);
    }
  };

  const openExportBpmnDialog = () => {
    if (!modeler) return;
    setShowBpmnExportDialog(true);
  };

  // Opens the export-options dialog. The user-supplied filename and metadata
  // fields are then passed into the actual transform via handleExportDexpi.
  const openExportDexpiDialog = () => {
    if (!modeler) return;
    setShowExportDialog(true);
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
      // preprocessBpmnXml ensures xmlns:dexpi is declared and bare <port> elements
      // are converted — needed because saveXML output may vary
      // Step 2: Transform BPMN to DEXPI XML
      // saveXML() output is now reliable — moddle descriptor properly preserves
      // dexpi:element content on round-trip. preprocessBpmnXml normalizes any
      // legacy port wrappers to flat ports.
      const xmlForTransform = preprocessBpmnXml(bpmnXml);

      // Per-call transformer instance instead of the module singleton —
      // isolates this handler's strict-mode validation reads from any
      // concurrent transform() (e.g. a parallel Generate Profile, or a
      // future on-demand Validate-now button) that would otherwise
      // overwrite the shared last*Validation fields between this
      // handler's await and the modal-population code below.
      const t = new BpmnToDexpiTransformer();
      const dexpiXml = await t.transform(xmlForTransform, {
        projectName: exportOptions.projectName,
        projectDescription: exportOptions.projectDescription,
        author: exportOptions.author,
        processXml: processXmlRaw,
        // Strict mode needs Core.xml in the registry too so the validator
        // can walk supertype chains across Process → Core. Always pass it
        // so flipping the toggle without a re-import works.
        coreXml: coreXmlRaw,
        // Per-session DEXPI Profile extensions; empty array if none loaded.
        // Profile classes are recognized as dexpiType targets in both
        // strict and non-strict mode.
        profileXmls: loadedProfiles,
        strict: strictMode,
      });


      // Step 3: Download DEXPI XML — happens unconditionally. Strict-mode
      // findings (if any) surface as a warning afterwards but never block
      // file production: DEXPI 2.0 permissive philosophy says any XSD-valid
      // output is exchangeable, and we don't want strict mode to gate users
      // out of getting a deliverable.
      const blob = new Blob([dexpiXml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Trim whitespace and ensure a .xml suffix so users can paste a bare
      // name in the dialog without remembering the extension.
      const rawName = (exportOptions.filename || '').trim() || 'process-model-dexpi.xml';
      a.download = /\.xml$/i.test(rawName) ? rawName : `${rawName}.xml`;
      a.click();
      URL.revokeObjectURL(url);

      // Surface strict-mode validation results across all five post-XSD tiers.
      // Per the DEXPI permissive philosophy the export already succeeded — the
      // dialog informs the user about fidelity gaps so they can take a one-click
      // Generate-Profile action to close them.
      if (strictMode) {
        const tierResults: { tier: string; result: typeof t.lastPropertyNameValidation }[] = [
          { tier: 'property-name + kind',  result: t.lastPropertyNameValidation },
          { tier: 'data-type',             result: t.lastDataTypeValidation },
          { tier: 'reference target-class',result: t.lastReferenceValidation },
          { tier: 'cardinality',           result: t.lastCardinalityValidation },
          { tier: 'class existence',       result: t.lastClassExistenceValidation },
        ];
        // Group identical "ClassName.PropertyName" prefixes per tier so the modal
        // shows a compact list with counts rather than every single occurrence.
        const groupList: { tier: string; key: string; count: number; sample: string }[] = [];
        let total = 0;
        for (const { tier, result } of tierResults) {
          if (!result || result.valid) continue;
          const groups = new Map<string, { count: number; sample: string }>();
          for (const err of result.errors) {
            total++;
            const colon = err.indexOf(':');
            const key = colon >= 0 ? err.slice(0, colon) : err;
            const sample = colon >= 0 ? err.slice(colon + 1).trim() : '';
            const g = groups.get(key);
            if (g) g.count++;
            else groups.set(key, { count: 1, sample });
          }
          for (const [key, { count, sample }] of groups) {
            groupList.push({ tier, key, count, sample });
          }
        }
        if (groupList.length > 0) {
          groupList.sort((a, b) =>
            a.tier === b.tier ? a.key.localeCompare(b.key) : a.tier.localeCompare(b.tier),
          );
          setStrictWarning({ totalCount: total, groups: groupList });
          setValidationMessage('DEXPI XML exported with strict-mode warnings — see dialog.');
          console.warn('DEXPI strict-mode fidelity findings (all tiers):');
          for (const g of groupList) console.warn(`  [${g.tier}] ✗ ${g.key} ×${g.count}`);
        } else {
          setValidationMessage('DEXPI XML exported successfully!');
        }
      } else {
        // Non-strict mode: surface transformer logger warnings (unmapped types,
        // fallback-to-ProcessStep, missing supertypes) so the user knows their
        // export carries an advisory before the next strict-mode run flags it.
        // Reads the per-call instance's logger (see comment above on the
        // per-call transformer rationale).
        const warnings = t.logger.warnings;
        if (warnings.length > 0) {
          setValidationMessage(
            `DEXPI XML exported with ${warnings.length} transformer warning${warnings.length === 1 ? '' : 's'} — see browser console.`,
          );
          console.warn('DEXPI transformer warnings:');
          for (const w of warnings) console.warn(`  • ${w}`);
        } else {
          setValidationMessage('DEXPI XML exported successfully!');
        }
      }
    } catch (err) {
      console.error('DEXPI transformation failed:', err);
      setValidationMessage('DEXPI export failed: ' + (err as Error).message);
    }
  };

  const handleExportSvg = async () => {
    if (!modeler) return;

    try {
      const { svg } = await modeler.saveSVG();

      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const rawName = (svgExportFilename || '').trim() || 'process-diagram.svg';
      a.download = /\.svg$/i.test(rawName) ? rawName : `${rawName}.svg`;
      a.click();
      URL.revokeObjectURL(url);

      setValidationMessage('SVG exported successfully!');
    } catch (err) {
      console.error('SVG export failed:', err);
      setValidationMessage('SVG export failed: ' + (err as Error).message);
    }
  };

  const openExportSvgDialog = () => {
    if (!modeler) return;
    setShowSvgExportDialog(true);
  };

  const handleExportNeo4j = async (config: Neo4jConfig, _options: { clearDatabase: boolean }) => {
    if (!modeler) return;

    setNeo4jExporting(true);
    setNeo4jProgress({ current: 0, total: 100, stage: 'Starting...' });

    try {
      // Generate BPMN XML then transform to DEXPI
      const result = await modeler.saveXML({ format: true });
      const bpmnXml = result.xml;
      
      if (!bpmnXml) {
        setValidationMessage('No BPMN XML to export');
        setNeo4jExporting(false);
        return;
      }

      // Transform to DEXPI XML (per-call instance so a concurrent
      // export / generate doesn't race on the singleton's logger and
      // last*Validation fields).
      const t = new BpmnToDexpiTransformer();
      const dexpiXml = await t.transform(bpmnXml, { processXml: processXmlRaw });
      
      // Export to Neo4j
      const exportResult = await exportToNeo4j(dexpiXml, config, (current: number, total: number) => {
        setNeo4jProgress({ current, total, stage: 'Executing queries...' });
      });

      if (exportResult.success) {
        setValidationMessage(`✓ ${exportResult.message}`);
        setShowNeo4jModal(false);
      } else {
        setValidationMessage(`✗ ${exportResult.message}`);
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
   * DEXPI Profile import — per-session only.
   *
   * Pre-flight: build a registry from Process.xml + Core.xml +
   * already-loaded Profiles + the candidate Profile. Two registry
   * outcomes are surfaced:
   *
   *   - Throw → unresolved supertype, OR divergent supertypes/property
   *     kinds across same-name redeclarations. We catch and surface
   *     the error to the user; the Profile is NOT added to state.
   *
   *   - Non-blocking warnings (registry.mergeWarnings) → additive
   *     same-name merges (the normal extension case). We filter to
   *     warnings naming this file and prepend them to the success
   *     message so unintended collisions stay visible.
   *
   * On success, append to loadedProfiles. Subsequent DEXPI exports
   * include the Profile automatically. Profiles are NOT persisted to
   * localStorage — a page reload clears them and the user must re-import.
   */
  const handleImportProfile = (file: File) => {
    file.text().then(xml => {
      const candidate = { name: file.name, xml };
      let mergeWarnings: ReadonlyArray<string> = [];
      try {
        const reg = DexpiProcessClassRegistry.fromXmlSources([
          { name: 'Process.xml', xml: processXmlRaw },
          { name: 'Core.xml', xml: coreXmlRaw },
          ...loadedProfiles,
          candidate,
        ]);
        // Filter to warnings caused by *this* Profile so users only see
        // collisions introduced by the file they just imported (warnings
        // from prior loads are already known to them).
        mergeWarnings = reg.mergeWarnings.filter(w => w.includes(`"${file.name}"`));
      } catch (err) {
        // Registry already produces clear, actionable messages naming the
        // unresolved supertype — surface verbatim.
        setValidationMessage(`✗ Profile "${file.name}" rejected: ${(err as Error).message}`);
        return;
      }
      setLoadedProfiles(prev => [...prev, candidate]);
      if (mergeWarnings.length > 0) {
        // Same-name class redeclarations merge additively but are surfaced
        // here so users notice unintended collisions (e.g. a typo of a
        // standard class name).
        setValidationMessage(
          `✓ Profile "${file.name}" loaded (per-session) — ${mergeWarnings.length} same-name merge${mergeWarnings.length === 1 ? '' : 's'}: ${mergeWarnings.join('; ')}`
        );
      } else {
        setValidationMessage(`✓ Profile "${file.name}" loaded (per-session).`);
      }
    }).catch(err => {
      setValidationMessage(`✗ Profile "${file.name}" read failed: ${err.message}`);
    });
  };

  const handleClearProfiles = () => {
    setLoadedProfiles([]);
    setValidationMessage('Profiles cleared.');
  };

  /**
   * Generate a DEXPI Profile from the current model — walks the emitted
   * DEXPI XML + the source BPMN's extension elements, identifies every
   * (class, property) gap not resolved by the currently loaded schemas
   * (Process.xml + Core.xml + already-imported Profiles), and downloads
   * a Profile XML that fills them. Iterates internally until convergence
   * so deeply-nested project extensions are captured in one pass.
   *
   * The download happens unconditionally; output is deterministic so
   * users can commit the file to source control. Generated Profiles are
   * NOT auto-loaded into the current session — the user is expected to
   * re-import via the Import Profile button if they want strict-mode
   * validation to pass against this model in this session. That keeps
   * generation observable / reviewable rather than silent.
   */
  const openGenerateProfileDialog = () => {
    if (!modeler) return;
    setShowProfileExportDialog(true);
  };

  const handleGenerateProfile = async () => {
    if (!modeler) return;
    try {
      const result = await modeler.saveXML({ format: true });
      const bpmnXml = result.xml;
      if (!bpmnXml) {
        setValidationMessage('No BPMN XML to analyze.');
        return;
      }
      const xmlForTransform = preprocessBpmnXml(bpmnXml);
      // Run a regular (non-strict) transform to obtain the emitted DEXPI XML
      // we'll walk for gaps. Per-call instance so a concurrent DEXPI
      // export doesn't race on the singleton's state. profileXmls is
      // included so the generator only surfaces NEW gaps not already
      // covered by loaded Profiles.
      const t = new BpmnToDexpiTransformer();
      const dexpiXml = await t.transform(xmlForTransform, {
        projectName: 'DEXPI Process Model',
        author: 'bpmn2dexpi',
        processXml: processXmlRaw,
        coreXml: coreXmlRaw,
        profileXmls: loadedProfiles,
      });
      const reg = DexpiProcessClassRegistry.fromXmlSources([
        { name: 'Process.xml', xml: processXmlRaw },
        { name: 'Core.xml', xml: coreXmlRaw },
        ...loadedProfiles,
      ]);
      const generated = generateProfileFromDexpiXml(dexpiXml, reg, { bpmnXml: xmlForTransform });

      const blob = new Blob([generated.xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const rawName = (profileExportFilename || '').trim() || 'generated-profile.xml';
      a.download = /\.xml$/i.test(rawName) ? rawName : `${rawName}.xml`;
      a.click();
      URL.revokeObjectURL(url);

      setValidationMessage(
        generated.declarations === 0
          ? '✓ Generated empty Profile (no fidelity gaps found in current model).'
          : `✓ Generated Profile downloaded: ${generated.classCount} class${
              generated.classCount === 1 ? '' : 'es'
            }, ${generated.declarations} declaration${
              generated.declarations === 1 ? '' : 's'
            }, converged in ${generated.iterationsUsed} pass${
              generated.iterationsUsed === 1 ? '' : 'es'
            }. Re-import to apply in this session.`
      );
    } catch (err) {
      setValidationMessage(`Profile generation failed: ${(err as Error).message}`);
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
        const preprocessedText = preprocessBpmnXml(text);
        await modeler.importXML(preprocessedText);
        refreshAllElementsAfterImport(modeler);
        // Save imported diagram immediately
        const { xml } = await modeler.saveXML({ format: true });
        if (xml) safeLocalSetItem(AUTOSAVE_KEY, xml);
        setValidationMessage('BPMN imported successfully!');
        // Reset navigation state
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

  const handleNewDiagram = async () => {
    if (!modeler) return;
    if (!window.confirm('Start a new diagram? Any unsaved changes will be lost.')) return;
    await modeler.importXML(preprocessBpmnXml(initialDiagram));
    refreshAllElementsAfterImport(modeler);
    safeLocalRemoveItem(AUTOSAVE_KEY);
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
        <div
          role="button"
          tabIndex={0}
          aria-label="Reset to default view"
          title="Reset to default view"
          onClick={handleHomeReset}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleHomeReset(); } }}
          className="app-home-target"
          style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}
        >
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
            {showMaterialLibrary ? 'Materials' : 'Materials'}
          </button>
          <button onClick={handleNewDiagram} className="btn" title="Start a new empty diagram">New</button>
          <button onClick={handleImportBpmn} className="btn">Import BPMN</button>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <button
              onClick={() => setShowExportsMenu(v => !v)}
              className={`btn ${showExportsMenu ? 'btn-active' : ''}`}
              title="Export BPMN, SVG, or to Neo4j"
            >
              Exports ▾
            </button>
            {showExportsMenu && (
              <>
                <div
                  onClick={() => setShowExportsMenu(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'transparent' }}
                />
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    right: 0,
                    zIndex: 101,
                    minWidth: '200px',
                    background: '#fff',
                    color: '#222',
                    border: '1px solid #ccc',
                    borderRadius: '6px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                    padding: '0.4em',
                    fontSize: '0.85em',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25em',
                  }}
                >
                  <button
                    onClick={() => { openExportBpmnDialog(); setShowExportsMenu(false); }}
                    className="btn"
                    style={{ textAlign: 'left' }}
                  >
                    Export BPMN
                  </button>
                  <button
                    onClick={() => { openExportSvgDialog(); setShowExportsMenu(false); }}
                    className="btn"
                    style={{ textAlign: 'left' }}
                  >
                    Export SVG
                  </button>
                  <button
                    onClick={() => { setShowNeo4jModal(true); setShowExportsMenu(false); }}
                    className="btn btn-neo4j"
                    style={{ textAlign: 'left' }}
                    title="Export to Neo4j Graph Database"
                  >
                    Export to Neo4j
                  </button>
                  <button
                    onClick={() => { openExportDexpiDialog(); setShowExportsMenu(false); }}
                    className="btn btn-primary"
                    style={{ textAlign: 'left' }}
                    title="Transform the BPMN model and export DEXPI 2.0 XML (also available as the primary toolbar button)"
                  >
                    Export DEXPI XML
                  </button>
                </div>
              </>
            )}
          </div>
          <input
            ref={profileFileInputRef}
            type="file"
            accept=".xml"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImportProfile(f);
              // Reset value so re-importing the same file re-fires onChange.
              e.target.value = '';
            }}
          />
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <button
              onClick={() => setShowDexpiMenu(v => !v)}
              className={`btn ${showDexpiMenu ? 'btn-active' : ''}`}
              title="Strict-mode validation, Profile import, Profile generation"
            >
              {/* Surface a small "active" indicator when strict is on or
                  any Profile is loaded, so users know there's session-state
                  configured without opening the popover. */}
              DEXPI {(strictMode || loadedProfiles.length > 0) ? '●' : ''} ▾
            </button>
            {showDexpiMenu && (
              <>
                {/* Click-outside-to-close backdrop. Transparent so it doesn't
                    visually intrude; sized to cover the viewport. */}
                <div
                  onClick={() => setShowDexpiMenu(false)}
                  style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 100,
                    background: 'transparent',
                  }}
                />
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    right: 0,
                    zIndex: 101,
                    minWidth: '300px',
                    background: '#fff',
                    color: '#222',
                    border: '1px solid #ccc',
                    borderRadius: '6px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                    padding: '0.75em',
                    fontSize: '0.85em',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.6em',
                  }}
                >
                  <div style={{ fontWeight: 600, color: '#222' }}>Validate on DEXPI XML export</div>
                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'flex-start',
                      gap: '0.45em',
                      cursor: 'pointer',
                      color: '#222',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={strictMode}
                      onChange={(e) => setStrictMode(e.target.checked)}
                      style={{ margin: '3px 0 0 0' }}
                    />
                    <span>
                      Strict property-name validation
                      <div style={{ color: '#666', fontStyle: 'italic', fontSize: '0.9em', marginTop: '2px' }}>
                        On Export DEXPI XML, additionally check that every property
                        name resolves against Process.xml + Core.xml + loaded Profiles.
                        Findings surface as warnings; export is never blocked.
                      </div>
                    </span>
                  </label>
                  <button
                    onClick={() => { handleValidateNow(); setShowDexpiMenu(false); }}
                    className="btn"
                    title="Run the full five-tier strict validation against the current model without exporting. Findings show in the same warning dialog the export path uses."
                  >
                    Validate now
                  </button>
                  <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: 0 }} />
                  <div style={{ fontWeight: 600, color: '#222' }}>DEXPI Profiles</div>
                  <div style={{ color: '#666', fontStyle: 'italic', fontSize: '0.9em' }}>
                    A DEXPI Profile is an XML file declaring project-specific
                    classes / properties beyond Process.xml + Core.xml.
                    <strong> Import</strong> loads one into this session;
                    <strong> Generate</strong> walks the current model and
                    produces a Profile that closes every property-name
                    fidelity gap — re-import the downloaded file to apply it.
                    Generate works whether or not strict mode is on.
                  </div>
                  {loadedProfiles.length === 0 ? (
                    <div style={{ color: '#666', fontStyle: 'italic' }}>
                      No Profiles loaded. Profiles are per-session — re-import after page reload.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25em' }}>
                      {loadedProfiles.map(p => (
                        <span
                          key={p.name}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.35em',
                            fontSize: '0.85em',
                            padding: '0.15em 0.5em',
                            background: '#e6f4ea',
                            border: '1px solid #b6dfb6',
                            borderRadius: '0.5em',
                          }}
                          title={`Profile loaded: ${p.name}`}
                        >
                          {p.name}
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '0.4em', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => { profileFileInputRef.current?.click(); setShowDexpiMenu(false); }}
                      className="btn"
                      style={{ flex: '1 1 auto' }}
                      title="Load a DEXPI Profile (project-specific extension schema)."
                    >
                      Import Profile
                    </button>
                    <button
                      onClick={() => { openGenerateProfileDialog(); setShowDexpiMenu(false); }}
                      className="btn"
                      style={{ flex: '1 1 auto' }}
                      title="Generate a DEXPI Profile from the current model that fills every metamodel-fidelity gap. Re-import the downloaded file to apply it."
                    >
                      Generate Profile
                    </button>
                    {loadedProfiles.length > 0 && (
                      <button
                        onClick={() => { handleClearProfiles(); setShowDexpiMenu(false); }}
                        className="btn"
                        style={{ flex: '0 0 auto' }}
                        title="Unload all imported DEXPI Profiles"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
          <button onClick={openExportDexpiDialog} className="btn btn-primary">Export DEXPI XML</button>
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
          ) : selectedElement && (selectedElement.type === 'bpmn:DataObjectReference' || selectedElement.type === 'bpmn:DataObject') ? (
            <DataObjectPropertiesPanel element={selectedElement} modeler={modeler} />
          ) : selectedElement && selectedElement.type !== 'bpmn:SequenceFlow' && selectedElement.type !== 'bpmn:Association' && selectedElement.type !== 'bpmn:DataOutputAssociation' && selectedElement.type !== 'bpmn:DataInputAssociation' ? (
            <DexpiPropertiesPanel element={selectedElement} modeler={modeler} loadedProfiles={loadedProfiles} />
          ) : selectedElement && (selectedElement.type === 'bpmn:SequenceFlow' || selectedElement.type === 'bpmn:Association' || selectedElement.type === 'bpmn:DataOutputAssociation' || selectedElement.type === 'bpmn:DataInputAssociation') ? (
            <StreamPropertiesPanel element={selectedElement} modeler={modeler} loadedProfiles={loadedProfiles} />
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

      {strictWarning && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="strict-warning-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={(e) => {
            // Click on backdrop (not the dialog) dismisses.
            if (e.target === e.currentTarget) setStrictWarning(null);
          }}
        >
          <div
            style={{
              background: '#fff',
              color: '#222',
              borderRadius: '8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
              padding: '1.25em',
              maxWidth: '560px',
              width: '90%',
              maxHeight: '80vh',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85em',
            }}
          >
            <h3 id="strict-warning-title" style={{ margin: 0, color: '#b26a00', display: 'flex', alignItems: 'center', gap: '0.4em' }}>
              ⚠ Strict-mode validation warnings
            </h3>
            <div style={{ fontSize: '0.9em', color: '#444' }}>
              The DEXPI XML was exported successfully — DEXPI 2.0's permissive
              philosophy means XSD-valid output is exchangeable. However,
              strict-mode validation found{' '}
              <strong>{strictWarning.totalCount} occurrence{strictWarning.totalCount === 1 ? '' : 's'}</strong>{' '}
              of {strictWarning.groups.length} unique{' '}
              fidelity gap{strictWarning.groups.length === 1 ? '' : 's'} across the
              five post-XSD tiers (property-name + kind, data-type, reference
              target-class, cardinality, class existence) against
              Process.xml + Core.xml{loadedProfiles.length > 0 ? ' + the loaded Profile(s)' : ''}.
            </div>
            <div
              style={{
                background: '#fff8e1',
                border: '1px solid #ffe082',
                borderRadius: '4px',
                padding: '0.6em 0.75em',
                fontSize: '0.85em',
                maxHeight: '260px',
                overflowY: 'auto',
              }}
            >
              {(() => {
                // Render groups bucketed by tier so the user sees which kind
                // of fidelity gap each violation belongs to.
                const byTier = new Map<string, typeof strictWarning.groups>();
                for (const g of strictWarning.groups) {
                  let arr = byTier.get(g.tier);
                  if (!arr) { arr = []; byTier.set(g.tier, arr); }
                  arr.push(g);
                }
                return Array.from(byTier).map(([tier, items]) => (
                  <div key={tier} style={{ marginBottom: '0.7em' }}>
                    <div style={{ color: '#444', fontWeight: 600, fontSize: '0.85em', marginBottom: '0.2em' }}>
                      {tier} ({items.reduce((n, x) => n + x.count, 0)})
                    </div>
                    {items.map(g => (
                      <div key={`${tier}::${g.key}`} style={{ marginBottom: '0.4em', marginLeft: '0.6em' }}>
                        <code style={{ color: '#b26a00', fontWeight: 600 }}>✗ {g.key}</code>
                        {g.count > 1 && <span style={{ color: '#666' }}> &nbsp;×{g.count}</span>}
                        {g.sample && (
                          <div style={{ color: '#555', fontSize: '0.85em', marginLeft: '1.2em' }}>
                            e.g. <code>{g.sample}</code>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ));
              })()}
            </div>
            <div style={{ fontSize: '0.85em', color: '#444' }}>
              These typically indicate project-specific extensions or schema
              gaps. Generate Profile walks the model and produces a Profile
              XML that closes every fidelity gap; re-import the downloaded
              file (or load it in another session) to make strict mode
              accept this model.
            </div>
            <div style={{ display: 'flex', gap: '0.5em', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setStrictWarning(null)}
                className="btn"
              >
                Dismiss
              </button>
              <button
                onClick={() => { setStrictWarning(null); openGenerateProfileDialog(); }}
                className="btn btn-primary"
              >
                Generate Profile
              </button>
            </div>
          </div>
        </div>
      )}
      
      <Neo4jExportModal
        isOpen={showNeo4jModal}
        onClose={() => setShowNeo4jModal(false)}
        onExport={handleExportNeo4j}
        isExporting={neo4jExporting}
        progress={neo4jProgress}
      />

      {showProfileExportDialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="profile-export-dialog-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowProfileExportDialog(false);
          }}
        >
          <div
            style={{
              background: '#fff',
              color: '#222',
              borderRadius: '8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
              padding: '1.25em',
              maxWidth: '480px',
              width: '90%',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85em',
            }}
          >
            <h3 id="profile-export-dialog-title" style={{ margin: 0 }}>Generate DEXPI Profile</h3>
            <div style={{ fontSize: '0.85em', color: '#555' }}>
              Walks the current model, infers project-specific class /
              property extensions, and downloads a deterministic Profile
              XML that closes any strict-mode fidelity gaps. Re-import the
              file to apply it in this session.
            </div>

            <div className="form-group">
              <label>Filename:</label>
              <input
                type="text"
                value={profileExportFilename}
                onChange={(e) => setProfileExportFilename(e.target.value)}
                placeholder="generated-profile.xml"
              />
            </div>

            <div style={{ display: 'flex', gap: '0.5em', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowProfileExportDialog(false)} className="btn">
                Cancel
              </button>
              <button
                onClick={() => { setShowProfileExportDialog(false); handleGenerateProfile(); }}
                className="btn btn-primary"
              >
                Generate
              </button>
            </div>
          </div>
        </div>
      )}

      {showSvgExportDialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="svg-export-dialog-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowSvgExportDialog(false);
          }}
        >
          <div
            style={{
              background: '#fff',
              color: '#222',
              borderRadius: '8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
              padding: '1.25em',
              maxWidth: '480px',
              width: '90%',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85em',
            }}
          >
            <h3 id="svg-export-dialog-title" style={{ margin: 0 }}>Export SVG</h3>
            <div style={{ fontSize: '0.85em', color: '#555' }}>
              Saves the current diagram as a vector SVG for embedding in
              documents or publications.
            </div>

            <div className="form-group">
              <label>Filename:</label>
              <input
                type="text"
                value={svgExportFilename}
                onChange={(e) => setSvgExportFilename(e.target.value)}
                placeholder="process-diagram.svg"
              />
            </div>

            <div style={{ display: 'flex', gap: '0.5em', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowSvgExportDialog(false)} className="btn">
                Cancel
              </button>
              <button
                onClick={() => { setShowSvgExportDialog(false); handleExportSvg(); }}
                className="btn btn-primary"
              >
                Export
              </button>
            </div>
          </div>
        </div>
      )}

      {showBpmnExportDialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="bpmn-export-dialog-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowBpmnExportDialog(false);
          }}
        >
          <div
            style={{
              background: '#fff',
              color: '#222',
              borderRadius: '8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
              padding: '1.25em',
              maxWidth: '480px',
              width: '90%',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85em',
            }}
          >
            <h3 id="bpmn-export-dialog-title" style={{ margin: 0 }}>Export BPMN</h3>
            <div style={{ fontSize: '0.85em', color: '#555' }}>
              Saves the current diagram (DEXPI annotations included) as a
              BPMN 2.0 XML file. Import it again later to continue editing.
            </div>

            <div className="form-group">
              <label>Filename:</label>
              <input
                type="text"
                value={bpmnExportFilename}
                onChange={(e) => setBpmnExportFilename(e.target.value)}
                placeholder="process-model.bpmn"
              />
            </div>

            <div style={{ display: 'flex', gap: '0.5em', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowBpmnExportDialog(false)} className="btn">
                Cancel
              </button>
              <button
                onClick={() => { setShowBpmnExportDialog(false); handleExportBpmn(); }}
                className="btn btn-primary"
              >
                Export
              </button>
            </div>
          </div>
        </div>
      )}

      {showExportDialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="export-dialog-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowExportDialog(false);
          }}
        >
          <div
            style={{
              background: '#fff',
              color: '#222',
              borderRadius: '8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
              padding: '1.25em',
              maxWidth: '480px',
              width: '90%',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85em',
            }}
          >
            <h3 id="export-dialog-title" style={{ margin: 0 }}>Export DEXPI XML</h3>
            <div style={{ fontSize: '0.85em', color: '#555' }}>
              These values are embedded in the exported DEXPI Model (project
              name, description, author) and used as the download filename.
              Defaults match the previous hardcoded export.
            </div>

            <div className="form-group">
              <label>Filename:</label>
              <input
                type="text"
                value={exportOptions.filename}
                onChange={(e) => setExportOptions({ ...exportOptions, filename: e.target.value })}
                placeholder="process-model-dexpi.xml"
              />
            </div>

            <div className="form-group">
              <label>Project name:</label>
              <input
                type="text"
                value={exportOptions.projectName}
                onChange={(e) => setExportOptions({ ...exportOptions, projectName: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label>Project description:</label>
              <input
                type="text"
                value={exportOptions.projectDescription}
                onChange={(e) => setExportOptions({ ...exportOptions, projectDescription: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label>Author:</label>
              <input
                type="text"
                value={exportOptions.author}
                onChange={(e) => setExportOptions({ ...exportOptions, author: e.target.value })}
              />
            </div>

            <div style={{ display: 'flex', gap: '0.5em', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowExportDialog(false)} className="btn">
                Cancel
              </button>
              <button
                onClick={() => { setShowExportDialog(false); handleExportDexpi(); }}
                className="btn btn-primary"
              >
                Export
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
