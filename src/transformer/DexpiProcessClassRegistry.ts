/**
 * DexpiProcessClassRegistry
 *
 * Parses the bundled DEXPI 2.0 Process.xml model file to extract the
 * authoritative list of ConcreteClass and AbstractClass names.
 *
 * Usage:
 *   const registry = await DexpiProcessClassRegistry.load();
 *   registry.isValidClass('Pumping');        // true
 *   registry.isValidClass('MyCustomStep');   // false
 *   registry.allClasses();                   // string[] of all class names
 *
 * To update the class list when DEXPI releases a new version:
 *   Replace dexpi-schema-files/Process.xml with the new file from
 *   https://dexpi.gitlab.io/-/Specification (no code changes needed).
 */

export type ClassKind = 'concrete' | 'abstract';

export interface DexpiClassInfo {
  name: string;
  kind: ClassKind;
  superTypes: string[];
  description: string;
}

export class DexpiProcessClassRegistry {
  private readonly classes: Map<string, DexpiClassInfo>;

  private constructor(classes: Map<string, DexpiClassInfo>) {
    this.classes = classes;
  }

  // ── Factory ──────────────────────────────────────────────────────────────

  /** Empty registry — size === 0, all lookups return undefined/false. */
  static empty(): DexpiProcessClassRegistry {
    return new DexpiProcessClassRegistry(new Map());
  }

  /**
   * Load the registry by parsing the bundled Process.xml.
   * In Node environments, reads the file from disk.
   * In browser environments, the caller must supply the XML string directly.
   */
  static async load(processXmlOverride?: string): Promise<DexpiProcessClassRegistry> {
    let xml: string;

    if (processXmlOverride) {
      xml = processXmlOverride;
    } else {
      try {
        // Node environment — read from dexpi-schema-files/Process.xml
        const { readFileSync } = await import('fs');
        const { join, dirname } = await import('path');
        const { fileURLToPath } = await import('url');

        // Support both ESM (__dirname equivalent) and CommonJS
        let base: string;
        try {
          // ESM
          const __filename = fileURLToPath(import.meta.url);
          base = dirname(__filename);
        } catch {
          base = __dirname;
        }

        // Walk up from src/transformer/ to repo root, then into dexpi-schema-files/
        const schemaPath = join(base, '..', '..', 'dexpi-schema-files', 'Process.xml');
        xml = readFileSync(schemaPath, 'utf-8');
      } catch {
        console.warn('[bpmn2dexpi] Could not load Process.xml from disk — using empty registry.');
        return new DexpiProcessClassRegistry(new Map());
      }
    }

    return DexpiProcessClassRegistry.fromXml(xml);
  }

  /**
   * Parse Process.xml and build the registry synchronously from a string.
   * Useful in browser contexts where the XML has been fetched separately.
   */
  static fromXml(xml: string): DexpiProcessClassRegistry {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    const classes = new Map<string, DexpiClassInfo>();

    const extract = (tagName: string, kind: ClassKind) => {
      const elements = Array.from(doc.querySelectorAll(tagName));
      elements.forEach(el => {
        const name = el.getAttribute('name');
        if (!name) return;

        const superTypesRaw = el.getAttribute('superTypes') ?? '';
        const superTypes = superTypesRaw
          .split(/\s+/)
          .filter(Boolean)
          .map(s => s.replace(/^.*\//, '')); // strip prefix, keep class name

        const descEl = el.querySelector('Data[property="MetaData/description"] > String');
        const description = descEl?.textContent?.trim() ?? '';

        classes.set(name, { name, kind, superTypes, description });
      });
    };

    extract('ConcreteClass', 'concrete');
    extract('AbstractClass', 'abstract');

    return new DexpiProcessClassRegistry(classes);
  }

  // ── Query API ─────────────────────────────────────────────────────────────

  /** Returns true if name is any class (concrete or abstract) in the registry. */
  isValidClass(name: string): boolean {
    return this.classes.has(name);
  }

  /** Returns true if name is a concrete (instantiable) class. */
  isConcreteClass(name: string): boolean {
    return this.classes.get(name)?.kind === 'concrete';
  }

  /** All concrete class names — suitable for a UI dropdown. */
  concreteClasses(): string[] {
    return Array.from(this.classes.values())
      .filter(c => c.kind === 'concrete')
      .map(c => c.name)
      .sort();
  }

  /** All class names (concrete + abstract). */
  allClasses(): string[] {
    return Array.from(this.classes.keys()).sort();
  }

  /** Returns class metadata or undefined if not found. */
  getClass(name: string): DexpiClassInfo | undefined {
    return this.classes.get(name);
  }

  /**
   * Returns true if className has ancestor somewhere in its supertype chain.
   * Works by walking superTypes recursively.
   * Used by the renderer to classify elements by colour without hardcoded lists.
   */
  hasAncestor(className: string, ancestor: string): boolean {
    if (className === ancestor) return true;
    const info = this.classes.get(className);
    if (!info) return false;
    return info.superTypes.some(st => this.hasAncestor(st, ancestor));
  }

  /** Number of classes loaded. 0 means Process.xml failed to load. */
  get size(): number {
    return this.classes.size;
  }
}
