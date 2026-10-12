// Build: bundle src/ into the single-file userscript Tampermonkey installs.
//
// The output (recent-subreddits.user.js) is committed — it is the artifact the
// user pastes into Tampermonkey and the file both test suites load. `npm test`
// rebuilds first (pretest hook), so the artifact can never drift from src/.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The userscript metadata block must be the first thing in the file, so it is a
// banner rather than an import.
const banner = readFileSync(join(ROOT, 'src', 'userscript.meta.js'), 'utf8').trimEnd();

await build({
  entryPoints: [join(ROOT, 'src', 'app.js')],
  outfile: join(ROOT, 'recent-subreddits.user.js'),
  bundle: true,
  format: 'iife',
  // No down-levelling: the unit tests read the built file as source and extract
  // helpers by name, so the output should stay close to what is written.
  target: 'esnext',
  banner: { js: banner },
  logLevel: 'info',
});
