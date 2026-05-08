/**
 * DexpiClassExistenceValidator
 *
 * Tier-6 validation: every emitted <Object type="..."> resolves to a class
 * known to the active DEXPI registry (Process + Core + any loaded Profiles).
 *
 * After the resolveStepType fallback chain ('dexpi-validated' → 'custom-supertype'
 * → 'unvalidated') a clean transformer run cannot emit an unknown class:
 *   • dexpi-validated  → the class is in the registry by construction.
 *   • custom-supertype → the user supplied a known supertype; the paired Profile
 *                        declares the custom class (registry includes Profiles).
 *   • unvalidated      → falls back to ProcessStep, which is in the registry.
 *
 * Tier 6 therefore acts as a post-condition / regression guard. If it fires it
 * means either:
 *   (a) someone added an emission path that bypasses resolveStepType, or
 *   (b) a Profile required to declare a custom class was not loaded into the
 *       registry at validation time (caller bug, not a transformer bug).
 *
 * Pure registry lookup. No string similarity, no fuzzy matching, no fallback
 * suggestions (R1-C3: no heuristics in the methodology).
 */

import type { DexpiProcessClassRegistry } from './DexpiProcessClassRegistry';

export interface ClassExistenceFailure {
  source: string;
  /** Bare class name parsed from the `type` attribute. */
  className: string;
  /** The full type reference as written in the XML (e.g. "Process/Process.X"). */
  typeRef: string;
  /** ID of the offending Object (or '(no id)'). */
  objectId: string;
  context: string;
}

export function formatClassExistenceFailures(failures: ClassExistenceFailure[]): string {
  if (failures.length === 0) return '';
  const grouped = new Map<string, ClassExistenceFailure[]>();
  for (const f of failures) {
    const key = `${f.source} :: ${f.className}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(f);
  }
  const lines: string[] = [
    `${failures.length} unknown-class reference(s) (${grouped.size} unique):`,
  ];
  for (const [key, items] of grouped) {
    lines.push(`  ✗ ${key}  (×${items.length})`);
    lines.push(`      e.g. ${items[0].context}`);
  }
  return lines.join('\n');
}

/**
 * Walk every <Object> in the emitted DEXPI XML and flag any whose declared
 * type is not present in the registry.
 */
export function validateEmittedDexpiClassExistence(
  xml: string,
  source: string,
  registry: DexpiProcessClassRegistry,
): ClassExistenceFailure[] {
  const failures: ClassExistenceFailure[] = [];
  // Empty registry means nothing was loaded — caller bug; don't pretend to validate.
  if (registry.size === 0) return failures;

  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  for (const obj of Array.from(doc.getElementsByTagName('Object'))) {
    const typeRef = obj.getAttribute('type');
    if (!typeRef) continue;
    const className = bareClassName(typeRef);
    if (registry.isValidClass(className)) continue;

    const objectId = obj.getAttribute('id') ?? '(no id)';
    failures.push({
      source,
      className,
      typeRef,
      objectId,
      context: `<Object id="${objectId}" type="${typeRef}"> references class "${className}" ` +
        `which is not declared in the active DEXPI registry (Process + Core + loaded Profiles).`,
    });
  }

  return failures;
}

function bareClassName(typeRef: string): string {
  let s = typeRef;
  const lastSlash = s.lastIndexOf('/');
  if (lastSlash >= 0) s = s.slice(lastSlash + 1);
  const lastDot = s.lastIndexOf('.');
  if (lastDot >= 0) s = s.slice(lastDot + 1);
  return s;
}
