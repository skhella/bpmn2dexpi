interface BpmnElement {
  type?: string;
}

interface ConnectionLike {
  source?: BpmnElement;
  target?: BpmnElement;
}

interface ConnectionCreateContext {
  source: BpmnElement;
  target: BpmnElement;
}

interface ConnectionReconnectContext {
  connection: ConnectionLike;
  source?: BpmnElement;
  target?: BpmnElement;
}

interface EventBus {
  on(event: string, priority: number, callback: (context: unknown) => unknown): void;
}

type RuleFn<T> = (context: T) => boolean | undefined;

export default class DexpiRules {
  private eventBus: EventBus;

  static $inject = ['eventBus'];

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.init();
  }

  init(): void {
    this.addRule<ConnectionCreateContext>('connection.create', (context) => {
      return this.canConnect(context.source, context.target);
    });

    this.addRule<ConnectionReconnectContext>('connection.reconnect', (context) => {
      const source = context.source ?? context.connection.source;
      const target = context.target ?? context.connection.target;
      return this.canConnect(source, target);
    });
  }

  addRule<T>(action: string, fn: RuleFn<T>): void {
    this.eventBus.on(action, 1500, (context: unknown) => {
      const result = fn(context as T);
      if (result !== undefined) return result;
      return undefined;
    });
  }

  canConnect(source?: BpmnElement, target?: BpmnElement): boolean {
    if (!source || !target) return false;
    if (source === target) return false;
    const validTypes = ['bpmn:Task', 'bpmn:StartEvent', 'bpmn:EndEvent'];
    return !!source.type && !!target.type
      && validTypes.includes(source.type)
      && validTypes.includes(target.type);
  }
}
