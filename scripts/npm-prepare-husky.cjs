'use strict';
/**
 * Runs `husky install` only when husky is installed (dev install).
 * Skips cleanly for `npm ci --omit=dev` (e.g. Docker / Railway) so prepare does not fail.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const huskyBin = path.join(root, 'node_modules', '.bin', 'husky');
if (!fs.existsSync(huskyBin)) {
  process.exit(0);
}
try {
  execFileSync(huskyBin, ['install'], { stdio: 'inherit', cwd: root, env: process.env });
} catch (err) {
  process.exit(err.status ?? 1);
}
