import DexpiPaletteProvider from './palette/DexpiPaletteProvider';
import DexpiSubsetFilter from './palette/DexpiSubsetFilter';
import DexpiRenderer from './renderer/DexpiRenderer';
import DexpiRules from './rules/DexpiRules';
import PortBehavior from './behavior/PortBehavior';
import AutoTypeBehavior from './behavior/AutoTypeBehavior';

export default {
  __init__: ['dexpiPaletteProvider', 'dexpiSubsetFilter', 'dexpiRenderer', 'dexpiRules', 'portBehavior', 'autoTypeBehavior'],
  dexpiPaletteProvider: ['type', DexpiPaletteProvider],
  dexpiSubsetFilter: ['type', DexpiSubsetFilter],
  dexpiRenderer: ['type', DexpiRenderer],
  dexpiRules: ['type', DexpiRules],
  portBehavior: ['type', PortBehavior],
  autoTypeBehavior: ['type', AutoTypeBehavior]
};
