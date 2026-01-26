import BaseRenderer from 'diagram-js/lib/draw/BaseRenderer';
import { append as svgAppend, attr as svgAttr, create as svgCreate, classes as svgClasses } from 'tiny-svg';
import type { DexpiPort } from '../moddle';

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

    // Check if ports should be rendered (can be controlled via config or global flag)
    // For now, ports are disabled by default - they exist in XML but aren't displayed
    const shouldRenderPorts = (window as any).__dexpi_show_ports__ || false;
    
    // Handle StartEvent/EndEvent dimming when it's a port proxy and ports are visible
    if ((element.type === 'bpmn:StartEvent' || element.type === 'bpmn:EndEvent') && shouldRenderPorts) {
      const isProxy = this.isPortProxyEvent(element);
      console.log('Event check:', element.type, element.businessObject.id, element.businessObject.name, 'isProxy:', isProxy);
      if (isProxy) {
        console.log('Dimming Event:', element.businessObject.id);
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
            portType: p.type || p.portType,
            direction: direction,
            anchorSide: p.anchorSide || 'left',
            anchorOffset: p.anchorOffset !== undefined ? p.anchorOffset : 0.5,
            _originalId: p.id
          };
        });
        
        this.drawPorts(parentNode, element, normalizedPorts);
      } else if (!dexpiElement) {
      }
    } else {
    }

    return shape;
  }

  drawConnection(parentNode: SVGElement, element: any): SVGElement {
    // Use default BPMN connection rendering
    const connection = this.bpmnRenderer.drawConnection(parentNode, element);
    
    // Check if ports are visible and if this connection comes from/to a port proxy Event
    const shouldRenderPorts = (window as any).__dexpi_show_ports__ || false;
    if (shouldRenderPorts && element.type === 'bpmn:SequenceFlow') {
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
        const portName = sourceIsProxy ? (source.businessObject.name || 'Unknown') : (target.businessObject.name || 'Unknown');
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
   */
  private isPortProxyEvent(element: any): boolean {
    if (element.type !== 'bpmn:StartEvent' && element.type !== 'bpmn:EndEvent') return false;
    
    // Check if this StartEvent has a port definition
    const businessObject = element.businessObject;
    const extensionElements = businessObject.extensionElements;
    
    if (!extensionElements || !extensionElements.values) return false;
    
    const portsContainer = extensionElements.values.find(
      (e: any) => {
        const type = (e.$type || '').toLowerCase();
        return type === 'ports' || type.includes('ports') || e.port !== undefined;
      }
    );
    
    if (!portsContainer) return false;
    
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
    
    console.log('Port proxy check:', element.businessObject.id, portName, 'StartEvent dir:', startEventPortDirection, 'Match:', hasMatchingPort);
    
    return hasMatchingPort;
  }

  private drawPorts(parentNode: SVGElement, element: any, ports: DexpiPort[]): void {
    const { width, height } = element;

    ports.forEach((port: DexpiPort) => {
      // Calculate position from stream connections
      const position = this.calculatePortPositionFromConnection(element, port, width, height);
      this.drawPort(parentNode, port, position.x, position.y);
    });
  }

  private calculatePortPositionFromConnection(
    element: any,
    port: DexpiPort,
    width: number,
    height: number
  ): { x: number; y: number } {
    const portSize = 8;
    const elementId = element.businessObject.id;
    const businessObject = element.businessObject;
    
    // For InformationPorts, check data associations
    if (port.portType === 'InformationPort') {
      // Check data output associations for IPO (Information Port Output)
      // After normalization, Output becomes Outlet
      if (port.direction === 'Outlet' && businessObject.dataOutputAssociations) {
        const associations = businessObject.dataOutputAssociations;
        for (let i = 0; i < associations.length; i++) {
          // Find the rendered association element
          const associationElement = this.elementRegistry.find((el: any) => {
            return el.businessObject && el.businessObject.id === associations[i].id;
          });
          
          if (associationElement && associationElement.waypoints && associationElement.waypoints.length > 0) {
            // Use the first waypoint (where it connects to the task)
            const connectionPoint = associationElement.waypoints[0];
            const relX = connectionPoint.x - element.x;
            const relY = connectionPoint.y - element.y;
            return { x: relX - portSize / 2, y: relY - portSize / 2 };
          }
        }
      }
      
      // Check data input associations for IPI (Information Port Input)
      // After normalization, Input becomes Inlet
      if (port.direction === 'Inlet' && businessObject.dataInputAssociations) {
        const associations = businessObject.dataInputAssociations;
        for (let i = 0; i < associations.length; i++) {
          // Find the rendered association element
          const associationElement = this.elementRegistry.find((el: any) => {
            return el.businessObject && el.businessObject.id === associations[i].id;
          });
          
          if (associationElement && associationElement.waypoints && associationElement.waypoints.length > 0) {
            // Use the last waypoint (where it connects to the task)
            const connectionPoint = associationElement.waypoints[associationElement.waypoints.length - 1];
            const relX = connectionPoint.x - element.x;
            const relY = connectionPoint.y - element.y;
            return { x: relX - portSize / 2, y: relY - portSize / 2 };
          }
        }
      }
      
      // Fallback for InformationPorts: place on bottom for outlet, top for inlet
      if (port.direction === 'Outlet') {
        return { x: width / 2 - portSize / 2, y: height - portSize / 2 };
      } else {
        return { x: width / 2 - portSize / 2, y: -portSize / 2 };
      }
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

      case 'InformationPort':
        shape = svgCreate('polygon');
        const points = `${portSize/2},0 ${portSize},${portSize/2} ${portSize/2},${portSize} 0,${portSize/2}`;
        svgAttr(shape, {
          points,
          'stroke': '#000',
          'stroke-width': 1.5,
          'fill': port.direction === 'Inlet' ? '#9C27B0' : '#673AB7'
        });
        break;

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
}
