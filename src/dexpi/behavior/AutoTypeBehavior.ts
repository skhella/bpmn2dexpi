import CommandInterceptor from 'diagram-js/lib/command/CommandInterceptor';

/**
 * Automatically sets default DEXPI types for newly created elements
 */
export default class AutoTypeBehavior extends CommandInterceptor {
  private moddle: any;

  static $inject = ['eventBus', 'moddle'];

  constructor(eventBus: any, moddle: any) {
    super(eventBus);

    this.moddle = moddle;

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
      
      this.autoSetStreamType(connection);
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
      (e: any) => e.$type === 'Stream' || e.$type?.includes('Stream')
    );

    if (existingStream) {
      // Already has stream data, don't override
      return;
    }

    // Create new Stream with MaterialFlow as default type
    const stream = this.moddle.create('Stream');
    stream.streamType = 'MaterialFlow';
    stream.uid = businessObject.id; // Use BPMN ID as UID
    stream.identifier = businessObject.id;

    extensionElements.values.push(stream);
  }
}
