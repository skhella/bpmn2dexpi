import BaseRenderer from 'diagram-js/lib/draw/BaseRenderer';
import { append as svgAppend, attr as svgAttr, create as svgCreate, classes as svgClasses } from 'tiny-svg';
import type { DexpiPort } from '../moddle';
import { DexpiProcessClassRegistry } from '../../transformer/DexpiProcessClassRegistry';
import processXmlRaw from '../../../dexpi-schema-files/Process.xml?raw';

// Build registry once at module load — synchronous, browser-safe (same approach as DexpiPropertiesPanel)
const RENDERER_REGISTRY = DexpiProcessClassRegistry.fromXml(processXmlRaw);

const HIGH_PRIORITY = 1500;

export default class DexpiRenderer extends BaseRenderer {
  private bpmnRenderer: any;
  private elementRegistry: any;

  static $inject = ['eventBus', 'bpmnRenderer', 'elementRegistry'];

  constructor(eventBus: any, bpmnRenderer: any, elementRegistry: any) {
    super(eventBus, HIGH_PRIORITY);
    this.bpmnRenderer = bpmnRenderer;
    this.elementRegistry = elementRegistry;
  }

  canRender(element: any): boolean {
    // We render ports on tasks (including subprocesses), events, and activities
    // Also handle StartEvents for dimming when they're port proxies
    return element.type === 'bpmn:Task' || 
           element.type === 'bpmn:SubProcess' ||
           element.type === 'bpmn:ServiceTask' ||
           element.type === 'bpmn:UserTask' ||
           element.type === 'bpmn:ScriptTask' ||
           element.type === 'bpmn:ManualTask' ||
           element.type === 'bpmn:BusinessRuleTask' ||
           element.type === 'bpmn:SendTask' ||
           element.type === 'bpmn:ReceiveTask' ||
           element.type === 'bpmn:CallActivity' ||
           element.type === 'bpmn:StartEvent' || 
           element.type === 'bpmn:EndEvent' ||
           element.type === 'bpmn:IntermediateCatchEvent' ||
           element.type === 'bpmn:IntermediateThrowEvent';
  }

  drawShape(parentNode: SVGElement, element: any): SVGElement {
    // Let BPMN renderer draw the base shape
    const shape = this.bpmnRenderer.drawShape(parentNode, element);

    // Apply color based on DEXPI type
    this.applyDexpiTypeColor(shape, element);

    // Remove any existing port overlays before redrawing (handles toggle off→on→off)
    const existingPorts = parentNode.querySelectorAll('.dexpi-port');
    existingPorts.forEach((p: any) => p.parentNode?.removeChild(p));

    // Check if ports should be rendered (can be controlled via config or global flag)
    // For now, ports are disabled by default - they exist in XML but aren't displayed
    const shouldRenderPorts = (window as any).__dexpi_show_ports__ || false;
    
    // Handle StartEvent/EndEvent dimming when it's a port proxy and ports are visible
    if ((element.type === 'bpmn:StartEvent' || element.type === 'bpmn:EndEvent') && shouldRenderPorts) {
      const isProxy = this.isPortProxyEvent(element);
      if (isProxy) {
        // Dim the Event to indicate it's redundant with the port overlay
        svgAttr(shape, {
          opacity: '0.1'
        });
        
        // Also dim the label if it exists
        if (element.label) {
          const labelGfx = this.elementRegistry.getGraphics(element.label);
          if (labelGfx) {
            svgAttr(labelGfx, { opacity: '0.1' });
          }
        }
        
        // Add title element for tooltip
        const title = svgCreate('title');
        const portName = element.businessObject.name || 'Unknown';
        const eventType = element.type === 'bpmn:StartEvent' ? 'inlet' : 'outlet';
        title.textContent = `Port Proxy: This event represents the ${portName} ${eventType} port from the parent level`;
        svgAppend(shape, title);
      }
      return shape;
    }
    
    if (!shouldRenderPorts) {
      return shape;
    }

    // Add port overlays
    const businessObject = element.businessObject;
    const extensionElements = businessObject.extensionElements;

    if (extensionElements && extensionElements.values) {
      const dexpiElement = extensionElements.values.find(
        (e: any) => e.$type === 'dexpi:Element'
      );

      if (dexpiElement && dexpiElement.ports) {
        this.drawPorts(parentNode, element, dexpiElement.ports);
      }
      
      // Also check for legacy ports container
      const portsContainer = extensionElements.values.find(
        (e: any) => {
          const type = (e.$type || '').toLowerCase();
          return type === 'ports' || type.includes('ports') || e.port !== undefined;
        }
      );
      
      if (portsContainer && !dexpiElement) {
        // Extract and normalize legacy ports
        let legacyPorts = [];
        if (Array.isArray(portsContainer.port)) {
          legacyPorts = portsContainer.port;
        } else if (portsContainer.port) {
          legacyPorts = [portsContainer.port];
        } else if (portsContainer.$children) {
          legacyPorts = portsContainer.$children;
        }
        
        
        // Make port IDs unique by combining element ID + port name
        const normalizedPorts = legacyPorts.map((p: any) => {
          // Normalize direction: Input/Output → Inlet/Outlet for consistency
          let direction = p.direction || 'Inlet';
          if (direction === 'Input') direction = 'Inlet';
          if (direction === 'Output') direction = 'Outlet';
          
          return {
            portId: `${element.businessObject.id}_${p.name || p.label}`,
            name: p.name || p.label,
            type: p.type || p.type,
            direction: direction,
            anchorSide: p.anchorSide || 'left',
            anchorOffset: p.anchorOffset !== undefined ? p.anchorOffset : 0.5,
            _originalId: p.id
          };
        });
        
        this.drawPorts(parentNode, element, normalizedPorts);
      } else if (!dexpiElement) {
        // No DEXPI element — nothing to draw
      }
    } else {
        // Non-task element — no port rendering needed
    }

    return shape;
  }

