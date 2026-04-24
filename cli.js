#!/usr/bin/env node

/**
 * CLI tool for converting BPMN files to DEXPI XML
 * Usage: node cli.js input.bpmn [output.xml]
 * Or: npm run transform input.bpmn [output.xml]
 */

import { readFileSync, writeFileSync } from 'fs';
import { transformer } from './src/transformer/BpmnToDexpiTransformer.ts';
import { DexpiToBpmnTransformer } from './src/transformer/DexpiToBpmnTransformer.ts';
import { JSDOM } from 'jsdom';

// Set up DOM globals for Node.js environment
const dom = new JSDOM('<!DOCTYPE html>');
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.Document = dom.window.Document;
global.Element = dom.window.Element;

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
bpmn2dexpi - BPMN ↔ DEXPI Transformer

Usage:
  node cli.js <input.bpmn> [output.xml]           # BPMN → DEXPI
  node cli.js --reverse <input.xml> [output.bpmn] # DEXPI → BPMN

Arguments:
  --reverse    Import DEXPI XML and generate BPMN
  input        Path to input file (required)
  output       Path to output file (optional, prints to stdout if not provided)

Examples:
  node cli.js process.bpmn output.xml             # BPMN → DEXPI XML
  node cli.js --reverse process.xml output.bpmn   # DEXPI → BPMN
  npm run transform process.bpmn output.xml

From Python:
  import subprocess
  result = subprocess.run(['node', 'cli.js', 'input.bpmn'], capture_output=True, text=True)
  dexpi_xml = result.stdout
`);
  process.exit(0);
}


const isReverse = args[0] === '--reverse';
const inputPath2 = isReverse ? args[1] : args[0];
const outputPath2 = isReverse ? args[2] : args[1];

async function main() {
  try {
    const inputXml = readFileSync(inputPath2, 'utf-8');
    let outputXml;

    if (isReverse) {
      // DEXPI → BPMN
      const t = new DexpiToBpmnTransformer();
      outputXml = t.transform(inputXml);
    } else {
      // BPMN → DEXPI
      outputXml = await transformer.transform(inputXml);
    }

    if (outputPath2) {
      writeFileSync(outputPath2, outputXml, 'utf-8');
      const arrow = isReverse ? 'DEXPI → BPMN' : 'BPMN → DEXPI';
      console.error(`✓ ${arrow}: ${inputPath2} → ${outputPath2}`);
    } else {
      console.log(outputXml);
    }

    process.exit(0);
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

main();

