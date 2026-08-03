/**
 * Parse-check every source file.
 *
 * Replaces `find . -name '*.js' | xargs -n1 node --check`, which needs a POSIX
 * shell and therefore fails on Windows (PowerShell/cmd have no `find` with
 * these semantics and no `xargs` at all). Deployment targets include a Windows
 * Server, so the check has to be runnable there too.
 *
 *   node scripts/checkSyntax.js
 *
 * Exits 1 and prints every offending file on failure.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);

/** @returns {String[]} absolute paths of every .js file under `dir` */
const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
};

const files = walk(ROOT);
const failures = [];

for (const file of files) {
  try {
    // `node --check` per file: same guarantee as the old pipeline, but the
    // argument is passed directly rather than through a shell, so paths with
    // spaces (common on Windows: C:\Program Files\...) are safe.
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failures.push({ file: path.relative(ROOT, file), message: String(err.stderr || err.message).trim() });
  }
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n✖ ${f.file}\n${f.message}`);
  }
  console.error(`\n${failures.length} of ${files.length} files failed to parse.`);
  process.exit(1);
}

console.log(`${files.length} files parsed OK.`);