  drawConnection(parentNode: SVGElement, element: any): SVGElement {
    // Use default BPMN connection rendering
    const connection = this.bpmnRenderer.drawConnection(parentNode, element);
    
    // Always check if this connection comes from/to a port proxy Event
    if (element.type === 'bpmn:SequenceFlow') {
      const source = element.source;
      const target = element.target;
      
      const sourceIsProxy = source && (source.type === 'bpmn:StartEvent' || source.type === 'bpmn:EndEvent') && this.isPortProxyEvent(source);
      const targetIsProxy = target && (target.type === 'bpmn:StartEvent' || target.type === 'bpmn:EndEvent') && this.isPortProxyEvent(target);
      
      if (sourceIsProxy || targetIsProxy) {
        // Dim the proxy sequence flow to match the dimmed Event
        svgAttr(connection, {
          opacity: '0.5',
          stroke: 'red',
          'stroke-width': '3'
        });
        
        // Add tooltip
        const title = svgCreate('title');
        title.textContent = `Proxy Flow: This connection represents a port proxy from the parent level`;
        svgAppend(connection, title);
      }
    }
    
    return connection;
  }

  getShapePath(element: any): string {
    return this.bpmnRenderer.getShapePath(element);
  }

  /**
   * Detects if a Start/EndEvent is a "port proxy" - a legacy pattern where Start/EndEvents
   * inside subprocesses represent inlet/outlet ports from the parent level.
   * These are redundant when port overlays are shown.
   * Also checks for events without ports that connect to activities with matching port names.
   */
  private isPortProxyEvent(element: any): boolean {
    if (element.type !== 'bpmn:StartEvent' && element.type !== 'bpmn:EndEvent') return false;
    
    // Check if this StartEvent has a port definition
    const businessObject = element.businessObject;
    const extensionElements = businessObject.extensionElements;
    
    if (!extensionElements || !extensionElements.values) {
      // Check if this is an event without ports that connects to an activity
      return this.isPortlessProxyEvent(element);
    }
    
    const portsContainer = extensionElements.values.find(
      (e: any) => {
        const type = (e.$type || '').toLowerCase();
        return type === 'ports' || type.includes('ports') || e.port !== undefined;
      }
    );
    
    if (!portsContainer) {
      // No ports container found - check portless proxy pattern
      return this.isPortlessProxyEvent(element);
    }
    
    // Extract port name from the StartEvent's port definition
    let portName: string | null = null;
    
    if (Array.isArray(portsContainer.port) && portsContainer.port.length > 0) {
      portName = portsContainer.port[0].name || portsContainer.port[0].label;
    } else if (portsContainer.port) {
      portName = portsContainer.port.name || portsContainer.port.label;
    } else if (portsContainer.$children && portsContainer.$children.length > 0) {
      const firstPort = portsContainer.$children[0];
      portName = firstPort.name || firstPort.label;
    }
    
    if (!portName) return false;
    
    // Get the direction of the StartEvent's port
    let startEventPortDirection: string | null = null;
    if (Array.isArray(portsContainer.port) && portsContainer.port.length > 0) {
      startEventPortDirection = (portsContainer.port[0].direction || '').toLowerCase();
    } else if (portsContainer.port) {
      startEventPortDirection = (portsContainer.port.direction || '').toLowerCase();
    } else if (portsContainer.$children && portsContainer.$children.length > 0) {
      const firstPort = portsContainer.$children[0];
      startEventPortDirection = (firstPort.direction || '').toLowerCase();
    }
    
    // Check if the parent is a subprocess with a matching port
    const parent = element.parent;
    if (!parent || (parent.type !== 'bpmn:SubProcess' && parent.type !== 'bpmn:Process')) {
      return false;
    }
    
    const parentBusinessObject = parent.businessObject;
    const parentExtensions = parentBusinessObject?.extensionElements;
    
    if (!parentExtensions || !parentExtensions.values) return false;
    
    // Look for matching port on parent
    const parentPortsContainer = parentExtensions.values.find(
      (e: any) => {
        const type = (e.$type || '').toLowerCase();
        return type === 'ports' || type.includes('ports') || e.port !== undefined;
      }
    );
    
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
    
    // Check if parent has a port with matching name
    // For inlet StartEvent port -> look for parent inlet port
    // For outlet StartEvent port -> look for parent outlet port
    const hasMatchingPort = parentPorts.some((port: any) => {
      const pName = port.name || port.label;
      const pDirection = (port.direction || '').toLowerCase();
      
      // Match by name and check if directions are compatible:
      // StartEvent with outlet -> parent should have inlet (flow coming in)
      // StartEvent with inlet -> parent should have outlet (flow going out)
      if (pName === portName) {
        if (startEventPortDirection === 'outlet') {
          // This StartEvent outputs to internal tasks, so parent receives input
          return pDirection === 'inlet';
        } else if (startEventPortDirection === 'inlet') {
          // This StartEvent receives from internal tasks, so parent outputs
          return pDirection === 'outlet';
        }
        // If no direction specified, match by name only
        return true;
      }
      return false;
    });
    
    
    return hasMatchingPort;
  }

