#!/usr/bin/env node

/**
 * CLI tool for converting BPMN files to DEXPI XML
 * Usage: node cli.js [--strict] input.bpmn [output.xml]
 * Or: npm run transform input.bpmn [output.xml]
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative, basename } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

// Bundled DEXPI model files ship next to this script (repo root and npm
// package root alike). Resolve them relative to the module, not the
// working directory, so a globally-installed `bpmn2dexpi` works from any
// cwd.
const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'dexpi-schema-files');

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
const {
  DEFAULT_DEXPI_VERSION, DEXPI_VERSIONS, DEXPI_XSD_FILENAME,
  dexpiModelRelativePath, detectDexpiVersion, isDexpiVersion,
} = await import('./src/transformer/dexpiVersions.ts');

/** Bundled model files of one DEXPI release, as registry sources. */
const bundledModels = (version, models) => models.map(model => ({
  name: `${model}.xml`,
  xml: readFileSync(join(SCHEMA_DIR, dexpiModelRelativePath(version, model)), 'utf-8'),
}));

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
bpmn2dexpi - BPMN to DEXPI XML Transformer

Usage:
  node cli.js [flags] <input.bpmn> [output.xml]
  node cli.js --validate <dexpi.xml> [--profile FILE]... [--dexpi-version V]
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

  --validate      Validate an EXISTING DEXPI 2.0 XML document — Process
                  (BFD/PFD) or Plant (P&ID) — from any tool (no
                  transformation; the positional argument is the DEXPI
                  document, not BPMN). Runs official-XSD validation
                  (xmllint; structural fallback if unavailable) plus the
                  five information-model fidelity dimensions: property
                  names + kinds, data types (including enumeration/unit
                  references), reference target classes, cardinality, and
                  class existence. The fidelity dimensions run against the
                  complete published DEXPI 2.0 vocabulary (the bundled
                  Process, Plant, and Core models) plus any --profile
                  files; documents importing models outside that
                  vocabulary are flagged as such rather than misreported.
                  Exit codes: 0 = XSD-valid and no fidelity findings;
                  1 = XSD-invalid or error; 2 = XSD-valid with findings.

  --generate-profile FILE
                  Write the export's DEXPI Profile to FILE instead of the
                  default <output basename>.profile.xml. The file is
                  always written when this flag is given, even when the
                  model needs no profile (an empty Profile then).

  --no-profile    Do not generate the export's profile: no profile file,
                  no <Import prefix="Profile"> in the document.

  --dexpi-version VERSION
                  DEXPI release to write: 2.0.0 (default) or 2.0.1. The
                  export loads that release's bundled models and imports
                  them (https://data.dexpi.org/models/VERSION/…); the shape
                  follows the models — in 2.0.1 MoleFractions / RatioUnit,
                  state types composed under MaterialState.State and the
                  Composition under MaterialStateType, MeasuredVariable as
                  a MeasuredQuantity literal. With --validate: the release
                  to validate against when the document's imports do not
                  say (they normally do, and are honoured).

The export is self-describing by default: after transforming, the CLI
generates the document's DEXPI Profile — every class and property the
model uses that the DEXPI 2.0 vocabulary (plus any --profile FILE) does
not declare, as <ClassExtension> declarations. When there is at least
one declaration, the profile is written next to the output as
<output basename>.profile.xml and the document declares it as
<Import prefix="Profile" source="…"/> (path relative to the output), so
consumers that resolve imports see the declarations. When there is
nothing to declare, no profile file is written and nothing is imported.
Output is deterministic (sorted, no timestamps) so generated profiles
are safe to commit to source control. Loading the generated Profile
back via --profile closes the strict-mode gap on the same model.
When the document goes to stdout there is no output file to sit next
to, so no profile is written unless --generate-profile FILE names one.

Examples:
  node cli.js process.bpmn                       # Print DEXPI XML to console
  node cli.js process.bpmn output.xml            # Save DEXPI XML to file
  node cli.js --strict process.bpmn output.xml   # Strict-mode validation
  node cli.js --strict --profile examples/profiles/sample-extension.xml
                              process.bpmn output.xml  # With Profile loaded
  node cli.js process.bpmn output.xml            # Also writes output.profile.xml
                                                 #   when the model needs one
  node cli.js --generate-profile profile.xml process.bpmn output.xml
                                                 # Profile under a chosen name
  node cli.js --no-profile process.bpmn output.xml
                                                 # DEXPI only, no profile
  node cli.js --validate output.xml              # Validate an existing DEXPI file
                                                 #   (Process or Plant/P&ID)
  node cli.js --validate output.xml --profile examples/profiles/tep-generated.xml
                                                 # Validate against loaded Profile
  node cli.js --dexpi-version 2.0.1 process.bpmn output.xml
                                                 # Write a DEXPI 2.0.1 document
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
const noProfile = args.includes('--no-profile');

// Parse value-bearing flags (--profile FILE, --generate-profile FILE) and
// positional args. Walk left-to-right so the file argument that follows
// each flag is unambiguous regardless of where it sits relative to other
// flags.
const profilePaths = [];
let generateProfilePath = null;
let dexpiVersionArg = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dexpi-version') {
    const v = args[i + 1];
    if (!v || !isDexpiVersion(v)) {
      console.error(`✗ Error: --dexpi-version requires one of ${DEXPI_VERSIONS.join(', ')} (got "${v ?? ''}")`);
      process.exit(1);
    }
    dexpiVersionArg = v;
    i++;
    continue;
  }
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
if (noProfile && generateProfilePath) {
  console.error('✗ Error: --no-profile and --generate-profile FILE exclude each other');
  process.exit(1);
}

