// Bun 原生构建入口：清理旧产物，再分别输出 CLI bundle 与无副作用 runtime library。
import { $ } from 'bun';

const PROJECT_ROOT = `${import.meta.dir}/..`;
const OUT_DIR = `${PROJECT_ROOT}/dist`;

await $`rm -rf ${OUT_DIR}`.quiet();

const builds = [
  {
    entrypoint: 'src/cli/bootstrap.ts',
    outdir: OUT_DIR,
    splitting: true,
    naming: { entry: 'main.js', chunk: 'chunks/[name]-[hash].js' },
  },
  { entrypoint: 'src/runtime/index.ts', outdir: `${OUT_DIR}/runtime`, naming: 'index.js' },
  { entrypoint: 'src/capabilities/index.ts', outdir: `${OUT_DIR}/capabilities`, naming: 'index.js' },
  {
    entrypoint: 'src/integrations/coding-capabilities/index.ts',
    outdir: `${OUT_DIR}/coding-capabilities`,
    naming: 'index.js',
  },
] as const;

const results = [];
for (const { entrypoint, ...options } of builds) {
  results.push(await Bun.build({
    entrypoints: [`${PROJECT_ROOT}/${entrypoint}`],
    target: 'bun',
    format: 'esm',
    packages: 'external',
    sourcemap: 'external',
    ...options,
  }));
}

for (const log of results.flatMap((result) => result.logs)) {
  console.error(log);
}

if (results.some((result) => !result.success)) {
  process.exit(1);
}

// package exports 的 types 条件必须指向真实、可由包外 TypeScript consumer 解析的声明。
await $`bun run --bun tsc --project ${PROJECT_ROOT}/tsconfig.build.json`;
