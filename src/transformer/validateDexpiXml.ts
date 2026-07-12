/**
 * Standalone fidelity validation for an EXISTING DEXPI 2.0 XML document.
 *
 * Runs the same five information-model dimensions that strict mode applies
 * to the transformer's own output — property names + carrier kinds, data
 * types (Builtin primitives + enumeration literals, including unit
 * DataReference targets), reference target classes, cardinality bounds, and
 * class existence — against any DEXPI 2.0 file regardless of origin. The
 * per-finding message strings are produced with exactly the same mapping the
 * transformer uses, so `--validate` output and `--strict` output read
 * identically.
 *
 * XSD validation is the caller's concern (Node callers pair this with
 * validateDexpiOutputXsd; browser callers get the structural fallback).
 * This module is browser-safe: no fs, no child_process.
 *
 * Scope: DEXPI 2.0 publishes TWO document vocabularies under one
 * serialization grammar — the Process model (BFD/PFD) and the Plant model
 * (P&ID) — both built on the shared Core model. The fidelity dimensions
 * here validate against whatever the registry has loaded; the CLI's
 * --validate loads all three bundled models (the complete published DEXPI
 * 2.0 vocabulary — the three have zero class-name collisions), extendable
 * via Profiles. A document importing a model that is NOT loaded (a future
 * DEXPI model, or a project-specific one) would have its classes reported
 * as unknown, so checkImportPrefixes() also warns when the document
 * imports a model outside the bundled vocabulary — the report then says
 * "model not loaded" instead of drowning the user in spurious findings.
 *
 * Import-prefix caveat: prefixes in the DEXPI serialization are
 * author-chosen. The validators resolve `Core/...`, `Process/...` and
 * `Plant/...` qualified names — the convention used by the official
 * serialization examples and by this tool's output. checkImportPrefixes()
 * surfaces a warning when a document declares other prefixes for these
 * models, because findings against such a file would be spurious rather
 * than meaningful.
 */

import { DexpiProcessClassRegistry } from './DexpiProcessClassRegistry';
import { validateEmittedDexpiXml } from './DexpiPropertyNameValidator';
import { validateEmittedDexpiDataTypes } from './DexpiDataTypeValidator';
import { validateEmittedDexpiReferences } from './DexpiReferenceValidator';
import { validateEmittedDexpiCardinality } from './DexpiCardinalityValidator';
import { validateEmittedDexpiClassExistence } from './DexpiClassExistenceValidator';

export interface DexpiTierFindings {
  /** Human-readable tier label, matching the strict-mode summary labels. */
  tier: string;
  /** One formatted message per finding — same strings strict mode stores. */
  errors: string[];
}

export interface DexpiXmlValidation {
  tiers: DexpiTierFindings[];
  totalFindings: number;
  /** Warnings about Import prefixes the validators cannot resolve. */
  prefixWarnings: string[];
}

/**
 * Inspect the document's <Import> declarations and warn when the Core /
 * Process / Plant models are imported under prefixes other than `Core` /
 * `Process` / `Plant` (or when no Import declarations are present at all).
 */
export function checkImportPrefixes(xml: string): string[] {
  const warnings: string[] = [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch {
    return warnings; // unparseable — the tier validators will say so
  }
  const root = doc.documentElement;
  if (!root || root.querySelector('parsererror')) return warnings;

  const imports = Array.from(root.children).filter(
    c => (c.localName || '') === 'Import',
  );
  if (imports.length === 0) {
    warnings.push(
      'Document declares no <Import> elements; qualified references ' +
      '(Core/…, Process/…) cannot be tied to a model source.',
    );
    return warnings;
  }
  for (const imp of imports) {
    const prefix = imp.getAttribute('prefix') ?? '';
    const source = imp.getAttribute('source') ?? '';
    let known = false;
    for (const model of ['Core', 'Process', 'Plant'] as const) {
      if (source.includes(`${model}.xml`)) {
        known = true;
        if (prefix !== model) {
          warnings.push(
            `Import of ${model}.xml uses prefix "${prefix}"; the fidelity ` +
            `validators resolve the conventional prefix "${model}", so ` +
            `findings for this document may be spurious. Re-serialize with ` +
            `the conventional prefix for a meaningful report.`,
          );
        }
      }
    }
    // Documents importing a model outside the bundled vocabulary (a future
    // DEXPI model, or a project-specific one) would have every class from
    // it reported as unknown — say so up front instead.
    if (!known) {
      warnings.push(
        `Document imports "${source}" (prefix "${prefix}"), which is not ` +
        `part of the bundled vocabulary (the DEXPI 2.0 Process, Plant, and ` +
        `Core models, plus any loaded Profiles). Classes from it will be ` +
        `reported as unknown; supply the model file via --profile if ` +
        `available.`,
      );
    }
  }
  return warnings;
}

/**
 * Run all five fidelity dimensions against a DEXPI 2.0 XML string.
 *
 * @param xml      The DEXPI document to validate (not BPMN).
 * @param registry Registry loaded from the same Process.xml/Core.xml (+ any
 *                 Profiles) the document was written against.
 * @param label    Source label used in validator diagnostics.
 */
export function validateDexpiXml(
  xml: string,
  registry: DexpiProcessClassRegistry,
  label = 'dexpi input',
): DexpiXmlValidation {
  const nameFailures = validateEmittedDexpiXml(xml, label, registry);
  const dataTypeFailures = validateEmittedDexpiDataTypes(xml, label, registry);
  const refFailures = validateEmittedDexpiReferences(xml, label, registry);
  const cardFailures = validateEmittedDexpiCardinality(xml, label, registry);
  const classFailures = validateEmittedDexpiClassExistence(xml, label, registry);

  // Every tier uses the same `${className}.${propertyName}: ${context}`
  // mapping the transformer's strict block applies, so --validate findings
  // read identically to --strict findings.
  const tiers: DexpiTierFindings[] = [
    {
      tier: 'property-name + kind',
      errors: nameFailures.map(f => `${f.className}.${f.propertyName}: ${f.context}`),
    },
    {
      tier: 'data-type',
      errors: dataTypeFailures.map(f => `${f.className}.${f.propertyName}: ${f.context}`),
    },
    {
      tier: 'reference target-class',
      errors: refFailures.map(f => `${f.className}.${f.propertyName}: ${f.context}`),
    },
    {
      tier: 'cardinality',
      errors: cardFailures.map(f => `${f.className}.${f.propertyName}: ${f.context}`),
    },
    {
      tier: 'class existence',
      errors: classFailures.map(f => `${f.typeRef}: ${f.context}`),
    },
  ];

  return {
    tiers,
    totalFindings: tiers.reduce((n, t) => n + t.errors.length, 0),
    prefixWarnings: checkImportPrefixes(xml),
  };
}
