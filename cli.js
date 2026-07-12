#!/usr/bin/env node

/**
 * CLI tool for converting BPMN files to DEXPI XML
 * Usage: node cli.js [--strict] input.bpmn [output.xml]
 * Or: npm run transform input.bpmn [output.xml]
 */

import { readFileSync, writeFileSync } from 'fs';
import { JSDOM } from 'jsdom';

// Set up DOM globals for Node.js environment
const dom = new JSDOM('<!DOCTYPE html>');
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.Document = dom.window.Document;
global.Element = dom.window.Element;

// Defer transformer import until after DOM globals are installed (the
// transformer module references DOMParser at evaluation time on some paths).
const { transformer, formatFailures } = await import('./src/transformer/BpmnToDexpiTransformer.ts');
const { generateProfileFromDexpiXml } = await import('./src/transformer/DexpiProfileGenerator.ts');
const { DexpiProcessClassRegistry } = await import('./src/transformer/DexpiProcessClassRegistry.ts');
const { validateDexpiXml } = await import('./src/transformer/validateDexpiXml.ts');
const { validateDexpiOutputXsd } = await import('./src/transformer/DexpiOutputValidator.ts');

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
bpmn2dexpi - BPMN to DEXPI XML Transformer

Usage:
  node cli.js [flags] <input.bpmn> [output.xml]
  node cli.js --validate <dexpi.xml> [--profile FILE]...
  npm run transform <input.bpmn> [output.xml]

Arguments:
  input.bpmn   Path to input BPMN file (required)
  output.xml   Path to output DEXPI XML file (optional, prints to stdout if not provided)

Flags:
  --strict        Enable Mode 2 validation: layer DEXPI 2.0 metamodel
                  property-name fidelity checks on top of XSD validation.
                  The output file is always produced regardless of strict-
                  mode findings (DEXPI 2.0's permissive philosophy: any
                  XSD-valid output is exchangeable). When --strict is set
                  and the validator finds violations, the CLI exits
                  non-zero so scripts can detect fidelity failures while
                  still keeping the deliverable.

  --profile FILE  Load a DEXPI Profile (project-specific extension schema)
                  into the registry. Profile classes become recognized
                  dexpiType targets, and Profile properties are accepted
                  by --strict validation. May be repeated to load multiple
                  profiles in one run. Same-name class redeclarations
                  across loaded sources merge additively into the active
                  vocabulary; each merge is printed to stderr as a non-
                  blocking warning so unintended collisions (e.g. typoing
                  a standard class name) surface during the run.

  --validate      Validate an EXISTING DEXPI 2.0 Process XML file (no
                  transformation; the positional argument is the DEXPI
                  document, not BPMN). Runs official-XSD validation
                  (xmllint; structural fallback if unavailable) plus the
                  five information-model fidelity dimensions: property
                  names + kinds, data types (including enumeration/unit
                  references), reference target classes, cardinality, and
                  class existence. The XSD covers any DEXPI 2.0 file; the
                  fidelity dimensions cover the bundled Process + Core
                  models plus any --profile files — documents written
                  against other DEXPI 2.0 models (e.g. the plant/P&ID
                  model) are flagged as out of the loaded vocabulary.
                  Exit codes: 0 = XSD-valid and no fidelity findings;
                  1 = XSD-invalid or error; 2 = XSD-valid with findings.

  --generate-profile FILE
                  After transforming, emit a DEXPI Profile XML to FILE
                  declaring every property name that did not resolve
                  through the loaded schema. Output is deterministic
                  (sorted, no timestamps) so generated profiles are safe
                  to commit to source control. Loading the generated
                  Profile back via --profile closes the strict-mode gap
                  on the same model. Independent of --strict; can be used
                  to discover gaps without enforcing them.

Examples:
  node cli.js process.bpmn                       # Print DEXPI XML to console
  node cli.js process.bpmn output.xml            # Save DEXPI XML to file
  node cli.js --strict process.bpmn output.xml   # Strict-mode validation
  node cli.js --strict --profile examples/profiles/sample-extension.xml
                              process.bpmn output.xml  # With Profile loaded
  node cli.js --generate-profile profile.xml process.bpmn output.xml
                                                 # Generate Profile + DEXPI
  node cli.js --validate output.xml              # Validate an existing DEXPI file
  node cli.js --validate output.xml --profile examples/profiles/tep-generated.xml
                                                 # Validate against loaded Profile
  npm run transform process.bpmn output.xml      # Using npm script

