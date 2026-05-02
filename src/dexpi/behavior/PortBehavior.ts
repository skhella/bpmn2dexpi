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

    // Listen to explicit connection waypoint edits. Normal shape dragging also
    // triggers connection layout commands; mutating waypoints there interferes
    // with bpmn-js' move command and can make shapes snap back or stick.
    this.postExecuted('connection.updateWaypoints', HIGH_PRIORITY, (event: any) => {
      this.handleConnectionWaypointChange(event, true);
    });

    // Setup port drag behavior after diagram is imported
    eventBus.on('import.done', () => {
      // Delay to ensure canvas is fully initialized
      setTimeout(() => {
        this.setupPortDragBehavior();
      }, 100);
    });
  }

  private handleConnectionWaypointChange(event: any, dockEndpoints = false): void {
    const connection = event.context.connection;
    if (!connection || connection.type !== 'bpmn:SequenceFlow') return;

    if (dockEndpoints) {
      this.dockConnectionEndpoints(connection);
    }

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

  private dockConnectionEndpoints(connection: any): void {
    if (!connection.waypoints || connection.waypoints.length < 2) return;

    const waypoints = connection.waypoints.map((point: any) => ({ x: point.x, y: point.y }));
    const sourceDock = connection.source
      ? this.projectWaypointToBorder(connection.source, waypoints[0])
      : null;
    const targetDock = connection.target
      ? this.projectWaypointToBorder(connection.target, waypoints[waypoints.length - 1])
      : null;

    if (sourceDock) waypoints[0] = sourceDock.point;
    if (targetDock) waypoints[waypoints.length - 1] = targetDock.point;

    if (waypoints.length === 2 && waypoints[0].x !== waypoints[1].x && waypoints[0].y !== waypoints[1].y) {
      if (!sourceDock || sourceDock.side === 'left' || sourceDock.side === 'right') {
        const midX = (waypoints[0].x + waypoints[1].x) / 2;
        waypoints.splice(1, 0, { x: midX, y: waypoints[0].y }, { x: midX, y: waypoints[1].y });
      } else {
        const midY = (waypoints[0].y + waypoints[1].y) / 2;
        waypoints.splice(1, 0, { x: waypoints[0].x, y: midY }, { x: waypoints[1].x, y: midY });
      }
    } else {
      const last = waypoints.length - 1;

      if (sourceDock) {
        if (sourceDock.side === 'left' || sourceDock.side === 'right') {
          waypoints[1] = { ...waypoints[1], y: sourceDock.point.y };
        } else {
          waypoints[1] = { ...waypoints[1], x: sourceDock.point.x };
        }
      }

      if (targetDock) {
        if (targetDock.side === 'left' || targetDock.side === 'right') {
          waypoints[last - 1] = { ...waypoints[last - 1], y: targetDock.point.y };
        } else {
          waypoints[last - 1] = { ...waypoints[last - 1], x: targetDock.point.x };
        }
      }
    }

    const changed = waypoints.length !== connection.waypoints.length || waypoints.some((point: any, idx: number) => {
      const current = connection.waypoints[idx];
      return !current || point.x !== current.x || point.y !== current.y;
    });

    if (!changed) return;

    connection.waypoints = waypoints;

    const di = connection.di;
    if (di) {
      di.waypoint = waypoints.map((point: any) => ({ x: point.x, y: point.y }));
    }

    this.eventBus.fire('element.changed', { element: connection });
  }

  private projectWaypointToBorder(
    element: any,
    waypoint: { x: number; y: number }
  ): {
    point: { x: number; y: number };
    side: 'top' | 'right' | 'bottom' | 'left';
  } {
    const anchor = this.calculateBorderAnchor(element, waypoint);
    const width = element.width || 0;
    const height = element.height || 0;
    const offset = this.clamp(anchor.offset, 0, 1);

    switch (anchor.side) {
      case 'right':
        return { point: { x: element.x + width, y: element.y + height * offset }, side: anchor.side };
      case 'top':
        return { point: { x: element.x + width * offset, y: element.y }, side: anchor.side };
      case 'bottom':
        return { point: { x: element.x + width * offset, y: element.y + height }, side: anchor.side };
      case 'left':
      default:
        return { point: { x: element.x, y: element.y + height * offset }, side: anchor.side };
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
      const anchor = this.calculateBorderAnchor(element, waypoint);
      const hasChanged =
        port.anchorSide !== anchor.side ||
        port.anchorOffset !== anchor.offset ||
        port.anchorX !== undefined ||
        port.anchorY !== undefined;

      if (!hasChanged) return;

      port.anchorSide = anchor.side;
      port.anchorOffset = anchor.offset;
      delete port.anchorX;
      delete port.anchorY;

      // Trigger re-render
      this.eventBus.fire('elements.changed', { elements: [element] });
    }
  }

  private calculateBorderAnchor(
    element: any,
    waypoint: { x: number; y: number }
  ): { side: 'top' | 'right' | 'bottom' | 'left'; offset: number } {
    const relX = waypoint.x - element.x;
    const relY = waypoint.y - element.y;
    const { width, height } = element;

    const distances = [
      { side: 'left' as const, distance: Math.abs(relX), offset: height > 0 ? relY / height : 0.5 },
      { side: 'right' as const, distance: Math.abs(width - relX), offset: height > 0 ? relY / height : 0.5 },
      { side: 'top' as const, distance: Math.abs(relY), offset: width > 0 ? relX / width : 0.5 },
      { side: 'bottom' as const, distance: Math.abs(height - relY), offset: width > 0 ? relX / width : 0.5 },
    ];

    distances.sort((a, b) => a.distance - b.distance);
    const winner = distances[0];

    return {
      side: winner.side,
      offset: this.clamp(winner.offset, 0, 1),
    };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private portDragBehaviorSetup = false;

  private setupPortDragBehavior(): void {
    // Prevent duplicate setup
    if (this.portDragBehaviorSetup) return;

    let draggedPort: { element: any; port: any; initialX: number; initialY: number } | null = null;

    // Guard against canvas not being ready - this is expected during initial load
    if (!this.canvas || typeof this.canvas.get !== 'function') {
      // Silently skip - will be called again after import
      return;
    }

    const svg = this.canvas.get('svg');
    if (!svg) {
      // Silently skip - will be called again after import
      return;
    }

    this.portDragBehaviorSetup = true;

    const clearDraggedPort = () => {
      draggedPort = null;
    };

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

      // Get port data
      const port = this.getPortFromElement(element, portId);
      if (!port) return;

      // Connected ports are controlled by their sequence flow/association
      // endpoint. Let the normal canvas drag handlers receive the event.
      if (this.portHasConnections(element, port)) return;

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

    // Listen on window so a manual port drag cannot get stuck if the pointer
    // leaves the SVG before mouseup.
    window.addEventListener('mousemove', (e: MouseEvent) => {
      if (!draggedPort) return;
      if (e.buttons === 0) {
        clearDraggedPort();
        return;
      }

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

    window.addEventListener('mouseup', clearDraggedPort);
    window.addEventListener('blur', clearDraggedPort);
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

  private portHasConnections(element: any, port: any): boolean {
    const elementId = element.businessObject.id;
    const portNames = [port.name, port.label, port.id, port.portId].filter(Boolean);
    
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

      const stream = bo.extensionElements?.values?.find((value: any) =>
        value.$type === 'dexpi:Stream' || value.$type === 'dexpi:stream'
      );

      return portNames.includes(sourcePortName) ||
        portNames.includes(targetPortName) ||
        portNames.includes(stream?.sourcePortRef) ||
        portNames.includes(stream?.targetPortRef);
    });
  }
}