// Where the export's profile goes: the path named by --generate-profile,
// else next to the output as <output basename>.profile.xml (out.xml →
// out.profile.xml). With no output file (stdout) there is no sibling
// location, so the profile is only written when a path is named.
const profilePath = generateProfilePath
  ?? (outputPath ? outputPath.replace(/\.xml$/i, '') + '.profile.xml' : null);

// ── --validate: fidelity-check an EXISTING DEXPI 2.0 XML document ─────────
// No transformation happens; the input is the DEXPI file itself. The same
// five validators as strict mode run against it (identical finding strings),
// but over the complete published DEXPI 2.0 vocabulary: unlike the transform
// path (which authors Process documents and loads Process + Core only),
// validation also loads the Plant model so P&ID documents check cleanly.
// The three models share one grammar and have zero class-name collisions.
async function validateMain() {
  try {
    const dexpiXml = readFileSync(inputPath, 'utf-8');
    // The release to validate against: the one the document imports
    // (https://data.dexpi.org/models/<version>/…), else --dexpi-version,
    // else the default. A document importing a release this build does not
    // bundle is validated against the fallback and says so.
    const detected = detectDexpiVersion(dexpiXml);
    const version = detected.version ?? dexpiVersionArg ?? DEFAULT_DEXPI_VERSION;
    if (detected.version) {
      console.error(`ℹ Document imports the DEXPI ${version} models; validating against the ${version} vocabulary.`);
    } else if (detected.declared) {
      console.error(
        `⚠ Document imports DEXPI ${detected.declared} models, which this build does not bundle ` +
        `(known: ${DEXPI_VERSIONS.join(', ')}); validating against ${version}.`,
      );
    } else {
      console.error(`ℹ Document imports no versioned DEXPI model; validating against ${version}.`);
    }
    const sources = [
      ...bundledModels(version, ['Process', 'Plant', 'Core']),
      ...profilePaths.map(p => ({
        name: p.split('/').pop() || p,
        xml: readFileSync(p, 'utf-8'),
      })),
    ];
    const registry = DexpiProcessClassRegistry.fromXmlSources(sources, {
      strictSupertypes: true,
    });

    // 1) Official XSD (xmllint in Node; structural fallback otherwise).
    // One XML Schema for every bundled release (2.0.1 ships the same XSD).
    const xsd = await validateDexpiOutputXsd(dexpiXml, join(SCHEMA_DIR, DEXPI_XSD_FILENAME));
    if (xsd.valid) {
      console.error(`✓ ${xsd.mode === 'xsd' ? 'XSD validation' : 'Structural check (xmllint unavailable)'}: ${inputPath} passes`);
    } else {
      console.error(`✗ ${xsd.mode === 'xsd' ? 'XSD validation' : 'Structural check'}: ${xsd.errors.length} error(s):`);
      for (const e of xsd.errors.slice(0, 20)) console.error(`  ✗ ${e}`);
      if (xsd.errors.length > 20) console.error(`  … and ${xsd.errors.length - 20} more`);
    }

    // 2) Five information-model fidelity dimensions.
    const result = validateDexpiXml(dexpiXml, registry, inputPath, profilePaths);
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

    // Every profile the document is written against is declared as an
    // <Import> after Core and Process: the ones loaded with --profile and
    // the one --generate-profile is about to write. Sources are paths
    // relative to the output file (or to the working directory when the
    // document goes to stdout), so the profile travels as a sibling file.
    const importBase = outputPath ? dirname(outputPath) : process.cwd();
    const importSource = (p) => {
      const rel = relative(importBase, p).split('\\').join('/');
      // Inside the output's folder tree: import by that relative path.
      // Elsewhere: import by file name and say so — the document and its
      // profile are meant to travel together, and a path climbing out of
      // the tree would not survive the move.
      if (rel && !rel.startsWith('../')) return rel;
      console.error(
        `ℹ Profile ${p} is not under the output folder; the document imports it as ` +
        `"${basename(p)}" — keep the two files together.`,
      );
      return basename(p);
    };
    const profileImports = profilePaths.map(p => ({
      prefix: basename(p).replace(/\.xml$/i, ''),
      source: importSource(p),
    }));

    // The export's own profile. transform() runs the generator on the
    // emitted document (plus the BPMN's extension elements) and, when there
    // is at least one declaration, imports the profile as
    // <Import prefix="Profile" source="…"/>. Loaded Profiles are part of the
    // registry the generator queries, so the generated profile only holds
    // gaps that even the loaded Profiles don't cover. Independent of
    // --strict. Skipped with --no-profile, and when the document goes to
    // stdout with no --generate-profile FILE (no file to import).
    const generateProfile = !noProfile && profilePath
      ? { prefix: 'Profile', source: importSource(profilePath) }
      : undefined;

    // Transform to DEXPI. strict + profileXmls flow into transform()'s
    // registry construction; profile-loading errors (divergent declarations / unresolved
    // supertype) throw and are caught below.
    const dexpiVersion = dexpiVersionArg ?? DEFAULT_DEXPI_VERSION;
    const dexpiXml = await transformer.transform(bpmnXml, {
      strict, profileXmls, profileImports, generateProfile, dexpiVersion,
    });

    if (outputPath) {
      // Write to file — always produced, even when strict-mode validation finds issues.
      writeFileSync(outputPath, dexpiXml, 'utf-8');
      console.error(`✓ Successfully transformed ${inputPath} → ${outputPath} (DEXPI ${dexpiVersion})`);
    } else {
      // Print to stdout
      console.log(dexpiXml);
    }

    // Write the profile next to the output when the document imports it
    // (declarations > 0). An explicit --generate-profile FILE is written
    // regardless, so a script that asked for the file always gets one.
    const generated = transformer.lastGeneratedProfile;
    if (generated && (generated.declarations > 0 || generateProfilePath)) {
      writeFileSync(profilePath, generated.xml, 'utf-8');
      console.error(
        generated.declarations > 0
          ? `✓ DEXPI Profile → ${profilePath}  ` +
            `(${generated.classCount} class${generated.classCount === 1 ? '' : 'es'}, ` +
            `${generated.declarations} declaration${generated.declarations === 1 ? '' : 's'}, ` +
            `converged in ${generated.iterationsUsed} pass${generated.iterationsUsed === 1 ? '' : 'es'}); ` +
            `the document imports it — keep the two files together.`
          : `✓ Empty DEXPI Profile → ${profilePath}  (the model needs no profile; nothing imported)`
      );
    } else if (generated) {
      console.error('ℹ The model needs no profile: nothing beyond the DEXPI 2.0 vocabulary is used.');
    } else if (!noProfile && !outputPath) {
      // stdout mode without a profile path: say when the document would
      // have needed one, so the extension properties don't travel silently
      // without their declarations.
      const sources = [
        ...bundledModels(dexpiVersion, ['Process', 'Core']),
        ...profileXmls,
      ];
      const reg = DexpiProcessClassRegistry.fromXmlSources(sources);
      const probe = generateProfileFromDexpiXml(dexpiXml, reg, { bpmnXml });
      if (probe.declarations > 0) {
        console.error(
          `ℹ The model uses ${probe.declarations} extension propert${probe.declarations === 1 ? 'y' : 'ies'} ` +
          `on ${probe.classCount} class${probe.classCount === 1 ? '' : 'es'} that the document (stdout) does not ` +
          `declare. Write it to a file to get <output basename>.profile.xml next to it, or pass ` +
          `--generate-profile FILE.`,
        );
      }
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