From Python:
  import subprocess
  result = subprocess.run(['node', 'cli.js', 'input.bpmn'], capture_output=True, text=True)
  dexpi_xml = result.stdout
`);
  process.exit(0);
}

const strict = args.includes('--strict');
const validateMode = args.includes('--validate');

// Parse value-bearing flags (--profile FILE, --generate-profile FILE) and
// positional args. Walk left-to-right so the file argument that follows
// each flag is unambiguous regardless of where it sits relative to other
// flags.
const profilePaths = [];
let generateProfilePath = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--profile') {
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
      console.error('✗ Error: --profile requires a path argument');
      process.exit(1);
    }
    profilePaths.push(args[++i]);
    continue;
  }
  if (a === '--generate-profile') {
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
      console.error('✗ Error: --generate-profile requires an output path argument');
      process.exit(1);
    }
    generateProfilePath = args[++i];
    continue;
  }
  if (a.startsWith('--')) continue; // already-handled flags (--strict, --help)
  positional.push(a);
}
const inputPath = positional[0];
const outputPath = positional[1];

if (!inputPath) {
  console.error('✗ Error: input file required');
  process.exit(1);
}

// ── --validate: fidelity-check an EXISTING DEXPI 2.0 XML document ─────────
// No transformation happens; the input is the DEXPI file itself. The same
// registry sources and the same five validators as strict mode run against
// it, so findings read identically to --strict findings on transformer
// output.
async function validateMain() {
  try {
    const dexpiXml = readFileSync(inputPath, 'utf-8');
    const sources = [
      { name: 'Process.xml', xml: readFileSync('dexpi-schema-files/Process.xml', 'utf-8') },
      { name: 'Core.xml', xml: readFileSync('dexpi-schema-files/Core.xml', 'utf-8') },
      ...profilePaths.map(p => ({
        name: p.split('/').pop() || p,
        xml: readFileSync(p, 'utf-8'),
      })),
    ];
    const registry = DexpiProcessClassRegistry.fromXmlSources(sources, {
      strictSupertypes: true,
    });

    // 1) Official XSD (xmllint in Node; structural fallback otherwise).
    const xsd = await validateDexpiOutputXsd(dexpiXml, 'dexpi-schema-files/DEXPI_XML_Schema.xsd');
    if (xsd.valid) {
      console.error(`✓ ${xsd.mode === 'xsd' ? 'XSD validation' : 'Structural check (xmllint unavailable)'}: ${inputPath} passes`);
    } else {
      console.error(`✗ ${xsd.mode === 'xsd' ? 'XSD validation' : 'Structural check'}: ${xsd.errors.length} error(s):`);
      for (const e of xsd.errors.slice(0, 20)) console.error(`  ✗ ${e}`);
      if (xsd.errors.length > 20) console.error(`  … and ${xsd.errors.length - 20} more`);
    }

    // 2) Five information-model fidelity dimensions.
    const result = validateDexpiXml(dexpiXml, registry, inputPath);
    for (const w of result.prefixWarnings) console.error(`⚠ ${w}`);
    for (const { tier, errors } of result.tiers) {
      if (errors.length === 0) {
        console.error(`✓ ${tier}: no findings`);
        continue;
      }
      console.error(`⚠ ${tier}: ${errors.length} finding(s):`);
      const counts = new Map();
      for (const e of errors) counts.set(e, (counts.get(e) ?? 0) + 1);
      for (const [msg, n] of counts) console.error(`  ✗ ${msg}${n > 1 ? `  (×${n})` : ''}`);
    }

    if (!xsd.valid) process.exit(1);
    if (result.totalFindings > 0) {
      console.error(
        `\n${result.totalFindings} fidelity finding(s). Vocabulary gaps can be ` +
        `captured with a Profile (see --generate-profile) and closed by ` +
        `re-validating with --profile.`,
      );
      process.exit(2);
    }
    console.error('\n✓ All five fidelity dimensions clean.');
    process.exit(0);
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
    process.exit(1);
  }
}

async function main() {
  try {
    // Read BPMN file
    const bpmnXml = readFileSync(inputPath, 'utf-8');

    // Load DEXPI Profile extensions, if any. Each profile XML is read off
    // disk once; the registry's unresolved-supertype + divergent-declaration
    // checks run inside transform() and throw with clear, actionable
    // messages. Same-name additive merges produce non-blocking warnings
    // that the transformer pipes through its logger (surfaced on stderr
    // by the warnings-printing block further down).
    const profileXmls = profilePaths.map(p => ({
      name: p.split('/').pop() || p,
      xml: readFileSync(p, 'utf-8'),
    }));

    // Transform to DEXPI. strict + profileXmls flow into transform()'s
    // registry construction; profile-loading errors (divergent declarations / unresolved
    // supertype) throw and are caught below.
    const dexpiXml = await transformer.transform(bpmnXml, { strict, profileXmls });

    if (outputPath) {
      // Write to file — always produced, even when strict-mode validation finds issues.
      writeFileSync(outputPath, dexpiXml, 'utf-8');
      console.error(`✓ Successfully transformed ${inputPath} → ${outputPath}`);
    } else {
      // Print to stdout
      console.log(dexpiXml);
    }

    // --generate-profile: walk the just-produced DEXPI XML, identify
    // unresolved (class, property) pairs, and emit a Profile XML that
    // closes those gaps. Independent of --strict — useful for discovering
    // gaps without enforcing them. Loaded Profiles are part of the
    // registry the generator queries, so the generator's output only
    // contains gaps that even the loaded Profiles don't cover.
    if (generateProfilePath) {
      const sources = [
        { name: 'Process.xml', xml: readFileSync('dexpi-schema-files/Process.xml', 'utf-8') },
        { name: 'Core.xml', xml: readFileSync('dexpi-schema-files/Core.xml', 'utf-8') },
        ...profileXmls,
      ];
      const reg = DexpiProcessClassRegistry.fromXmlSources(sources);
      const result = generateProfileFromDexpiXml(dexpiXml, reg, { bpmnXml });
      writeFileSync(generateProfilePath, result.xml, 'utf-8');
      console.error(
        `✓ Generated DEXPI Profile → ${generateProfilePath}  ` +
        `(${result.classCount} class${result.classCount === 1 ? '' : 'es'}, ` +
        `${result.declarations} declaration${result.declarations === 1 ? '' : 's'}, ` +
        `converged in ${result.iterationsUsed} pass${result.iterationsUsed === 1 ? '' : 'es'})`
      );
    }

    // Strict-mode validation: surface findings across ALL five tiers
    // (property-name + kind, data-type, reference target-class,
    // cardinality, class-existence) and exit non-zero if any tier
    // reports violations. Earlier this block only read
    // lastPropertyNameValidation, silently dropping the other four
    // tiers — the UI surfaces all five, the CLI now matches.
    if (strict) {
      const tierResults = [
        { tier: 'property-name + kind',  result: transformer.lastPropertyNameValidation },
        { tier: 'data-type',             result: transformer.lastDataTypeValidation },
        { tier: 'reference target-class',result: transformer.lastReferenceValidation },
        { tier: 'cardinality',           result: transformer.lastCardinalityValidation },
        { tier: 'class existence',       result: transformer.lastClassExistenceValidation },
      ];
      let totalViolations = 0;
      for (const { tier, result } of tierResults) {
        if (!result || result.valid) continue;
        const errs = result.errors;
        totalViolations += errs.length;
        console.error(
          `⚠ Strict-mode ${tier} check found ${errs.length} violation(s):`
        );
        // Group identical violations for compact display.
        const counts = new Map();
        for (const e of errs) counts.set(e, (counts.get(e) ?? 0) + 1);
        for (const [msg, n] of counts) {
          console.error(`  ✗ ${msg}${n > 1 ? `  (×${n})` : ''}`);
        }
      }
      if (totalViolations > 0) {
        console.error(
          '\n(Output file was still written. DEXPI 2.0 permissive philosophy: ' +
          'any XSD-valid output is exchangeable.)'
        );
        // Reference formatFailures so the import isn't dead — keeps it
        // tree-shakable but available for future richer rendering.
        void formatFailures;
        process.exit(2);
      }
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

if (validateMode) {
  validateMain();
} else {
  main();
}
