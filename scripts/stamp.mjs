// Sets the cache token on every page to a hash of the stylesheet and the script.
// site.css and site.js are served with a one-year immutable cache, so a changed file must change the
// ?v= token the pages request it with. Run `npm run stamp` after editing either; the test suite fails
// while any page carries a stale token.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export function assetToken() {
  const hash = createHash("sha256");
  for (const file of ["site.css", "site.js"]) hash.update(fs.readFileSync(path.join(root, "assets", file)));
  return hash.digest("hex").slice(0, 10);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const token = assetToken();
  for (const page of fs.readdirSync(root).filter((name) => name.endsWith(".html"))) {
    const file = path.join(root, page);
    const html = fs.readFileSync(file, "utf8");
    const next = html.replace(/(\/assets\/site\.(?:css|js))\?v=[^"]+/g, `$1?v=${token}`);
    if (next !== html) fs.writeFileSync(file, next);
  }
  console.log(`cache token ${token}`);
}
