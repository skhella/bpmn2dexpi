import CommandInterceptor from 'diagram-js/lib/command/CommandInterceptor';

const HIGH_PRIORITY = 1500;

export default class PortBehavior extends CommandInterceptor {
  private elementRegistry: any;
  private canvas: any;
  private eventBus: any;
  private refreshingPortOwners = false;

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
      this.handleConnectionWaypointChange(event.context.connection, true);
    });

    eventBus.on('element.changed', (event: any) => {
      if (this.refreshingPortOwners) return;
      const element = event.element;
      if (!this.isPortAwareConnection(element)) return;
      this.handleConnectionWaypointChange(element, false);
    });

    [
      'connectionSegment.move.move',
      'bendpoint.move.move',
      'connect.move',
      'connection.move',
    ].forEach(eventName => {
      eventBus.on(eventName, (event: any) => {
        const connection = event.connection || event.context?.connection || event.element;
        if (!this.isPortAwareConnection(connection)) return;
        this.handleConnectionWaypointChange(connection, false);
      });
    });

    // Setup port drag behavior after diagram is imported
    eventBus.on('import.done', () => {
      // Delay to ensure canvas is fully initialized
      setTimeout(() => {
        this.setupPortDragBehavior();
      }, 100);
    });
  }

  private handleConnectionWaypointChange(connection: any, dockEndpoints = false): void {
    if (!this.isPortAwareConnection(connection)) return;

    if (dockEndpoints && connection.type === 'bpmn:SequenceFlow') {
      this.dockConnectionEndpoints(connection);
    }

    if (connection.type === 'bpmn:SequenceFlow') {
      this.updateSequenceFlowPortAnchors(connection);
    } else {
      this.updateAssociationPortAnchors(connection);
    }

    this.refreshConnectedPortOwners(connection);
  }

  private updateSequenceFlowPortAnchors(connection: any): void {
    if (!connection.waypoints || connection.waypoints.length < 2) return;

    const bo = connection.businessObject;
    const streamName = bo.name || '';
    const stream = this.getDexpiStream(bo);
    
    // Parse stream name to get port names
    const parts = streamName.split(' - ').map((p: string) => p.trim());
    let sourcePortName = '';
    let targetPortName = '';
    
    if (parts.length === 2) {
      [sourcePortName, targetPortName] = parts;
    } else if (parts.length === 3) {
      [sourcePortName, , targetPortName] = parts;
    }

    const sourcePortCandidates = [stream?.sourcePortRef, sourcePortName].filter(Boolean);
    const targetPortCandidates = [stream?.targetPortRef, targetPortName].filter(Boolean);
    if (sourcePortCandidates.length === 0 && targetPortCandidates.length === 0) return;

    // Update source and target port positions
    const sourceElement = connection.source;
    const targetElement = connection.target;

    if (sourceElement && sourcePortCandidates.length > 0) {
      this.updatePortPosition(
        sourceElement,
        sourcePortCandidates,
        'Outlet',
        connection.waypoints[0]
      );
    }

    if (targetElement && targetPortCandidates.length > 0) {
      this.updatePortPosition(
        targetElement,
        targetPortCandidates,
        'Inlet',
        connection.waypoints[connection.waypoints.length - 1]
      );
    }
  }

  private updateAssociationPortAnchors(connection: any): void {
    if (!connection.waypoints || connection.waypoints.length < 2) return;

    const bo = connection.businessObject;
    const stream = this.getDexpiStream(bo);
    const sourceElement = connection.source;
    const targetElement = connection.target;
    const otherNameForSource = targetElement?.businessObject?.name;
    const otherNameForTarget = sourceElement?.businessObject?.name;

    if (sourceElement && this.hasPorts(sourceElement)) {
      const candidates = this.infoPortCandidates(stream?.sourcePortRef, otherNameForSource, 'Outlet');
      this.updatePortPosition(sourceElement, candidates, 'Outlet', connection.waypoints[0]);
    }

    if (targetElement && this.hasPorts(targetElement)) {
      const candidates = this.infoPortCandidates(stream?.targetPortRef, otherNameForTarget, 'Inlet');
      this.updatePortPosition(
        targetElement,
        candidates,
        'Inlet',
        connection.waypoints[connection.waypoints.length - 1]
      );
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
    portNames: string | string[],
    direction: string,
    waypoint: { x: number; y: number }
  ): void {
    const ports = this.getPorts(element);
    if (ports.length === 0) return;
    const candidates = Array.isArray(portNames) ? portNames : [portNames];

    // Find the port
    const port = ports.find((p: any) => this.portMatches(p, candidates, direction));

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
      this.eventBus.fire('element.changed', { element });
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
    const elements = this.elementRegistry.filter((el: any) =>
      this.getPorts(el).some((p: any) => this.portIdentifiers(p).includes(portId))
    );

    return elements[0] || null;
  }

  private getPortFromElement(element: any, portId: string): any {
    return this.getPorts(element).find((p: any) => this.portIdentifiers(p).includes(portId)) || null;
  }

  private portHasConnections(element: any, port: any): boolean {
    const elementId = element.businessObject.id;
    const portNames = this.portIdentifiers(port);
    
    const connections = this.elementRegistry.filter((el: any) => {
      if (!this.isPortAwareConnection(el)) return false;
      const bo = el.businessObject;
      return bo.sourceRef?.id === elementId || bo.targetRef?.id === elementId;
    });

    return connections.some((conn: any) => {
      const bo = conn.businessObject;
      if (conn.type !== 'bpmn:SequenceFlow') {
        const otherRef = bo.sourceRef?.id === elementId ? bo.targetRef : bo.sourceRef;
        const otherName = otherRef?.name;
        return !!otherName && (
          portNames.includes(otherName) ||
          portNames.includes(`IPI_${otherName}`) ||
          portNames.includes(`IPO_${otherName}`)
        );
      }

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

  private isPortAwareConnection(element: any): boolean {
    return !!element &&
      !!element.waypoints &&
      (
        element.type === 'bpmn:SequenceFlow' ||
        element.type === 'bpmn:Association' ||
        element.type === 'bpmn:DataInputAssociation' ||
        element.type === 'bpmn:DataOutputAssociation'
      );
  }

  private refreshConnectedPortOwners(connection: any): void {
    const elements = [connection.source, connection.target]
      .filter((element: any) => element && !this.isPortAwareConnection(element) && this.hasPorts(element));
    if (elements.length === 0) return;

    this.refreshingPortOwners = true;
    try {
      elements.forEach((element: any) => this.eventBus.fire('element.changed', { element }));
      this.eventBus.fire('elements.changed', { elements });
    } finally {
      this.refreshingPortOwners = false;
    }
  }

  private hasPorts(element: any): boolean {
    return this.getPorts(element).length > 0;
  }

  private getPorts(element: any): any[] {
    const values = element?.businessObject?.extensionElements?.values;
    if (!values) return [];

    const dexpiElement = values.find((e: any) => e.$type === 'dexpi:Element' || e.$type === 'dexpi:element');
    if (dexpiElement?.ports) return Array.isArray(dexpiElement.ports) ? dexpiElement.ports : [dexpiElement.ports];

    const portsContainer = values.find((e: any) => {
      const type = (e.$type || '').toLowerCase();
      return type === 'ports' || type.includes('ports') || e.port !== undefined;
    });
    if (!portsContainer) return [];

    if (Array.isArray(portsContainer.port)) return portsContainer.port;
    if (portsContainer.port) return [portsContainer.port];
    if (portsContainer.$children) return portsContainer.$children;
    return [];
  }

  private getDexpiStream(bo: any): any {
    return bo.extensionElements?.values?.find((value: any) =>
      value.$type === 'dexpi:Stream' || value.$type === 'dexpi:stream'
    );
  }

  private portIdentifiers(port: any): string[] {
    return [port.portId, port.id, port.name, port.label].filter(Boolean);
  }

  private portMatches(port: any, candidates: string[], direction?: string): boolean {
    if (direction && port.direction !== direction) return false;
    const identifiers = this.portIdentifiers(port);
    return candidates.filter(Boolean).some(candidate => identifiers.includes(candidate));
  }

  private infoPortCandidates(portRef: string | undefined, variableName: string | undefined, direction: 'Inlet' | 'Outlet'): string[] {
    const prefix = direction === 'Outlet' ? 'IPO_' : 'IPI_';
    return [
      portRef,
      variableName,
      variableName ? `${prefix}${variableName}` : undefined,
    ].filter(Boolean) as string[];
  }
}
