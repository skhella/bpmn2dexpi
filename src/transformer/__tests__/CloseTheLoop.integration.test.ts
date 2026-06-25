/**
 * Close-the-loop integration test.
 *
 * Verifies the end-to-end strict-mode + Profile-generator + reload cycle:
 *
 *   1. Run TEP through the transformer with strict=true. Capture the
 *      property-name + kind findings (the only non-clean tier on TEP today;
 *      the four others are already clean — see StrictModeAllTiers).
 *   2. Feed the same TEP through the Profile generator, producing a Profile
 *      XML that declares every (class, property) pair the validator flagged.
 *   3. Re-run the transformer against the same TEP, this time loading the
 *      generated Profile via the `profileXmls` option.
 *   4. Assert all five tiers are clean — the Profile fully closes the gap.
 *
 * This pins the contract surfaced by the audit verification on 2026-05-09:
 * `profileXmls` (NOT `extensions`) is the option name; the registry / strict
 * validators consume it correctly; the Profile generator's output, when
 * round-tripped through that path, is sufficient to clear the strict-mode
 * findings without further hand-editing.
 *
 * Regression guard for any future change that:
 *   - Renames the `profileXmls` option (would silently break the close-the-
 *     loop story even though the test fixtures might still pass with the
 *     old name).
 *   - Stops loading Profile classes into the strict validator's registry
 *     (silent regression; the Profile would generate but not get consulted).
 *   - Generates an incomplete Profile (e.g. drops a property kind during
 *     refactoring) — the residual would surface as remaining findings.
 *
 * Not asserting raw counts (149 today; could change as TEP fixture evolves)
 * — the contract is "baseline > 0 → re-run clean", which is robust to TEP
 * fixture updates that legitimately add or remove project-extension content.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html>');
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
  Document: dom.window.Document,
  Element: dom.window.Element,
});

import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';
import { DexpiProcessClassRegistry } from '../DexpiProcessClassRegistry';
import { generateProfileFromDexpiXml } from '../DexpiProfileGenerator';

const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');
const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');

describe('Strict mode close-the-loop — gen Profile → reload → re-validate clean', () => {
  it('TEP: 149-finding baseline → 29-decl Profile → all five tiers clean', { timeout: 30_000 }, async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');

    // ── Step 1: baseline strict run, no Profile loaded ─────────────────────
    const t1 = new BpmnToDexpiTransformer();
    const dexpiXml = await t1.transform(bpmn, {
      processXml: PROCESS_XML,
      coreXml: CORE_XML,
      strict: true,
    });

    // Sanity: all tiers must be populated (otherwise strict mode wasn't
    // actually enabled and the close-the-loop assertion below is vacuous).
    expect(t1.lastPropertyNameValidation, 'baseline strict mode did not run').toBeDefined();
    expect(t1.lastDataTypeValidation).toBeDefined();
    expect(t1.lastReferenceValidation).toBeDefined();
    expect(t1.lastCardinalityValidation).toBeDefined();
    expect(t1.lastClassExistenceValidation).toBeDefined();

    const baselineFindings = t1.lastPropertyNameValidation!.errors.length;
    expect(baselineFindings, 'TEP baseline should surface project-extension findings the Profile is meant to close').toBeGreaterThan(0);

    // The other four tiers must already be clean on TEP. If any of them
    // becomes non-clean, the Profile generator's current scope (vocabulary
    // gaps only) would be insufficient — surface it loudly here rather
    // than masking behind a sometimes-passing close-the-loop.
    expect(t1.lastDataTypeValidation!.valid, 'TEP data-type tier should be clean before close-the-loop').toBe(true);
    expect(t1.lastReferenceValidation!.valid, 'TEP reference target-class tier should be clean before close-the-loop').toBe(true);
    expect(t1.lastCardinalityValidation!.valid, 'TEP cardinality tier should be clean before close-the-loop').toBe(true);
    expect(t1.lastClassExistenceValidation!.valid, 'TEP class-existence tier should be clean before close-the-loop').toBe(true);

    // ── Step 2: generate Profile from the gaps ─────────────────────────────
    const baselineRegistry = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: PROCESS_XML },
      { name: 'Core.xml', xml: CORE_XML },
    ]);
    const profile = generateProfileFromDexpiXml(dexpiXml, baselineRegistry, { bpmnXml: bpmn });
    expect(profile.declarations, 'Profile must declare at least one property to be a meaningful close-the-loop subject').toBeGreaterThan(0);
    expect(profile.classCount).toBeGreaterThan(0);
    expect(profile.iterationsUsed).toBeGreaterThanOrEqual(1);

    // ── Step 3: re-validate WITH the generated Profile loaded ──────────────
    // Critical contract: the option key is `profileXmls`. Earlier audit
    // probes mistakenly used `extensions` — silently ignored, leaving the
    // residual findings count unchanged at 149. If a future refactor
    // renames this option, this assertion will catch it.
    const t2 = new BpmnToDexpiTransformer();
    const closed = await t2.transform(bpmn, {
      processXml: PROCESS_XML,
      coreXml: CORE_XML,
      strict: true,
      profileXmls: [{ name: 'GeneratedProfile.xml', xml: profile.xml }],
    });

    // ── Step 4: every tier must now be clean ───────────────────────────────
    const propertyResidual = t2.lastPropertyNameValidation?.errors ?? [];
    expect(
      t2.lastPropertyNameValidation?.valid,
      `Expected property-name tier to be clean after Profile reload. ` +
      `Baseline had ${baselineFindings} findings; Profile declared ${profile.declarations} ` +
      `properties across ${profile.classCount} classes; residual ${propertyResidual.length}. ` +
      `First 3 residuals: ${propertyResidual.slice(0, 3).join(' | ')}`,
    ).toBe(true);
    expect(t2.lastDataTypeValidation?.valid).toBe(true);
    expect(t2.lastReferenceValidation?.valid).toBe(true);
    expect(t2.lastCardinalityValidation?.valid).toBe(true);
    expect(t2.lastClassExistenceValidation?.valid).toBe(true);

    // The MoleFlow vocabulary gap closes via the extension: its custom per-hour
    // unit now resolves on DEXPI's own MoleFlowRateUnit (the quantity authored on
    // the measurement), value preserved — the paper's "extension closes the gap".
    expect(closed, 'MoleFlow resolves onto DEXPI MoleFlowRateUnit after the Profile').toMatch(
      /Core\/PhysicalQuantities\.MoleFlowRateUnit\.KilomolePerHour/,
    );
  });

  it('Profile generator output is deterministic — same input produces identical XML', { timeout: 30_000 }, async () => {
    // Determinism is documented as a generator contract (see the file's
    // module comment). Wire it up as a real test rather than relying on
    // the comment to be true. Two independent runs of the generator on the
    // same TEP must produce byte-identical Profile XML; if anything in the
    // pipeline introduces nondeterminism (Map iteration order, timestamps,
    // unsorted set serialisation), this test surfaces it.
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const t = new BpmnToDexpiTransformer();
    const dexpiXml = await t.transform(bpmn, {
      processXml: PROCESS_XML,
      coreXml: CORE_XML,
      strict: true,
    });
    const reg = DexpiProcessClassRegistry.fromXmlSources([
      { name: 'Process.xml', xml: PROCESS_XML },
      { name: 'Core.xml', xml: CORE_XML },
    ]);
    const a = generateProfileFromDexpiXml(dexpiXml, reg, { bpmnXml: bpmn });
    const b = generateProfileFromDexpiXml(dexpiXml, reg, { bpmnXml: bpmn });
    expect(b.xml).toEqual(a.xml);
    expect(b.declarations).toEqual(a.declarations);
    expect(b.classCount).toEqual(a.classCount);
  });
});
