import type { PaletteEntries } from 'bpmn-js/lib/features/palette/PaletteProvider';

export default class DexpiPaletteProvider {
  private create: any;
  private elementFactory: any;
  private spaceTool: any;
  private lassoTool: any;
  private handTool: any;
  private globalConnect: any;

  static $inject = [
    'palette',
    'create',
    'elementFactory',
    'spaceTool',
    'lassoTool',
    'handTool',
    'globalConnect'
  ];

  constructor(
    palette: any,
    create: any,
    elementFactory: any,
    spaceTool: any,
    lassoTool: any,
    handTool: any,
    globalConnect: any
  ) {
    this.create = create;
    this.elementFactory = elementFactory;
    this.spaceTool = spaceTool;
    this.lassoTool = lassoTool;
    this.handTool = handTool;
    this.globalConnect = globalConnect;

    palette.registerProvider(this);
  }

  getPaletteEntries(): PaletteEntries {
    const {
      create,
      elementFactory,
      spaceTool,
      lassoTool,
      handTool,
      globalConnect
    } = this;

    function createShapeAction(type: string, options?: object) {
      return function (event: any) {
        const shape = elementFactory.createShape({ type, ...options });
        create.start(event, shape);
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
      'global-connect-tool': {
        group: 'tools',
        className: 'bpmn-icon-connection-multi',
        title: 'Activate Global Connect Tool / DEXPI: Stream',
        action: {
          click: (event: any) => {
            globalConnect.toggle(event);
          }
        }
      },

      // Override default entries to include DEXPI mapping in tooltip
      'create.start-event': {
        group: 'event',
        className: 'bpmn-icon-start-event-none',
        title: 'Start Event / DEXPI: Source',
        action: {
          dragstart: createShapeAction('bpmn:StartEvent'),
          click: createShapeAction('bpmn:StartEvent')
        }
      },
      'create.end-event': {
        group: 'event',
        className: 'bpmn-icon-end-event-none',
        title: 'End Event / DEXPI: Sink',
        action: {
          dragstart: createShapeAction('bpmn:EndEvent'),
          click: createShapeAction('bpmn:EndEvent')
        }
      },
      'create.task': {
        group: 'activity',
        className: 'bpmn-icon-task',
        title: 'Task / DEXPI: ProcessStep / DEXPI: InstrumentationActivity',
        action: {
          dragstart: createShapeAction('bpmn:Task'),
          click: createShapeAction('bpmn:Task')
        }
      },
      'create.subprocess-expanded': {
        group: 'activity',
        className: 'bpmn-icon-subprocess-expanded',
        title: 'SubProcess (expanded) / DEXPI: ProcessStep hierarchy',
        action: {
          dragstart: createShapeAction('bpmn:SubProcess', { isExpanded: true }),
          click: createShapeAction('bpmn:SubProcess', { isExpanded: true })
        }
      },
      'create.subprocess-collapsed': {
        group: 'activity',
        className: 'bpmn-icon-subprocess-collapsed',
        title: 'SubProcess (collapsed) / DEXPI: ProcessStep (internals not yet modelled)',
        action: {
          dragstart: createShapeAction('bpmn:SubProcess', { isExpanded: false }),
          click: createShapeAction('bpmn:SubProcess', { isExpanded: false })
        }
      },
      'create.association-separator': {
        group: 'connect',
        separator: true,
        action: {}
      } as any,
      'create.information-flow': {
        group: 'connect',
        className: 'bpmn-icon-connection',
        title: 'Information Flow (Association) / DEXPI: InformationFlow — connects InstrumentationActivity to measured element',
        action: {
          click: (event: any) => {
            globalConnect.toggle(event);
          }
        }
      }
    };
  }
}
