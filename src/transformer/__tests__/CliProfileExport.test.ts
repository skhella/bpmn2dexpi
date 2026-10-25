/**
 * The CLI export is self-describing by default: `node cli.js in.bpmn out.xml`
 * writes out.profile.xml next to out.xml and the document imports it — when
 * the model uses anything beyond the DEXPI 2.0 vocabulary. A model that
 * needs no profile produces neither the file nor the Import, and
 * --no-profile opts out.
 *
 * Runs the real CLI (node --import tsx cli.js) from the repository root,
 * writing into a fresh temporary directory per test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '../../..');
const TEP_BPMN = join(REPO_ROOT, 'examples/Tennessee_Eastman_Process.bpmn');
const TEP_PROFILE = readFileSync(join(REPO_ROOT, 'examples/profiles/tep-generated.xml'), 'utf-8');

const PLAIN_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
                  id="defs_1" targetNamespace="https://example.org/test">
  <bpmn:process id="proc_1">
    <bpmn:task id="task_1" name="Pump">
      <bpmn:extensionElements>
        <dexpi:element dexpiType="Pumping" identifier="P-101" uid="p101"/>
      </bpmn:extensionElements>
    </bpmn:task>
  </bpmn:process>
</bpmn:definitions>`;

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'cli.js', ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

const CLI_TIMEOUT = 90_000;

describe('cli: self-describing export', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'bpmn2dexpi-cli-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes <output basename>.profile.xml next to the output and imports it', async () => {
    const out = join(dir, 'tep.xml');
    const r = await runCli([TEP_BPMN, out]);
    expect(r.code, r.stderr).toBe(0);

    const profile = join(dir, 'tep.profile.xml');
    expect(existsSync(out)).toBe(true);
    expect(existsSync(profile)).toBe(true);

    const doc = readFileSync(out, 'utf-8');
    const process_ = doc.indexOf('<Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>');
    const imp = doc.indexOf('<Import prefix="Profile" source="tep.profile.xml"/>');
    expect(process_).toBeGreaterThan(-1);
    expect(imp).toBeGreaterThan(process_);

    // Deterministic: the committed reference profile, byte for byte.
    expect(readFileSync(profile, 'utf-8')).toBe(TEP_PROFILE);
    expect(r.stderr).toContain('DEXPI Profile → ');
  }, CLI_TIMEOUT);

  it('--no-profile writes the document only, with no profile import', async () => {
    const out = join(dir, 'tep-noprofile.xml');
    const r = await runCli(['--no-profile', TEP_BPMN, out]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(dir, 'tep-noprofile.profile.xml'))).toBe(false);
    expect(readFileSync(out, 'utf-8')).not.toContain('prefix="Profile"');
  }, CLI_TIMEOUT);

  it('--generate-profile FILE places the profile there and imports it by that name', async () => {
    const out = join(dir, 'tep-named.xml');
    const profile = join(dir, 'custom.xml');
    const r = await runCli(['--generate-profile', profile, TEP_BPMN, out]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(profile)).toBe(true);
    expect(existsSync(join(dir, 'tep-named.profile.xml'))).toBe(false);
    expect(readFileSync(out, 'utf-8')).toContain('<Import prefix="Profile" source="custom.xml"/>');
  }, CLI_TIMEOUT);

  it('a model without extensions produces neither a profile file nor an import', async () => {
    const input = join(dir, 'plain.bpmn');
    writeFileSync(input, PLAIN_BPMN, 'utf-8');
    const out = join(dir, 'plain.xml');
    const r = await runCli([input, out]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(dir, 'plain.profile.xml'))).toBe(false);
    expect(readFileSync(out, 'utf-8')).not.toContain('prefix="Profile"');
    expect(r.stderr).toContain('needs no profile');
  }, CLI_TIMEOUT);
});

describe('cli: --strict with the generated profile', () => {
  it('exits 0 on the Tennessee Eastman export, since its profile declares every extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bpmn2dexpi-strict-'));
    try {
      const out = join(dir, 'tep.xml');
      const r = await runCli(['--strict', TEP_BPMN, out]);
      expect(r.stderr).toContain("validated with the export's own profile loaded");
      expect(r.code, r.stderr).toBe(0);
      expect(existsSync(join(dir, 'tep.profile.xml'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 with --no-profile, because the extensions are then undeclared', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bpmn2dexpi-strict-'));
    try {
      const r = await runCli(['--strict', '--no-profile', TEP_BPMN, join(dir, 'tep.xml')]);
      expect(r.code).toBe(2);
      expect(r.stderr).not.toContain("validated with the export's own profile loaded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
