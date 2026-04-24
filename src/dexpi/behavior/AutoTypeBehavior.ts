import CommandInterceptor from 'diagram-js/lib/command/CommandInterceptor';

/**
 * Automatically sets default DEXPI types for newly created elements
 */
export default class AutoTypeBehavior extends CommandInterceptor {
  private moddle: any;
  private eventBus: any;
  private modeling: any;

  static $inject = ['eventBus', 'moddle', 'modeling'];

  constructor(eventBus: any, moddle: any, modeling: any) {
    super(eventBus);

    this.moddle = moddle;
    this.eventBus = eventBus;
    this.modeling = modeling;

    // Listen to shape creation
    this.postExecuted('shape.create', (event: any) => {
      const context = event.context;
      const shape = context.shape;
      
      this.autoSetDexpiType(shape);
    });

    // Listen to connection creation for auto-setting stream type
    this.postExecuted('connection.create', (event: any) => {
      const context = event.context;
      const connection = context.connection;
      
      console.log('Connection created:', connection);
      // Small delay to ensure connection is fully established
      setTimeout(() => {
        if (connection.type === 'bpmn:Association') {
          this.autoSetInformationFlow(connection);
        } else {
          this.autoSetStreamType(connection);
        }
      }, 50);
    });
  }

  private autoSetDexpiType(element: any): void {
    const businessObject = element.businessObject;
    
    // Check if it's a task-like element
    const isTask = element.type === 'bpmn:Task' || 
                   element.type === 'bpmn:SubProcess' ||
                   element.type?.includes('Task') ||
                   element.type === 'bpmn:CallActivity';
    
    const isStartEvent = element.type === 'bpmn:StartEvent' || 
                         element.type === 'bpmn:IntermediateCatchEvent';
    
    const isEndEvent = element.type === 'bpmn:EndEvent' || 
                       element.type === 'bpmn:IntermediateThrowEvent';

    if (!isTask && !isStartEvent && !isEndEvent) {
      return;
    }

    // Check if it already has extension elements
    let extensionElements = businessObject.extensionElements;
    if (!extensionElements) {
      extensionElements = this.moddle.create('bpmn:ExtensionElements');
      businessObject.extensionElements = extensionElements;
    }

    if (!extensionElements.values) {
      extensionElements.values = [];
    }

    // Check if dexpi:Element already exists
    const existingDexpiElement = extensionElements.values.find(
      (e: any) => e.$type === 'dexpi:Element' || e.$type === 'dexpi:element'
    );

    if (existingDexpiElement) {
      // Already has DEXPI data, don't override
      return;
    }

    // Create new dexpi:Element with default type
    const dexpiElement = this.moddle.create('dexpi:Element');
    
    if (isTask) {
      dexpiElement.dexpiType = 'ProcessStep';
    } else if (isStartEvent) {
      dexpiElement.dexpiType = 'Source';
    } else if (isEndEvent) {
      dexpiElement.dexpiType = 'Sink';
    }

    extensionElements.values.push(dexpiElement);

    // Fire element.changed event to trigger renderer update
    this.eventBus.fire('element.changed', { element });
  }

  private autoSetInformationFlow(connection: any): void {
    const businessObject = connection.businessObject;

    let extensionElements = businessObject.extensionElements;
    if (!extensionElements) {
      extensionElements = this.moddle.create('bpmn:ExtensionElements');
      businessObject.extensionElements = extensionElements;
    }
    if (!extensionElements.values) {
      extensionElements.values = [];
    }

    const existingStream = extensionElements.values.find(
      (e: any) => e.$type === 'dexpi:Stream' || e.$type === 'Stream'
    );
    if (existingStream) return;

    const stream = this.moddle.create('dexpi:Stream');
    stream.streamType = 'InformationFlow';
    stream.uid = businessObject.id;
    stream.identifier = businessObject.id;
    extensionElements.values.push(stream);

    this.modeling.updateProperties(connection, { extensionElements });
    this.eventBus.fire('element.changed', { element: connection });
  }

  private autoSetStreamType(connection: any): void {
    if (connection.type !== 'bpmn:SequenceFlow') {
      return;
    }

    const businessObject = connection.businessObject;

    // Check if it already has extension elements with stream data
    let extensionElements = businessObject.extensionElements;
    if (!extensionElements) {
      extensionElements = this.moddle.create('bpmn:ExtensionElements');
      businessObject.extensionElements = extensionElements;
    }

    if (!extensionElements.values) {
      extensionElements.values = [];
    }

    // Check if Stream already exists
    const existingStream = extensionElements.values.find(
      (e: any) => e.$type === 'dexpi:Stream' || e.$type === 'Stream'
    );

    if (existingStream) {
      // Already has stream data, don't override
      return;
    }

    // Create new Stream with MaterialFlow as default type
    const stream = this.moddle.create('dexpi:Stream');
    stream.streamType = 'MaterialFlow';
    stream.uid = businessObject.id; // Use BPMN ID as UID
    stream.identifier = businessObject.id;

    extensionElements.values.push(stream);

    // Auto-generate ports on source and target elements
    this.autoGeneratePorts(connection, stream.streamType);
  }

