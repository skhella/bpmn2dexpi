import DexpiPaletteProvider from './palette/DexpiPaletteProvider';
import DexpiRenderer from './renderer/DexpiRenderer';
import DexpiRules from './rules/DexpiRules';
import PortBehavior from './behavior/PortBehavior';
import AutoTypeBehavior from './behavior/AutoTypeBehavior';

export default {
  __init__: ['dexpiPaletteProvider', 'dexpiRenderer', 'dexpiRules', 'portBehavior', 'autoTypeBehavior'],
  dexpiPaletteProvider: ['type', DexpiPaletteProvider],
  dexpiRenderer: ['type', DexpiRenderer],
  dexpiRules: ['type', DexpiRules],
  portBehavior: ['type', PortBehavior],
  autoTypeBehavior: ['type', AutoTypeBehavior]
};
