#!/usr/bin/env node
/**
 * CLI: DEXPI → BPMN with ELK layout.
 *
 * Usage:
 *   node scripts/import-dexpi.mjs <input.dexpi.xml> <output.bpmn> [--skip-elk]
 *
 * Reads <input.dexpi.xml>, runs DexpiToBpmnTransformer to produce BPMN
 * with logical content + an initial heuristic layout, then runs ELK to
 * override the layout (unless --skip-elk is given).
 */

import { readFileSync, writeFileSync } from 'fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html>');
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
  Document: dom.window.Document,
  Element: dom.window.Element,
});

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/import-dexpi.mjs <input.dexpi.xml> <output.bpmn> [--skip-elk]');
  process.exit(1);
}

const [inputPath, outputPath] = args;
const skipElk = args.includes('--skip-elk');

const { importDexpiWithElk } = await import('../src/transformer/DexpiImportWithElk.ts');

const inputXml = readFileSync(inputPath, 'utf-8');
console.log(`Read ${inputPath} (${inputXml.length} bytes, skipElk=${skipElk})`);

const startMs = Date.now();
const outputXml = await importDexpiWithElk(inputXml, { skipElk });
const elapsedMs = Date.now() - startMs;

writeFileSync(outputPath, outputXml);
console.log(`Wrote ${outputPath} (${outputXml.length} bytes) in ${elapsedMs}ms`);
