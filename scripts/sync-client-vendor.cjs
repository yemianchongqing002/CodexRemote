// One maintained renderer bundle; standalone clients receive a generated copy.
const fs = require('node:fs');
const path = require('node:path');
const source = path.resolve(__dirname, '../internal/server/web/vendor');
const destination = path.resolve(__dirname, '../client/ui/vendor');
function syncClientVendor(from = source, to = destination) {
  fs.mkdirSync(to, { recursive: true });
  const entries = fs.readdirSync(from, { withFileTypes: true });
  const names = new Set(entries.map(entry => entry.name));
  for (const name of fs.readdirSync(to)) {
    if (!names.has(name)) fs.rmSync(path.join(to, name), { recursive: true, force: true });
  }
  for (const entry of entries) {
    const input = path.join(from, entry.name), output = path.join(to, entry.name);
    if (entry.isDirectory()) syncClientVendor(input, output);
    else {
      const content = fs.readFileSync(input);
      if (!fs.existsSync(output) || !content.equals(fs.readFileSync(output))) fs.writeFileSync(output, content);
    }
  }
}
module.exports = { syncClientVendor };
if (require.main === module) syncClientVendor();
