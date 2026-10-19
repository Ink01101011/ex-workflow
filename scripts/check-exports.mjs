import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

function paths(node, trail, out) {
  if (typeof node === "string") out.push([trail, node]);
  else for (const [k, v] of Object.entries(node)) paths(v, `${trail}.${k}`, out);
  return out;
}

const found = [
  ...paths(pkg.exports, "exports", []),
  ...["main", "module", "types"].filter((k) => pkg[k]).map((k) => [k, pkg[k]]),
  ...paths(pkg.bin ?? {}, "bin", []),
];
let failed = false;
for (const [where, rel] of found) {
  if (!existsSync(resolve(rel))) {
    console.error(`FAIL ${where} -> ${rel} does not exist`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`ok ${found.length} export paths exist`);
