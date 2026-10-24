/**
 * Bundled DEXPI model files for the browser build.
 *
 * The 2.0.0 Process and Core models are part of the main bundle (every
 * authoring panel builds its registry from them at start-up); the 2.0.1
 * pair is loaded on demand the first time an export, validation, profile
 * generation or import targets that release, and cached afterwards.
 */

import { DEFAULT_DEXPI_VERSION, type DexpiVersion } from './transformer/dexpiVersions';
import processXml200 from '../dexpi-schema-files/Process.xml?raw';
import coreXml200 from '../dexpi-schema-files/Core.xml?raw';

export interface DexpiModelXml {
  processXml: string;
  coreXml: string;
}

const cache = new Map<DexpiVersion, Promise<DexpiModelXml>>();

/** Process.xml + Core.xml of one DEXPI release, as strings. */
export function loadDexpiModelXml(version: DexpiVersion = DEFAULT_DEXPI_VERSION): Promise<DexpiModelXml> {
  let pending = cache.get(version);
  if (!pending) {
    pending = version === '2.0.1'
      ? Promise.all([
          import('../dexpi-schema-files/2.0.1/Process.xml?raw'),
          import('../dexpi-schema-files/2.0.1/Core.xml?raw'),
        ]).then(([p, c]) => ({ processXml: p.default, coreXml: c.default }))
      : Promise.resolve({ processXml: processXml200, coreXml: coreXml200 });
    cache.set(version, pending);
  }
  return pending;
}