  /**
   * Check if an event without ports is a proxy by examining its connected activity.
   * Pattern: Event (e.g., "EEI1") flows to/from an activity that has a port matching the event's name.
   */
  private isPortlessProxyEvent(element: any): boolean {
    const businessObject = element.businessObject;
    const eventName = businessObject.name;
    if (!eventName) return false;

    const isStartEvent = element.type === 'bpmn:StartEvent';
    const isEndEvent = element.type === 'bpmn:EndEvent';

    // Find the connected activity via sequence flow
    let targetActivity: any = null;

    if (isStartEvent && businessObject.outgoing && businessObject.outgoing.length > 0) {
      // For start events, look at outgoing flows
      const flow = businessObject.outgoing[0];
      targetActivity = flow.targetRef;
    } else if (isEndEvent && businessObject.incoming && businessObject.incoming.length > 0) {
      // For end events, look at incoming flows
      const flow = businessObject.incoming[0];
      targetActivity = flow.sourceRef;
    }

    if (!targetActivity) return false;

    // Check if the connected activity has a port matching the event's name
    const activityExtensions = targetActivity.extensionElements;
    if (!activityExtensions || !activityExtensions.values) return false;

    const portsContainer = activityExtensions.values.find(
      (e: any) => {
        const type = (e.$type || '').toLowerCase();
        return type === 'ports' || type.includes('ports') || e.port !== undefined;
      }
    );

    if (!portsContainer) return false;

    // Extract ports from the activity
    let activityPorts: any[] = [];
    if (Array.isArray(portsContainer.port)) {
      activityPorts = portsContainer.port;
    } else if (portsContainer.port) {
      activityPorts = [portsContainer.port];
    } else if (portsContainer.$children) {
      activityPorts = portsContainer.$children;
    }

    // Check if any port name matches the event name
    const hasMatchingPort = activityPorts.some((port: any) => {
      const portName = port.name || port.label;
      return portName === eventName;
    });

    // hasMatchingPort check complete
    return hasMatchingPort;
  }

