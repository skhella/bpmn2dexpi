/**
 * The CLI's --dexpi-version flag and the version-aware --validate.
 * Runs the real CLI (node --import tsx cli.js) from the repository root.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '../../..');
const TEP_BPMN = join(REPO_ROOT, 'examples/Tennessee_Eastman_Process.bpmn');

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

const CLI_TIMEOUT = 120_000;

describe('cli: --dexpi-version', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'bpmn2dexpi-cli-201-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes a 2.0.1 document with its profile, and --validate checks it against the 2.0.1 vocabulary', async () => {
    const out = join(dir, 'tep201.xml');
    const r = await runCli(['--dexpi-version', '2.0.1', TEP_BPMN, out]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain('(DEXPI 2.0.1)');
    const xml = readFileSync(out, 'utf-8');
    expect(xml).toContain('source="https://data.dexpi.org/models/2.0.1/Process.xml"');
    expect(xml).toContain('property="MoleFractions"');
    expect(xml).not.toContain('MoleFractiona');
    expect(xml).not.toContain('property="MaterialStateTypes"');
    const profile = join(dir, 'tep201.profile.xml');
    expect(existsSync(profile)).toBe(true);
    expect(readFileSync(profile, 'utf-8')).toContain('models/2.0.1/Core.xml');

    const v = await runCli(['--validate', out, '--profile', profile]);
    expect(v.code, v.stderr).toBe(0);
    expect(v.stderr).toContain('Document imports the DEXPI 2.0.1 models; validating against the 2.0.1 vocabulary');
    expect(v.stderr).toContain('XSD validation');
    expect(v.stderr).toContain('All five fidelity dimensions clean');
  }, CLI_TIMEOUT);

  it('defaults to 2.0.0 and --validate recognises that too', async () => {
    const out = join(dir, 'tep200.xml');
    const r = await runCli([TEP_BPMN, out]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain('(DEXPI 2.0.0)');
    const xml = readFileSync(out, 'utf-8');
    expect(xml).toContain('source="https://data.dexpi.org/models/2.0.0/Process.xml"');
    expect(xml).toContain('property="MoleFractiona"');
    const v = await runCli(['--validate', out, '--profile', join(dir, 'tep200.profile.xml')]);
    expect(v.code, v.stderr).toBe(0);
    expect(v.stderr).toContain('validating against the 2.0.0 vocabulary');
  }, CLI_TIMEOUT);

  it('rejects an unknown version', async () => {
    const r = await runCli(['--dexpi-version', '2.1.0', TEP_BPMN]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--dexpi-version requires one of 2.0.0, 2.0.1');
  }, CLI_TIMEOUT);
});
