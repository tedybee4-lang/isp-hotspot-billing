import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const entryPoint = existsSync('src/index.ts') ? 'src/index.ts' : 'worker/src/index.ts'

const rawTextPlugin = {
  name: 'raw-text-assets',
  setup(esbuild) {
    esbuild.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
      namespace: 'raw-text',
    }))
    esbuild.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }))
  },
}

await build({
  entryPoints: [entryPoint],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/index.cjs',
  plugins: [rawTextPlugin],
})
