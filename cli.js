#!/usr/bin/env node

/**
 * CLI for the bpmn2dexpi project. Two modes:
 *   - default     : convert a BPMN file to DEXPI XML
 *                   node cli.js [--strict] input.bpmn [output.xml]
 *   - export-neo4j: push DEXPI graph data into a Neo4j database
 *                   node cli.js export-neo4j <input.bpmn|.xml> [flags]
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

const args = process.argv.slice(2);

// Subcommand dispatch. Anything else falls through to the historical
// BPMN → DEXPI XML flow so existing invocations keep working unchanged.
if (args[0] === 'export-neo4j') {
  await runExportNeo4j(args.slice(1));
  process.exit(0);
}

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
bpmn2dexpi - BPMN to DEXPI XML Transformer

Usage:
  node cli.js [flags] <input.bpmn> [output.xml]
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
  npm run transform process.bpmn output.xml      # Using npm script

Subcommands:
  export-neo4j <input> [flags]
                  Push DEXPI graph data into a Neo4j database (same
                  pipeline as the in-app "Export to Neo4j" button).
                  Input may be a BPMN file with dexpi:* extensions
                  (transformed first) or a DEXPI XML file (used as-is).
                  Run \`node cli.js export-neo4j --help\` for details.

From Python:
  import subprocess
  result = subprocess.run(['node', 'cli.js', 'input.bpmn'], capture_output=True, text=True)
  dexpi_xml = result.stdout
`);
  process.exit(0);
}

const strict = args.includes('--strict');

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

main();

/**
 * Push DEXPI graph data into a Neo4j database.
 *
 * Reuses the same parse → Cypher → HTTP pipeline that the React app's
 * "Export to Neo4j" button drives (`src/utils/neo4jExporter.ts`), so any
 * fix or schema change there flows into the CLI automatically.
 *
 * Input handling:
 *   - .bpmn / .xml extension auto-detected; override with --from bpmn|dexpi-xml
 *   - BPMN inputs go through the BpmnToDexpiTransformer first
 *   - DEXPI XML inputs are parsed directly
 *
 * Credentials:
 *   - Defaults from env (NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD / NEO4J_DATABASE)
 *   - CLI flags (--uri / --user / --password / --database) override
 *   - --database defaults to "neo4j" if neither env nor flag set
 */
