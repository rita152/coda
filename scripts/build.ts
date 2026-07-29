// Bun 原生构建入口：清理旧产物，再输出面向 Bun 运行时的 ESM CLI bundle。
import { $ } from 'bun';

const PROJECT_ROOT = `${import.meta.dir}/..`;
const OUT_DIR = `${PROJECT_ROOT}/dist`;

await $`rm -rf ${OUT_DIR}`.quiet();

const result = await Bun.build({
  entrypoints: [`${PROJECT_ROOT}/src/cli/main.ts`],
  outdir: OUT_DIR,
  target: 'bun',
  format: 'esm',
  packages: 'external',
  sourcemap: 'external',
  naming: 'main.js',
});

for (const log of result.logs) {
  console.error(log);
}

if (!result.success) {
  process.exit(1);
}
