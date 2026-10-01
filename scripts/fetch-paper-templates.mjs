// Download the unchanged Springer Nature external template files for synthetic regression tests.
// sn-jnl.cls is deliberately not vendored: preserve its original LPPL/distribution notice.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest = resolve(process.argv[2] ?? join(repo, 'node_modules', '.cache', 'paper-templates', 'springer'));
const url = 'https://cms-resources.apps.public.k8s.springernature.io/springer-cms/rest/v1/content/18782940/data/v12';
const hash = b => createHash('sha256').update(b).digest('hex');
const expectedZip = '812e76dcaa9c28dc1bff1fb6065d51729b67d4ea140552a05088317414a3ecae';
const files = [
 ['sn-jnl.cls', 'sn-article-template/sn-jnl.cls', '36d0c3273a59d48dc6a9c7b080dfa1ec50dc10229d8751568d1f2e490ffa5ecc'],
 ['sn-vancouver-num.bst', 'sn-article-template/bst/sn-vancouver-num.bst', '7fa6df12ec8e8945c86958a50fb703d181522745adcf72bf95a86f3633540e8a'],
];
if (files.every(([name, , checksum]) => existsSync(join(dest, name)) && hash(readFileSync(join(dest, name))) === checksum)) {
 console.log(`Verified cached Springer Nature 3.1 external files in ${dest}`);
 process.exit(0);
}
const response = await fetch(url);
if (!response.ok) throw new Error(`Template download failed: HTTP ${response.status}`);
const zip = Buffer.from(await response.arrayBuffer());
if (hash(zip) !== expectedZip) throw new Error('Template archive changed; inspect the upstream release and update the receipt deliberately.');
const temp = mkdtempSync(join(tmpdir(), 'springer-template-'));
try {
 const path = join(temp, 'source.zip'); writeFileSync(path, zip);
 const prepared = files.map(([name, member, checksum]) => {
  const bytes = execFileSync('unzip', ['-p', path, member], { maxBuffer: 4 << 20 });
  if (hash(bytes) !== checksum) throw new Error(`Checksum mismatch: ${name}`);
  if (existsSync(join(dest, name)) && hash(readFileSync(join(dest, name))) !== checksum) throw new Error(`Refusing to replace a changed existing file: ${name}`);
  return [name, bytes];
 });
 mkdirSync(dest, { recursive: true });
 for (const [name, bytes] of prepared) writeFileSync(join(dest, name), bytes);
 console.log(`Verified Springer Nature 3.1 external files in ${dest}`);
} finally { rmSync(temp, { recursive: true, force: true }); }