  private drawPorts(parentNode: SVGElement, element: any, ports: DexpiPort[]): void {
    const { width, height } = element;

    ports.forEach((port: DexpiPort) => {
      const position = this.calculatePortPositionFromConnection(element, port, width, height);
      // null means "no visual connection found — don't render"
      if (position === null) return;
      this.drawPort(parentNode, port, position.x, position.y);
    });
  }

  private calculatePortPositionFromConnection(
    element: any,
    port: DexpiPort,
    width: number,
    height: number
  ): { x: number; y: number } | null {
    const portSize = 8;
    const elementId = element.businessObject.id;
    const businessObject = element.businessObject;
    
    // For InformationPorts, match each port to its specific association by name.
    // Same logic as MaterialPort/SequenceFlow matching but using the DataObject's
    // name: an IPI_Composition port matches the association whose DataObject is "Composition".
    if (port.portType === 'InformationPort' || (port as any).type === 'InformationPort') {
      // Respect manual positioning — same as calculatePortPosition does for all ports
      if (port.anchorX !== undefined && port.anchorY !== undefined) {
        return { x: port.anchorX, y: port.anchorY };
      }
      // InformationPorts only render when a visual association connection exists.
      // If no matching DataObject association is found, return null → port is not drawn.
      // This prevents export-only IPI ports from cluttering subprocess boundaries.
      const isOutlet = port.direction === 'Outlet';
      const associations = isOutlet
        ? (businessObject.dataOutputAssociations || [])
        : (businessObject.dataInputAssociations || []);

      // Strip IPI_/IPO_ prefix from name OR label to get the variable name
      const rawName = port.name || (port as any).label || '';
      const portVarName = rawName.replace(/^IP[IO]_/, '');

      for (const assoc of associations) {
        // sourceRef on dataInputAssociation is an ARRAY (isMany:true in BPMN spec)
        // dataOutputAssociation targetRef is a single reference
        const dataObjId = isOutlet
          ? assoc.targetRef?.id
          : (Array.isArray(assoc.sourceRef) ? assoc.sourceRef[0]?.id : assoc.sourceRef?.id);
        if (!dataObjId) continue;

        const dataObjEl = this.elementRegistry.get(dataObjId) as any;
        const dataObjName = dataObjEl?.businessObject?.name || '';

        if (dataObjName !== portVarName) continue;

        // Find the rendered association element to get its waypoints
        const assocEl = this.elementRegistry.find((el: any) =>
          el.businessObject?.id === assoc.id
        );
        if (!assocEl?.waypoints?.length) continue;

        // Task-side waypoint: outlets use first waypoint (where line leaves the task),
        // inlets use last waypoint (where line enters the task)
        const pt = isOutlet
          ? assocEl.waypoints[0]
          : assocEl.waypoints[assocEl.waypoints.length - 1];

        return { x: pt.x - element.x - 4, y: pt.y - element.y - 4 };
      }

      // Also handle plain bpmn:association elements (like our Composition fix)
      const plainAssocs = this.elementRegistry.filter((el: any) =>
        el.type === 'bpmn:Association' &&
        (el.businessObject?.sourceRef?.id === elementId ||
         el.businessObject?.targetRef?.id === elementId)
      );
      for (const assocEl of plainAssocs) {
        const bo = assocEl.businessObject;
        const otherEnd = bo.sourceRef?.id === elementId ? bo.targetRef : bo.sourceRef;
        const otherEl = this.elementRegistry.get(otherEnd?.id) as any;
        const otherName = otherEl?.businessObject?.name || '';
        if (otherName === portVarName && assocEl.waypoints?.length > 0) {
          const portSide = bo.sourceRef?.id === elementId
            ? assocEl.waypoints[0]
            : assocEl.waypoints[assocEl.waypoints.length - 1];
          return { x: portSide.x - element.x - 4, y: portSide.y - element.y - 4 };
        }
      }

      // No matching association found — don't render this port
      return null;
    }
    
    // For MaterialPorts, EnergyPorts, etc., use SequenceFlow connections
    const connections = this.elementRegistry.filter((el: any) => {
      if (el.type !== 'bpmn:SequenceFlow') return false;
      const bo = el.businessObject;
      return bo.sourceRef?.id === elementId || bo.targetRef?.id === elementId;
    });


    // For each connection, check if it matches this port by name
    for (const conn of connections) {
      const bo = conn.businessObject;
      const streamName = bo.name || '';
      
      // Parse stream name: "SourcePort - [Stream ID] - TargetPort" or "SourcePort - TargetPort"
      const parts = streamName.split(' - ').map((p: string) => p.trim());
      let sourcePortName = '';
      let targetPortName = '';
      
      if (parts.length === 2) {
        [sourcePortName, targetPortName] = parts;
      } else if (parts.length === 3) {
        [sourcePortName, , targetPortName] = parts;
      }
      
      
      // Check if this port matches
      const isSourcePort = (bo.sourceRef?.id === elementId && port.name === sourcePortName && port.direction === 'Outlet');
      const isTargetPort = (bo.targetRef?.id === elementId && port.name === targetPortName && port.direction === 'Inlet');
      
      if (isSourcePort || isTargetPort) {
        
        if (conn.waypoints && conn.waypoints.length > 0) {
          const connectionPoint = isSourcePort ? conn.waypoints[0] : conn.waypoints[conn.waypoints.length - 1];
          
          // Convert to relative coordinates
          const relX = connectionPoint.x - element.x;
          const relY = connectionPoint.y - element.y;
          
          return { x: relX - portSize / 2, y: relY - portSize / 2 };
        }
      }
    }
    
    // Fallback: use anchor properties if available, otherwise position based on direction
    return this.calculatePortPosition(port, width, height);
  }


