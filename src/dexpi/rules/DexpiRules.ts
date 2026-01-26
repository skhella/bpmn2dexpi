export default class DexpiRules {
  private eventBus: any;

  static $inject = ['eventBus'];

  constructor(eventBus: any) {
    this.eventBus = eventBus;

    // Register rules
    this.init();
  }

  init(): void {
    this.addRule('connection.create', (context: any) => {
      const source = context.source;
      const target = context.target;

      // Only allow connections between elements that have ports
      return this.canConnect(source, target);
    });

    this.addRule('connection.reconnect', (context: any) => {
      const connection = context.connection;
      const source = context.source || connection.source;
      const target = context.target || connection.target;

      return this.canConnect(source, target);
    });
  }

  addRule(action: string, fn: (context: any) => boolean | undefined): void {
    this.eventBus.on(action, 1500, (context: any) => {
      const result = fn(context);
      if (result !== undefined) {
        return result;
      }
    });
  }

  canConnect(source: any, target: any): boolean {
    // Check if source and target are valid DEXPI elements
    if (!source || !target) {
      return false;
    }

    // Don't allow connecting to self
    if (source === target) {
      return false;
    }

    // Check if both elements are DEXPI-compatible types
    const validTypes = ['bpmn:Task', 'bpmn:StartEvent', 'bpmn:EndEvent'];
    
    if (!validTypes.includes(source.type) || !validTypes.includes(target.type)) {
      return false;
    }

    // Allow connections between process steps, sources, and sinks
    return true;
  }
}
