// Bun 原生构建入口：清理旧产物，再分别输出 CLI bundle 与无副作用 runtime library。
import { $ } from 'bun';

const PROJECT_ROOT = `${import.meta.dir}/..`;
const OUT_DIR = `${PROJECT_ROOT}/dist`;

await $`rm -rf ${OUT_DIR}`.quiet();

const cliResult = await Bun.build({
  entrypoints: [`${PROJECT_ROOT}/src/cli/bootstrap.ts`],
  outdir: OUT_DIR,
  target: 'bun',
  format: 'esm',
  packages: 'external',
  splitting: true,
  sourcemap: 'external',
  naming: {
    entry: 'main.js',
    chunk: 'chunks/[name]-[hash].js',
  },
});

const runtimeResult = await Bun.build({
  entrypoints: [`${PROJECT_ROOT}/src/runtime/index.ts`],
  outdir: `${OUT_DIR}/runtime`,
  target: 'bun',
  format: 'esm',
  packages: 'external',
  sourcemap: 'external',
  naming: 'index.js',
});

const capabilitiesResult = await Bun.build({
  entrypoints: [`${PROJECT_ROOT}/src/capabilities/index.ts`],
  outdir: `${OUT_DIR}/capabilities`,
  target: 'bun',
  format: 'esm',
  packages: 'external',
  sourcemap: 'external',
  naming: 'index.js',
});

const legacyCodingToolsResult = await Bun.build({
  entrypoints: [`${PROJECT_ROOT}/src/integrations/legacy-coding-tools/index.ts`],
  outdir: `${OUT_DIR}/legacy-coding-tools`,
  target: 'bun',
  format: 'esm',
  packages: 'external',
  sourcemap: 'external',
  naming: 'index.js',
});

for (const log of [
  ...cliResult.logs,
  ...runtimeResult.logs,
  ...capabilitiesResult.logs,
  ...legacyCodingToolsResult.logs,
]) {
  console.error(log);
}

if (!cliResult.success
  || !runtimeResult.success
  || !capabilitiesResult.success
  || !legacyCodingToolsResult.success) {
  process.exit(1);
}

// package exports 的 types 条件必须指向真实、可由包外 TypeScript consumer 解析的声明。
await $`bun run --bun tsc --project ${PROJECT_ROOT}/tsconfig.build.json`;
