import CommandInterceptor from 'diagram-js/lib/command/CommandInterceptor';

const HIGH_PRIORITY = 1500;

export default class PortBehavior extends CommandInterceptor {
  private elementRegistry: any;
  private canvas: any;
  private eventBus: any;

  static $inject = ['eventBus', 'modeling', 'elementRegistry', 'canvas'];

  constructor(eventBus: any, _modeling: any, elementRegistry: any, canvas: any) {
    super(eventBus);

    this.eventBus = eventBus;
    this.elementRegistry = elementRegistry;
    this.canvas = canvas;

    // Listen to connection waypoint changes
    this.postExecuted('connection.updateWaypoints', HIGH_PRIORITY, (event: any) => {
      this.handleConnectionWaypointChange(event);
    });

    // Listen to connection layout changes
    this.postExecuted('connection.layout', HIGH_PRIORITY, (event: any) => {
      this.handleConnectionWaypointChange(event);
    });

    // Setup port drag behavior after a delay to ensure canvas is ready
    setTimeout(() => {
      this.setupPortDragBehavior();
    }, 100);
  }

  private handleConnectionWaypointChange(event: any): void {
    const connection = event.context.connection;
    if (!connection || connection.type !== 'bpmn:SequenceFlow') return;

    const bo = connection.businessObject;
    const streamName = bo.name || '';
    
    // Parse stream name to get port names
    const parts = streamName.split(' - ').map((p: string) => p.trim());
    let sourcePortName = '';
    let targetPortName = '';
    
    if (parts.length === 2) {
      [sourcePortName, targetPortName] = parts;
    } else if (parts.length === 3) {
      [sourcePortName, , targetPortName] = parts;
    }

    if (!sourcePortName || !targetPortName) return;

    // Update source and target port positions
    if (connection.waypoints && connection.waypoints.length >= 2) {
      const sourceElement = connection.source;
      const targetElement = connection.target;

      // Update source port
      if (sourceElement) {
        this.updatePortPosition(
          sourceElement,
          sourcePortName,
          'Outlet',
          connection.waypoints[0]
        );
      }

      // Update target port
      if (targetElement) {
        this.updatePortPosition(
          targetElement,
          targetPortName,
          'Inlet',
          connection.waypoints[connection.waypoints.length - 1]
        );
      }
    }
  }

  private updatePortPosition(
    element: any,
    portName: string,
    direction: string,
    waypoint: { x: number; y: number }
  ): void {
    const bo = element.businessObject;
    const extensionElements = bo.extensionElements;
    
    if (!extensionElements || !extensionElements.values) return;

    // Find ports container
    const portsContainer = extensionElements.values.find(
      (e: any) => {
        const type = (e.$type || '').toLowerCase();
        return type === 'ports' || type.includes('ports') || e.port !== undefined;
      }
    );

    if (!portsContainer) return;

    // Get ports array
    let ports: any[] = [];
    if (Array.isArray(portsContainer.port)) {
      ports = portsContainer.port;
    } else if (portsContainer.port) {
      ports = [portsContainer.port];
    } else if (portsContainer.$children) {
      ports = portsContainer.$children;
    }

    // Find the port
    const port = ports.find((p: any) => {
      return (p.name === portName || p.label === portName) && 
             p.direction === direction;
    });

    if (port) {
      // Convert waypoint to relative coordinates
      const relX = waypoint.x - element.x;
      const relY = waypoint.y - element.y;

      // Update port anchor position
      port.anchorX = relX;
      port.anchorY = relY;

      // Trigger re-render
      this.eventBus.fire('elements.changed', { elements: [element] });
    }
  }

