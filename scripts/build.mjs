import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { recruitDefaults, renderRecruitPage } from '../public/recruit-content.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  output = resolve(root, 'dist');
if (output !== resolve(root, 'dist') || dirname(output) !== root) throw new Error('Unexpected output folder');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, 'public'), output, { recursive: true });
const recruitHtml = await readFile(resolve(root, 'public/recruit.html'), 'utf8');
await writeFile(
  resolve(output, 'recruit.html'),
  recruitHtml.replace(
    /(<main id="main" class="recruit-main">)[\s\S]*?(<\/main>)/,
    (_, start, end) =>
      start +
      renderRecruitPage(recruitDefaults) +
      '<noscript><p class="wrap">応募先の最新情報を表示するには、JavaScriptを有効にして開き直してください。</p></noscript>' +
      end
  )
);
await build({
  entryPoints: [resolve(root, 'src/worker.mjs')],
  outfile: resolve(output, '_worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true
});
// Static scripts, styles and robots.txt bypass the Worker. HTML pages still go
// through it so share metadata and security headers are applied.
const staticFiles = (await readdir(resolve(root, 'public'), { withFileTypes: true }))
  .filter(entry => entry.isFile() && /\.(mjs|css|txt)$/.test(entry.name))
  .map(entry => `/${entry.name}`)
  .sort();
await writeFile(
  resolve(output, '_routes.json'),
  JSON.stringify({ version: 1, include: ['/*'], exclude: ['/assets/*', ...staticFiles] }, null, 2)
);
console.log('Cloudflare Pages用の公開ファイルを作成しました。');
