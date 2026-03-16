#!/usr/bin/env node

/**
 * CLI tool for converting BPMN files to DEXPI XML
 * Usage: node cli.js input.bpmn [output.xml]
 * Or: npm run transform input.bpmn [output.xml]
 */

import { readFileSync, writeFileSync } from 'fs';
import { transformer } from './src/transformer/BpmnToDexpiTransformer.ts';
import { exportToNeo4j } from './src/utils/neo4jExporter.ts';
import { JSDOM } from 'jsdom';

// Set up DOM globals for Node.js environment
const dom = new JSDOM('<!DOCTYPE html>');
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.Document = dom.window.Document;
global.Element = dom.window.Element;

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
bpmn2dexpi - BPMN/DEXPI CLI Utilities

Usage:
  node cli.js <input.bpmn> [output.xml]
  npm run transform <input.bpmn> [output.xml]
  node cli.js neo4j-export <input.{bpmn|xml}> --uri <uri> --user <user> --password <password> [options]

Arguments:
  input.bpmn         Path to input BPMN file for transform mode
  output.xml         Path to output DEXPI XML file (optional, prints to stdout if not provided)

neo4j-export options:
  --uri <uri>                Neo4j URI (e.g., bolt://localhost:7687)
  --user <user>              Neo4j username
  --password <password>      Neo4j password
  --database <database>      Neo4j database (default: neo4j)
  --input-type <bpmn|dexpi>  Force input type (auto-detected by extension if omitted)
  --dexpi-out <path>         Save generated DEXPI XML when input is BPMN

Examples:
  node cli.js process.bpmn                  # Print DEXPI XML to console
  node cli.js process.bpmn output.xml       # Save DEXPI XML to file
  npm run transform process.bpmn output.xml # Using npm script
  node cli.js neo4j-export process.bpmn --uri bolt://localhost:7687 --user neo4j --password secret
  node cli.js neo4j-export process.xml --input-type dexpi --uri bolt://localhost:7687 --user neo4j --password secret

From Python:
  import subprocess
  result = subprocess.run(['node', 'cli.js', 'input.bpmn'], capture_output=True, text=True)
  dexpi_xml = result.stdout
`);
}

function parseOptions(optionArgs) {
  const options = {};
  for (let i = 0; i < optionArgs.length; i++) {
    const key = optionArgs[i];
    if (!key.startsWith('--')) {
      continue;
    }
    const value = optionArgs[i + 1];
    if (value === undefined || value.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = value;
    i += 1;
  }
  return options;
}

function detectInputType(inputPath) {
  const lower = inputPath.toLowerCase();
  if (lower.endsWith('.bpmn')) return 'bpmn';
  if (lower.endsWith('.xml')) return 'dexpi';
  return null;
}

async function runTransform(inputPath, outputPath) {
  // Read BPMN file
  const bpmnXml = readFileSync(inputPath, 'utf-8');

  // Transform to DEXPI
  const dexpiXml = await transformer.transform(bpmnXml);

  if (outputPath) {
    // Write to file
    writeFileSync(outputPath, dexpiXml, 'utf-8');
    console.error(`✓ Successfully transformed ${inputPath} -> ${outputPath}`);
  } else {
    // Print to stdout
    console.log(dexpiXml);
  }
}

async function runNeo4jExport(commandArgs) {
  if (commandArgs.length === 0) {
    throw new Error('neo4j-export requires an input file path');
  }

  const inputPath = commandArgs[0];
  const options = parseOptions(commandArgs.slice(1));

  const uri = options['--uri'];
  const user = options['--user'];
  const password = options['--password'];
  const database = options['--database'] || 'neo4j';
  const forcedType = options['--input-type'];
  const dexpiOutPath = options['--dexpi-out'];

  if (!uri || !user || !password) {
    throw new Error('neo4j-export requires --uri, --user, and --password');
  }

  const detected = detectInputType(inputPath);
  const inputType = forcedType || detected;
  if (inputType !== 'bpmn' && inputType !== 'dexpi') {
    throw new Error('Unable to determine input type. Use --input-type bpmn or --input-type dexpi');
  }

  const inputXml = readFileSync(inputPath, 'utf-8');
  let dexpiXml = inputXml;

  if (inputType === 'bpmn') {
    dexpiXml = await transformer.transform(inputXml);
    if (dexpiOutPath) {
      writeFileSync(dexpiOutPath, dexpiXml, 'utf-8');
      console.error(`✓ Saved transformed DEXPI XML to ${dexpiOutPath}`);
    }
  }

  const result = await exportToNeo4j(dexpiXml, {
    uri,
    user,
    password,
    database
  });

  if (!result.success) {
    throw new Error(result.message);
  }

  console.error(`✓ Neo4j export completed for ${inputPath}`);
  console.error(`✓ ${result.message}`);
}

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  printHelp();
  process.exit(0);
}

async function main() {
  try {
    if (args[0] === 'neo4j-export') {
      await runNeo4jExport(args.slice(1));
    } else {
      // Backward-compatible transform mode
      const inputPath = args[0];
      const outputPath = args[1];
      await runTransform(inputPath, outputPath);
    }

    process.exit(0);
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