  private calculatePortPosition(
    port: DexpiPort,
    width: number,
    height: number
  ): { x: number; y: number } {
    // Calculate port position based on anchor
    if (port.anchorX !== undefined && port.anchorY !== undefined) {
      return { x: port.anchorX, y: port.anchorY };
    }

    const offset = port.anchorOffset || 0.5; // Default to center of side
    const portSize = 8;

    // Use anchorSide if available
    if (port.anchorSide) {
      switch (port.anchorSide) {
        case 'top':
          return { x: width * offset - portSize / 2, y: -portSize / 2 };
        case 'right':
          return { x: width - portSize / 2, y: height * offset - portSize / 2 };
        case 'bottom':
          return { x: width * offset - portSize / 2, y: height - portSize / 2 };
        case 'left':
          return { x: -portSize / 2, y: height * offset - portSize / 2 };
      }
    }

    // Final fallback: position based on direction
    if (port.direction === 'Outlet') {
      return { x: width - portSize / 2, y: height * 0.5 - portSize / 2 };
    } else {
      return { x: -portSize / 2, y: height * 0.5 - portSize / 2 };
    }
  }

  private drawPort(
    parentNode: SVGElement,
    port: DexpiPort,
    x: number,
    y: number
  ): void {
    const portGroup = svgCreate('g');
    svgAttr(portGroup, { 'class': 'dexpi-port', 'data-port-id': port.portId });

    // Draw port shape based on type and direction
    const portShape = this.createPortShape(port);
    svgAttr(portShape, {
      transform: `translate(${x}, ${y})`
    });

    svgAppend(portGroup, portShape);

    // Add port label if there's space
    if (port.name) {
      const label = svgCreate('text');
      svgAttr(label, {
        x: x + 12,
        y: y + 5,
        'font-size': '10px',
        'font-family': 'Arial, sans-serif',
        'fill': '#333'
      });
      label.textContent = port.name;
      svgAppend(portGroup, label);
    }

    svgAppend(parentNode, portGroup);
  }

