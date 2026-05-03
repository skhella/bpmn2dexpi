import { execSync } from 'node:child_process';

try {
  execSync('git rev-parse --git-dir', { stdio: 'ignore' });
} catch {
  process.exit(0);
}

try {
  execSync('git config core.hooksPath .githooks', { stdio: 'ignore' });
  console.log('git hooks: .githooks/ (commit-identity guard active)');
} catch {
  process.exit(0);
}
