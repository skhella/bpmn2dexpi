import type { PaletteEntries } from 'bpmn-js/lib/features/palette/PaletteProvider';

export default class DexpiPaletteProvider {
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
    _create: any,
    _elementFactory: any,
    spaceTool: any,
    lassoTool: any,
    handTool: any
  ) {
    this.spaceTool = spaceTool;
    this.lassoTool = lassoTool;
    this.handTool = handTool;

    palette.registerProvider(this);
  }

  getPaletteEntries(): PaletteEntries {
    const {
      spaceTool,
      lassoTool,
      handTool
    } = this;

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
      } as any
    };
  }
}
