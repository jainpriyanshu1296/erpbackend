const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Enumerate explicitly: Node 20 does not expand the test CLI's glob patterns.
function testFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory()
      ? testFiles(filename)
      : entry.name.endsWith('.test.js')
        ? [filename]
        : [];
  });
}
const files = testFiles(path.resolve(__dirname, '../../test')).sort();
if (!files.length) throw new Error('No test files found');
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
