import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const directory of ['src', 'public', 'scripts', 'tests']) {
  for (const file of await readdir(directory))
    if (file.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(1);
    }
}
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
if (config.pages_build_output_dir !== './dist') throw new Error('Pagesの出力先を確認してください。');
console.log('構文と公開設定を確認しました。');