async function runExportNeo4j(subArgs) {
  if (subArgs.length === 0 || subArgs.includes('--help') || subArgs.includes('-h')) {
    console.log(`
bpmn2dexpi export-neo4j - push DEXPI graph data into Neo4j

Usage:
  node cli.js export-neo4j <input> [flags]

Arguments:
  input           Path to a BPMN file (with dexpi:* extensions) OR a DEXPI XML
                  file. Detected by extension unless --from is given.

Flags:
  --from <kind>   Force input type: "bpmn" or "dexpi-xml". Overrides extension
                  detection.

  --uri <uri>     Neo4j URI. Bolt-style URIs (bolt://, bolt+s://, neo4j://,
                  neo4j+s://) are accepted and translated to the HTTP API
                  endpoint internally — the exporter pushes Cypher over the
                  REST tx-commit handler, not the Bolt driver, so this works
                  against AuraDB without a driver dependency.
                  Falls back to env NEO4J_URI.

  --user <name>   Neo4j username. Falls back to env NEO4J_USER.

  --password <p>  Neo4j password. Falls back to env NEO4J_PASSWORD.
                  Prefer the env var to keep secrets out of shell history.

  --database <db> Neo4j database name. Falls back to env NEO4J_DATABASE,
                  then to "neo4j" (the default for Community/Aura).

  --no-clear      Skip wiping the target database before export. Default is
                  to issue MATCH (n) DETACH DELETE n first (matching the UI's
                  default behaviour).

Environment variables:
  NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, NEO4J_DATABASE

Examples:
  # BPMN with dexpi: extensions, env-var credentials
  export NEO4J_URI=neo4j+s://xxxx.databases.neo4j.io
  export NEO4J_USER=neo4j
  export NEO4J_PASSWORD=secret
  node cli.js export-neo4j process.bpmn

  # DEXPI XML input, explicit flags
  node cli.js export-neo4j tep.xml --uri bolt://localhost:7687 \\
       --user neo4j --password test --database neo4j

  # Force input type when the extension is misleading
  node cli.js export-neo4j weirdname.txt --from dexpi-xml --uri ... --user ... --password ...
`);
    process.exit(0);
  }

  let from = null;
  let uri = process.env.NEO4J_URI || null;
  let user = process.env.NEO4J_USER || null;
  let password = process.env.NEO4J_PASSWORD || null;
  let database = process.env.NEO4J_DATABASE || null;
  let clearDatabase = true;
  const positionalArgs = [];

  for (let i = 0; i < subArgs.length; i++) {
    const a = subArgs[i];
    const requireValue = (flag) => {
      if (i + 1 >= subArgs.length || subArgs[i + 1].startsWith('--')) {
        console.error(`✗ Error: ${flag} requires a value`);
        process.exit(1);
      }
      return subArgs[++i];
    };
    if (a === '--from') { from = requireValue('--from'); continue; }
    if (a === '--uri') { uri = requireValue('--uri'); continue; }
    if (a === '--user') { user = requireValue('--user'); continue; }
    if (a === '--password') { password = requireValue('--password'); continue; }
    if (a === '--database') { database = requireValue('--database'); continue; }
    if (a === '--no-clear') { clearDatabase = false; continue; }
    if (a.startsWith('--')) {
      console.error(`✗ Error: unknown flag ${a}`);
      process.exit(1);
    }
    positionalArgs.push(a);
  }

  const inputFile = positionalArgs[0];
  if (!inputFile) {
    console.error('✗ Error: input file required (see --help)');
    process.exit(1);
  }

  // Resolve --from: explicit flag wins, otherwise dispatch by extension.
  // Unknown extensions are a hard error so we never silently mis-route.
  let inputKind = from;
  if (!inputKind) {
    if (inputFile.toLowerCase().endsWith('.bpmn')) inputKind = 'bpmn';
    else if (inputFile.toLowerCase().endsWith('.xml')) inputKind = 'dexpi-xml';
    else {
      console.error(
        `✗ Error: cannot infer input type from "${inputFile}". ` +
        `Use --from bpmn or --from dexpi-xml.`,
      );
      process.exit(1);
    }
  }
  if (inputKind !== 'bpmn' && inputKind !== 'dexpi-xml') {
    console.error(`✗ Error: --from must be "bpmn" or "dexpi-xml" (got "${inputKind}")`);
    process.exit(1);
  }

  const missing = [];
  if (!uri) missing.push('--uri / NEO4J_URI');
  if (!user) missing.push('--user / NEO4J_USER');
  if (!password) missing.push('--password / NEO4J_PASSWORD');
  if (missing.length > 0) {
    console.error(`✗ Error: missing Neo4j credentials: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!database) database = 'neo4j';

  const { exportToNeo4j, setNeo4jProcessXml } = await import('./src/utils/neo4jExporter.ts');

  // The exporter's DEXPI process-class registry is environment-agnostic —
  // the UI passes Process.xml in via Vite's ?raw import at app boot,
  // and we do the equivalent here off disk so the same module works
  // from Node without any Vite plumbing.
  const processXml = readFileSync('dexpi-schema-files/Process.xml', 'utf-8');
  setNeo4jProcessXml(processXml);

  // Produce DEXPI XML — either by transforming a BPMN input or by
  // reading a DEXPI XML file straight off disk. The exporter only sees
  // DEXPI XML downstream, so the two paths converge here.
  let dexpiXml;
  if (inputKind === 'bpmn') {
    const bpmn = readFileSync(inputFile, 'utf-8');
    dexpiXml = await transformer.transform(bpmn);
    console.error(`✓ Transformed BPMN → DEXPI XML (${inputFile})`);
  } else {
    dexpiXml = readFileSync(inputFile, 'utf-8');
    console.error(`✓ Loaded DEXPI XML (${inputFile})`);
  }

  console.error(`→ Exporting to Neo4j at ${uri} (database: ${database}, clear: ${clearDatabase})`);

  const result = await exportToNeo4j(
    dexpiXml,
    { uri, user, password, database },
    (current, total) => {
      // Progress is line-buffered to stderr so it doesn't interleave with the
      // success/failure summary on stdout, and so callers can capture stdout
      // alone if they want to parse a result.
      process.stderr.write(`\r  ${current}/${total} batches sent`);
      if (current === total) process.stderr.write('\n');
    },
  );

  if (result.success) {
    console.log(result.message || '✓ Neo4j export complete');
    process.exit(0);
  } else {
    console.error(`✗ Neo4j export failed: ${result.message}`);
    process.exit(1);
  }
}
