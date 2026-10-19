import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function verify(label, core, scrum) {
  try {
    let caught;
    try {
      scrum.validateScrumConfig({});
    } catch (e) {
      caught = e;
    }
    if (!(caught instanceof core.WorkflowError)) throw new Error("scrum error is not instanceof core WorkflowError");
    if (caught.code !== "config-invalid") throw new Error(`unexpected code ${caught.code}`);
    if (scrum.scrum().name !== "scrum") throw new Error("scrum().name is not scrum");
  } catch (e) {
    console.error(`FAIL ${label}: ${e.message}`);
    process.exit(1);
  }
}

const url = (p) => pathToFileURL(resolve(p)).href;
verify("esm", await import(url("dist/index.mjs")), await import(url("dist/scrum/index.mjs")));
const require = createRequire(import.meta.url);
verify("cjs", require("./../dist/index.cjs"), require("./../dist/scrum/index.cjs"));
console.log("ok");
