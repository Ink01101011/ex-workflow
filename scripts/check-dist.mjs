import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function verify(label, core, scrum, kanban, waterfall) {
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
    let kcaught;
    try {
      kanban.validateKanbanConfig({ columns: 5 });
    } catch (e) {
      kcaught = e;
    }
    if (!(kcaught instanceof core.WorkflowError)) throw new Error("kanban error is not instanceof core WorkflowError");
    if (kcaught.code !== "config-invalid") throw new Error(`unexpected kanban code ${kcaught.code}`);
    if (kanban.kanban().name !== "kanban") throw new Error("kanban().name is not kanban");
    let wcaught;
    try {
      waterfall.validateWaterfallConfig({ phases: 5 });
    } catch (e) {
      wcaught = e;
    }
    if (!(wcaught instanceof core.WorkflowError)) throw new Error("waterfall error is not instanceof core WorkflowError");
    if (wcaught.code !== "config-invalid") throw new Error(`unexpected waterfall code ${wcaught.code}`);
    if (waterfall.waterfall().name !== "waterfall") throw new Error("waterfall().name is not waterfall");
  } catch (e) {
    console.error(`FAIL ${label}: ${e.message}`);
    process.exit(1);
  }
}

const url = (p) => pathToFileURL(resolve(p)).href;
verify("esm", await import(url("dist/index.mjs")), await import(url("dist/scrum/index.mjs")), await import(url("dist/kanban/index.mjs")), await import(url("dist/waterfall/index.mjs")));
const require = createRequire(import.meta.url);
verify("cjs", require("./../dist/index.cjs"), require("./../dist/scrum/index.cjs"), require("./../dist/kanban/index.cjs"), require("./../dist/waterfall/index.cjs"));
console.log("ok");
