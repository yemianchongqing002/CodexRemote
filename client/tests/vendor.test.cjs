const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {syncClientVendor} = require('../../scripts/sync-client-vendor.cjs');
const vendor = path.resolve(__dirname, '../../internal/server/web/vendor');

test('standalone vendor copy is complete and removes obsolete assets', t => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-vendor-'));
  t.after(() => fs.rmSync(target, {recursive:true, force:true}));
  fs.writeFileSync(path.join(target, 'obsolete.ttf'), 'unused');
  syncClientVendor(vendor, target);
  assert.equal(fs.existsSync(path.join(target, 'obsolete.ttf')), false);
  function compare(from, to) {
    for (const entry of fs.readdirSync(from, {withFileTypes:true})) {
      const a=path.join(from,entry.name), b=path.join(to,entry.name);
      if(entry.isDirectory()) compare(a,b);
      else assert.deepEqual(fs.readFileSync(b), fs.readFileSync(a));
    }
  }
  compare(vendor,target);
  const css = fs.readFileSync(path.join(target, 'katex/katex.min.css'),'utf8');
  const references = [...css.matchAll(/url\(([^)]+)\)/g)].map(m=>m[1]);
  assert.equal(references.length,20);
  for(const ref of references) {
    assert.ok(ref.endsWith('.woff2'));
    assert.ok(fs.existsSync(path.join(target,'katex',ref)),ref);
  }
});

test('retained KaTeX bundle renders sized symbols and alternate math alphabets', () => {
  const katex = require(path.join(vendor,'katex/katex.min.js'));
  for(const formula of [String.raw`\left(\frac{1}{\sum_{i=1}^n i}\right)`, String.raw`\mathbb{R}\quad\mathfrak{g}\quad\mathcal{F}\quad\boldsymbol{x}`]) {
    assert.match(katex.renderToString(formula,{throwOnError:true}),/class="katex"/);
  }
});
