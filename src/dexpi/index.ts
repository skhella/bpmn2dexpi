import DexpiPaletteProvider from './palette/DexpiPaletteProvider';
import DexpiRenderer from './renderer/DexpiRenderer';
import DexpiRules from './rules/DexpiRules';

export default {
  __init__: ['dexpiPaletteProvider', 'dexpiRenderer', 'dexpiRules'],
  dexpiPaletteProvider: ['type', DexpiPaletteProvider],
  dexpiRenderer: ['type', DexpiRenderer],
  dexpiRules: ['type', DexpiRules]
};