  private createPortShape(port: DexpiPort): SVGElement {
    const portSize = 8;
    let shape: SVGElement;

    // Different shapes for different port types
    switch (port.portType) {
      case 'MaterialPort':
        shape = svgCreate('circle');
        svgAttr(shape, {
          cx: portSize / 2,
          cy: portSize / 2,
          r: portSize / 2,
          'stroke': '#000',
          'stroke-width': 1.5,
          'fill': port.direction === 'Inlet' ? '#4CAF50' : '#2196F3'
        });
        break;

      case 'ThermalEnergyPort':
      case 'MechanicalEnergyPort':
      case 'ElectricalEnergyPort':
        shape = svgCreate('rect');
        svgAttr(shape, {
          width: portSize,
          height: portSize,
          'stroke': '#000',
          'stroke-width': 1.5,
          'fill': port.direction === 'Inlet' ? '#FF9800' : '#FF5722'
        });
        break;

      case 'InformationPort': {
        shape = svgCreate('polygon');
        const points = `${portSize/2},0 ${portSize},${portSize/2} ${portSize/2},${portSize} 0,${portSize/2}`;
        svgAttr(shape, {
          points,
          'stroke': '#000',
          'stroke-width': 1.5,
          'fill': port.direction === 'Inlet' ? '#9C27B0' : '#673AB7'
        });
        break;
      }

      default:
        shape = svgCreate('circle');
        svgAttr(shape, {
          cx: portSize / 2,
          cy: portSize / 2,
          r: portSize / 2,
          'stroke': '#000',
          'stroke-width': 1.5,
          'fill': '#999'
        });
    }

    svgClasses(shape).add('dexpi-port-shape');
    return shape;
  }

  private applyDexpiTypeColor(shape: SVGElement, element: any): void {
    // Only apply to tasks and activities
    const isTaskLike = element.type === 'bpmn:Task' || 
                       element.type === 'bpmn:SubProcess' ||
                       element.type === 'bpmn:ServiceTask' ||
                       element.type === 'bpmn:UserTask' ||
                       element.type === 'bpmn:ScriptTask' ||
                       element.type === 'bpmn:ManualTask' ||
                       element.type === 'bpmn:BusinessRuleTask' ||
                       element.type === 'bpmn:SendTask' ||
                       element.type === 'bpmn:ReceiveTask' ||
                       element.type === 'bpmn:CallActivity';
    
    if (!isTaskLike) return;

    const businessObject = element.businessObject;
    const extensionElements = businessObject.extensionElements;


    if (!extensionElements || !extensionElements.values) return;

    const dexpiElement = extensionElements.values.find(
      (e: any) => e.$type === 'dexpi:Element' || e.$type === 'dexpi:element'
    );


    if (!dexpiElement || !dexpiElement.dexpiType) return;

    const dexpiType = dexpiElement.dexpiType;

    // Use the registry to classify by supertype — synchronous, loaded at module init
    const isInstrumentation = RENDERER_REGISTRY.hasAncestor(dexpiType, 'InstrumentationActivity');
    const isProcessStep = RENDERER_REGISTRY.hasAncestor(dexpiType, 'ProcessStep');

    let fillColor: string | null = null;
    let strokeColor: string | null = null;

    if (isInstrumentation) {
      fillColor = '#c8e6c9';   // Light green
      strokeColor = '#205022'; // Dark green
    } else if (isProcessStep) {
      fillColor = '#bbdefb';   // Light blue
      strokeColor = '#0d4372'; // Dark blue
    } // else: non-task element uses default colours

    if (fillColor && strokeColor) {
      // The shape itself IS the rect element for tasks
      const rect = shape.tagName === 'rect' ? shape : shape.querySelector('rect');
      if (rect) {
        svgAttr(rect, {
          'fill': fillColor,
          'stroke': strokeColor,
          'stroke-width': '2'
        });
      }

      // Ensure text is rendered on top by moving it to the end
      const textElement = shape.querySelector('text');
      if (textElement && textElement.parentNode) {
        textElement.parentNode.appendChild(textElement);
      }
    }
  }
}