  private setupPortDragBehavior(): void {
    let draggedPort: { element: any; port: any; initialX: number; initialY: number } | null = null;

    const svg = this.canvas.get('svg');
    if (!svg) {
      console.warn('Canvas SVG not ready for port drag behavior');
      return;
    }

    // Listen for mouse down on port
    svg.addEventListener('mousedown', (e: MouseEvent) => {
      const target = e.target as SVGElement;
      const portGroup = target.closest('.dexpi-port');
      
      if (!portGroup) return;

      const portId = portGroup.getAttribute('data-port-id');
      if (!portId) return;

      // Find the element that owns this port
      const element = this.findElementWithPort(portId);
      if (!element) return;

      // Check if port has any connections
      if (this.portHasConnections(element, portId)) {
        // Port is connected, don't allow manual dragging
        return;
      }

      // Get port data
      const port = this.getPortFromElement(element, portId);
      if (!port) return;

      // Start dragging
      draggedPort = {
        element,
        port,
        initialX: e.clientX,
        initialY: e.clientY
      };

      e.preventDefault();
      e.stopPropagation();
    });

    // Listen for mouse move
    svg.addEventListener('mousemove', (e: MouseEvent) => {
      if (!draggedPort) return;

      const deltaX = e.clientX - draggedPort.initialX;
      const deltaY = e.clientY - draggedPort.initialY;

      // Get canvas zoom level
      const viewbox = this.canvas.viewbox();
      const scale = viewbox.scale || 1;

      // Convert to canvas coordinates
      const canvasDeltaX = deltaX / scale;
      const canvasDeltaY = deltaY / scale;

      // Calculate new position
      const currentX = draggedPort.port.anchorX || 0;
      const currentY = draggedPort.port.anchorY || 0;
      const newX = currentX + canvasDeltaX;
      const newY = currentY + canvasDeltaY;

      // Constrain to element boundaries
      const { width, height } = draggedPort.element;
      const portSize = 8;
      const constrainedX = Math.max(-portSize / 2, Math.min(width - portSize / 2, newX));
      const constrainedY = Math.max(-portSize / 2, Math.min(height - portSize / 2, newY));

      // Snap to edges if close
      const snapThreshold = 10;
      let finalX = constrainedX;
      let finalY = constrainedY;

      // Snap to left/right edges
      if (Math.abs(constrainedX - (-portSize / 2)) < snapThreshold) {
        finalX = -portSize / 2;
      } else if (Math.abs(constrainedX - (width - portSize / 2)) < snapThreshold) {
        finalX = width - portSize / 2;
      }

      // Snap to top/bottom edges
      if (Math.abs(constrainedY - (-portSize / 2)) < snapThreshold) {
        finalY = -portSize / 2;
      } else if (Math.abs(constrainedY - (height - portSize / 2)) < snapThreshold) {
        finalY = height - portSize / 2;
      }

      // Update port position
      draggedPort.port.anchorX = finalX;
      draggedPort.port.anchorY = finalY;
      draggedPort.initialX = e.clientX;
      draggedPort.initialY = e.clientY;

      // Trigger re-render
      this.eventBus.fire('elements.changed', { elements: [draggedPort.element] });

      e.preventDefault();
    });

    // Listen for mouse up
    svg.addEventListener('mouseup', () => {
      draggedPort = null;
    });
  }

  private findElementWithPort(portId: string): any {
    const elements = this.elementRegistry.filter((el: any) => {
      const bo = el.businessObject;
      const ext = bo.extensionElements;
      if (!ext || !ext.values) return false;

      const portsContainer = ext.values.find(
        (e: any) => {
          const type = (e.$type || '').toLowerCase();
          return type === 'ports' || type.includes('ports') || e.port !== undefined;
        }
      );

      if (!portsContainer) return false;

      let ports: any[] = [];
      if (Array.isArray(portsContainer.port)) {
        ports = portsContainer.port;
      } else if (portsContainer.port) {
        ports = [portsContainer.port];
      } else if (portsContainer.$children) {
        ports = portsContainer.$children;
      }

      return ports.some((p: any) => p.portId === portId || p.id === portId);
    });

    return elements[0] || null;
  }

  private getPortFromElement(element: any, portId: string): any {
    const bo = element.businessObject;
    const ext = bo.extensionElements;
    if (!ext || !ext.values) return null;

    const portsContainer = ext.values.find(
      (e: any) => {
        const type = (e.$type || '').toLowerCase();
        return type === 'ports' || type.includes('ports') || e.port !== undefined;
      }
    );

    if (!portsContainer) return null;

    let ports: any[] = [];
    if (Array.isArray(portsContainer.port)) {
      ports = portsContainer.port;
    } else if (portsContainer.port) {
      ports = [portsContainer.port];
    } else if (portsContainer.$children) {
      ports = portsContainer.$children;
    }

    return ports.find((p: any) => p.portId === portId || p.id === portId) || null;
  }

  private portHasConnections(element: any, portName: string): boolean {
    const elementId = element.businessObject.id;
    
    const connections = this.elementRegistry.filter((el: any) => {
      if (el.type !== 'bpmn:SequenceFlow') return false;
      const bo = el.businessObject;
      return bo.sourceRef?.id === elementId || bo.targetRef?.id === elementId;
    });

    return connections.some((conn: any) => {
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

      return sourcePortName === portName || targetPortName === portName;
    });
  }
}
