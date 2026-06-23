import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.resolve(here, 'dist');

await rm(outdir, { recursive: true, force: true });

const result = await build({
  // server.js is the app; migrate.js is the Fly release-command entrypoint
  // that runs drizzle-orm's programmatic migrator (DEC-40, DEC-61).
  entryPoints: [
    path.resolve(here, 'src/server.ts'),
    path.resolve(here, 'src/migrate.ts'),
  ],
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  banner: {
    // Re-create CJS interop shims that esbuild's `format: 'esm'` strips,
    // so any transitive CJS dep that reaches for `require` / `__dirname`
    // resolves against the bundle's own path rather than crashing.
    js: [
      "import { createRequire as __ll_createRequire } from 'node:module';",
      "import { fileURLToPath as __ll_fileURLToPath } from 'node:url';",
      "import { dirname as __ll_dirname } from 'node:path';",
      'const require = __ll_createRequire(import.meta.url);',
      'const __filename = __ll_fileURLToPath(import.meta.url);',
      'const __dirname = __ll_dirname(__filename);',
    ].join('\n'),
  },
});

if (result.warnings.length > 0) {
  for (const warning of result.warnings) {
    process.stderr.write(`${warning.text}\n`);
  }
}
