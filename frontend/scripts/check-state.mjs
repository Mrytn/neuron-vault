import { build } from 'esbuild';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = await build({
  stdin: { contents: "import './tests/state.test.tsx'; import './tests/network-layout.test.ts'; import './tests/network-canvas.test.tsx'; import './tests/spatial-layout.test.ts'; import './tests/spatial-canvas.test.tsx';", resolveDir: root, loader: 'tsx' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  write: false,
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server', 'react-test-renderer'],
});
const filename = resolve(root, 'tests/state.test.cjs');
const compiled = new Module(filename);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(dirname(filename));
compiled._compile(output.outputFiles[0].text, filename);