  private autoGeneratePorts(connection: any, streamType: string): void {
    const source = connection.source;
    const target = connection.target;

    console.log('Auto-generating ports for connection:', connection.id, 'StreamType:', streamType);
    console.log('Source:', source, 'Target:', target);

    if (!source || !target) {
      console.log('Source or target missing, skipping port generation');
      return;
    }

    // Determine port type based on stream type
    let portType = 'MaterialPort';
    let outletPrefix = 'MO';
    let inletPrefix = 'MI';

    if (streamType === 'EnergyFlow') {
      portType = 'ThermalEnergyPort'; // Default to thermal energy
      outletPrefix = 'TEO';
      inletPrefix = 'TEI';
    }

    // Create outlet port on source
    const outletPortName = this.getNextPortName(source, outletPrefix);
    this.createPort(source, outletPortName, portType, 'Outlet');

    // Create inlet port on target
    const inletPortName = this.getNextPortName(target, inletPrefix);
    this.createPort(target, inletPortName, portType, 'Inlet');

    // Update connection name to show port connection
    this.modeling.updateProperties(connection, {
      name: `${outletPortName} - ${inletPortName}`
    });
  }

  private getNextPortName(element: any, prefix: string): string {
    const businessObject = element.businessObject;
    const extensionElements = businessObject.extensionElements;

    let maxNumber = 0;

    if (extensionElements && extensionElements.values) {
      // Check dexpi:Element ports
      const dexpiElement = extensionElements.values.find(
        (e: any) => e.$type === 'dexpi:Element' || e.$type === 'dexpi:element'
      );

      if (dexpiElement && dexpiElement.ports) {
        dexpiElement.ports.forEach((port: any) => {
          const name = port.name || '';
          if (name.startsWith(prefix)) {
            const num = parseInt(name.substring(prefix.length));
            if (!isNaN(num) && num > maxNumber) {
              maxNumber = num;
            }
          }
        });
      }

      // Check legacy ports container
      const portsContainer = extensionElements.values.find(
        (e: any) => {
          const type = (e.$type || '').toLowerCase();
          return type === 'ports' || type.includes('ports') || e.port !== undefined;
        }
      );

      if (portsContainer) {
        const legacyPorts = portsContainer.port || [];
        (Array.isArray(legacyPorts) ? legacyPorts : [legacyPorts]).forEach((port: any) => {
          const name = port.name || port.label || '';
          if (name.startsWith(prefix)) {
            const num = parseInt(name.substring(prefix.length));
            if (!isNaN(num) && num > maxNumber) {
              maxNumber = num;
            }
          }
        });
      }
    }

    return `${prefix}${maxNumber + 1}`;
  }

  private createPort(element: any, portName: string, portType: string, direction: string): void {
    const businessObject = element.businessObject;

    // Ensure extension elements exist
    let extensionElements = businessObject.extensionElements;
    if (!extensionElements) {
      extensionElements = this.moddle.create('bpmn:ExtensionElements');
      businessObject.extensionElements = extensionElements;
    }

    if (!extensionElements.values) {
      extensionElements.values = [];
    }

    // Find or create dexpi:Element
    let dexpiElement = extensionElements.values.find(
      (e: any) => e.$type === 'dexpi:Element' || e.$type === 'dexpi:element'
    );

    if (!dexpiElement) {
      dexpiElement = this.moddle.create('dexpi:Element');
      extensionElements.values.push(dexpiElement);
    }

    // Initialize ports array if it doesn't exist
    if (!dexpiElement.ports) {
      dexpiElement.ports = [];
    }

    // Create the port using dexpi:Port type
    const port = this.moddle.create('dexpi:Port');
    port.portId = `${businessObject.id}_${portName}_port`;
    port.name = portName;
    port.portType = portType;
    port.direction = direction;

    dexpiElement.ports.push(port);

    // Update the element to trigger re-render
    this.modeling.updateProperties(element, {
      extensionElements
    });

    // Fire element.changed event
    this.eventBus.fire('element.changed', { element });
  }
}
