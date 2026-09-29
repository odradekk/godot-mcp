// After tsc: make the entry point executable and copy the GDScript files next to the build.
import { chmodSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';

const root = new URL('..', import.meta.url);

chmodSync(new URL('build/index.js', root), 0o755);
mkdirSync(new URL('build/scripts/', root), { recursive: true });
for (const file of readdirSync(new URL('src/scripts/', root))) {
  copyFileSync(new URL(`src/scripts/${file}`, root), new URL(`build/scripts/${file}`, root));
}
