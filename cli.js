#!/usr/bin/env node

/**
 * bpmn2dexpi CLI
 * Usage:
 *   node --import tsx cli.js <input.bpmn> [output.xml]           BPMN → DEXPI
 *   node --import tsx cli.js --reverse <input.xml> [output.bpmn] DEXPI → BPMN
 */

import { readFileSync, writeFileSync } from 'fs';
import { JSDOM } from 'jsdom';

// DOM polyfill — must run before any transformer is imported/instantiated
const dom = new JSDOM('<!DOCTYPE html>');
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.Document = dom.window.Document;
global.Element = dom.window.Element;

// Static imports — class definitions only, no instantiation at module level issue
// because BpmnToDexpiTransformer exports `transformer` (a singleton instance).
// We lazy-import to avoid running that singleton constructor before polyfills are set.
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
bpmn2dexpi - BPMN ↔ DEXPI XML Transformer

Usage:
  node --import tsx cli.js <input.bpmn> [output.xml]           BPMN → DEXPI (default)
  node --import tsx cli.js --reverse <input.xml> [output.bpmn] DEXPI → BPMN

Examples:
  node --import tsx cli.js process.bpmn output.xml
  node --import tsx cli.js --reverse process.xml output.bpmn
  npm run transform process.bpmn output.xml
  npm run transform:reverse process.xml output.bpmn
`);
  process.exit(0);
}

const isReverse = args[0] === '--reverse';
const inputPath = isReverse ? args[1] : args[0];
const outputPath = isReverse ? args[2] : args[1];

if (!inputPath) {
  console.error('✗ Error: input file required');
  process.exit(1);
}

async function main() {
  try {
    const inputXml = readFileSync(inputPath, 'utf-8');
    let outputXml;

    if (isReverse) {
      const { DexpiToBpmnTransformer } = await import('./src/transformer/DexpiToBpmnTransformer.ts');
      const t = new DexpiToBpmnTransformer();
      outputXml = t.transform(inputXml);
    } else {
      const { transformer } = await import('./src/transformer/BpmnToDexpiTransformer.ts');
      outputXml = await transformer.transform(inputXml);
    }

    if (outputPath) {
      writeFileSync(outputPath, outputXml, 'utf-8');
      console.error(`✓ ${isReverse ? 'DEXPI → BPMN' : 'BPMN → DEXPI'}: ${inputPath} → ${outputPath}`);
    } else {
      process.stdout.write(outputXml);
    }

    process.exit(0);
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

main();
