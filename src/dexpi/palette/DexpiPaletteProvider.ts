import type { PaletteEntries } from 'bpmn-js/lib/features/palette/PaletteProvider';

export default class DexpiPaletteProvider {
  private create: any;
  private elementFactory: any;
  private spaceTool: any;
  private lassoTool: any;
  private handTool: any;

  static $inject = [
    'palette',
    'create',
    'elementFactory',
    'spaceTool',
    'lassoTool',
    'handTool'
  ];

  constructor(
    palette: any,
    create: any,
    elementFactory: any,
    spaceTool: any,
    lassoTool: any,
    handTool: any
  ) {
    this.create = create;
    this.elementFactory = elementFactory;
    this.spaceTool = spaceTool;
    this.lassoTool = lassoTool;
    this.handTool = handTool;

    palette.registerProvider(this);
  }

  getPaletteEntries(): PaletteEntries {
    const {
      create,
      elementFactory,
      spaceTool,
      lassoTool,
      handTool
    } = this;

    function createAction(type: string, group: string, className: string, title: string, options = {}) {
      function createListener(event: any) {
        const shape = elementFactory.createShape({ type, ...options });
        create.start(event, shape);
      }

      return {
        group,
        className,
        title,
        action: {
          dragstart: createListener,
          click: createListener
        }
      };
    }

    return {
      'hand-tool': {
        group: 'tools',
        className: 'bpmn-icon-hand-tool',
        title: 'Activate Hand Tool',
        action: {
          click: (event: any) => {
            handTool.activateHand(event);
          }
        }
      },
      'lasso-tool': {
        group: 'tools',
        className: 'bpmn-icon-lasso-tool',
        title: 'Activate Lasso Tool',
        action: {
          click: (event: any) => {
            lassoTool.activateSelection(event);
          }
        }
      },
      'space-tool': {
        group: 'tools',
        className: 'bpmn-icon-space-tool',
        title: 'Activate Space Tool',
        action: {
          click: (event: any) => {
            spaceTool.activateSelection(event);
          }
        }
      },
      'tool-separator': {
        group: 'tools',
        separator: true,
        action: {}
      } as any,
      'create.process-step': createAction(
        'bpmn:Task',
        'activity',
        'bpmn-icon-task',
        'Create Process Step'
      ),
      'create.instrumentation-activity': createAction(
        'bpmn:Task',
        'activity',
        'bpmn-icon-manual-task',
        'Create Instrumentation Activity'
      ),
      'create.source': createAction(
        'bpmn:StartEvent',
        'event',
        'bpmn-icon-start-event-none',
        'Create Source'
      ),
      'create.sink': createAction(
        'bpmn:EndEvent',
        'event',
        'bpmn-icon-end-event-none',
        'Create Sink'
      ),
      'create.data-object': createAction(
        'bpmn:DataObjectReference',
        'data',
        'bpmn-icon-data-object',
        'Create Material Template/State'
      )
    };
  }
}
