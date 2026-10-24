/**
 * DEXPI target versions.
 *
 * The tool bundles the published model files of every DEXPI release it can
 * write, and selects a set by version: the registry loads the matching
 * Process / Core (/ Plant) models, the exporter imports them by their
 * published URIs, and the importer and the standalone validator recognise a
 * document's version from the model URIs it imports.
 *
 * Everything that differs between releases is read from the loaded models
 * (property names, kinds, enumerations, class ancestry); this module only
 * knows where each release's files live and how its model URIs look.
 *
 *   2.0.0 — DEXPI Specification 2.0.0 (10 October 2025).
 *   2.0.1 — DEXPI Specification 2.0.1 (30 September 2026), the bugfix release
 *           replacing 2.0.0. Same XML Schema (DEXPI_XML_Schema.xsd is
 *           byte-identical in both releases); model changes listed in
 *           https://dexpi.org/specification/2.0.1/html/appendix/changelog.html
 */

export type DexpiVersion = '2.0.0' | '2.0.1';

export const DEXPI_VERSIONS: readonly DexpiVersion[] = ['2.0.0', '2.0.1'];

/** The version written when none is asked for. */
export const DEFAULT_DEXPI_VERSION: DexpiVersion = '2.0.0';

export type DexpiModelName = 'Core' | 'Process' | 'Plant';

/**
 * Folder of each release's model files under dexpi-schema-files/. The 2.0.0
 * files stay at the folder root (every loader in the code base and the npm
 * package layout address them there); later releases get a subfolder.
 */
const SCHEMA_SUBDIR: Record<DexpiVersion, string> = {
  '2.0.0': '',
  '2.0.1': '2.0.1',
};

/** The DEXPI XML Schema is shared by every bundled release. */
export const DEXPI_XSD_FILENAME = 'DEXPI_XML_Schema.xsd';

export function isDexpiVersion(value: unknown): value is DexpiVersion {
  return typeof value === 'string' && (DEXPI_VERSIONS as readonly string[]).includes(value);
}

/**
 * Published URI of a model file, as the specification's own model files
 * import each other: https://data.dexpi.org/models/<version>/<Model>.xml
 */
export function dexpiModelImportSource(version: DexpiVersion, model: DexpiModelName): string {
  return `https://data.dexpi.org/models/${version}/${model}.xml`;
}

/**
 * Path of a bundled model file relative to the dexpi-schema-files folder
 * ('Process.xml' for 2.0.0, '2.0.1/Process.xml' for 2.0.1).
 */
export function dexpiModelRelativePath(version: DexpiVersion, model: DexpiModelName): string {
  const sub = SCHEMA_SUBDIR[version];
  return sub ? `${sub}/${model}.xml` : `${model}.xml`;
}

/**
 * The release a model URI belongs to ('https://data.dexpi.org/models/2.0.1/Core.xml'
 * → '2.0.1'), or null when the URI carries no known version segment.
 */
export function dexpiVersionFromModelUri(uri: string): DexpiVersion | null {
  const m = /\/models\/(\d+\.\d+\.\d+)\//.exec(uri);
  return m && isDexpiVersion(m[1]) ? m[1] : null;
}

export interface DetectedDexpiVersion {
  /** A bundled release the document's <Import> sources point at, or null. */
  version: DexpiVersion | null;
  /**
   * The version segment found in the imports, bundled or not ('2.1.0' for a
   * document written against a release this build does not know), or null
   * when no import carries one.
   */
  declared: string | null;
}

/**
 * Recognise a DEXPI document's version from the model URIs it imports. The
 * Process model's import decides; failing that, the first import that
 * carries a version segment. A document that imports no versioned model
 * (local file references only, or no imports) yields null for both fields.
 */
export function detectDexpiVersion(xml: string): DetectedDexpiVersion {
  const sources: string[] = [];
  const re = /<(?:[A-Za-z_][\w.-]*:)?Import\b[^>]*\bsource\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) sources.push(m[1]);
  const candidates = [
    ...sources.filter(s => /\/Process\.xml$/i.test(s)),
    ...sources.filter(s => !/\/Process\.xml$/i.test(s)),
  ];
  for (const source of candidates) {
    const seg = /\/models\/(\d+\.\d+\.\d+)\//.exec(source);
    if (!seg) continue;
    return { version: isDexpiVersion(seg[1]) ? seg[1] : null, declared: seg[1] };
  }
  return { version: null, declared: null };
}
