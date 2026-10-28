import ts from "typescript";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/index.ts";
import * as scrum from "../src/scrum/index.ts";
import * as kanban from "../src/kanban/index.ts";
import * as waterfall from "../src/waterfall/index.ts";
import * as investigation from "../src/investigation/index.ts";
import * as experimentation from "../src/experimentation/index.ts";
import * as schema from "../src/schema/index.ts";
import { USAGE } from "../src/cli/commands.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SURFACE = path.join(here, "api-surface.json");
const SRC = path.join(here, "..", "src");

// no Array#toSorted: it needs Node 20 and the tests run on Node 18
// oxlint-disable-next-line unicorn/no-array-sort
const sorted = (xs: Iterable<string>): string[] => Array.from(xs).sort();
const names = (mod: object) => sorted(Object.keys(mod));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [full] : [];
  });
}

// createState writes its first event by hand (src/state.ts), not through appendEvent
const HAND_BUILT_KINDS = ["state.created"];

function eventKinds(): string[] {
  const kinds = new Set<string>(HAND_BUILT_KINDS);
  for (const file of sources(SRC)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const isInvestigation = file.endsWith(`${path.sep}investigation${path.sep}ceremonies.ts`);
    const isExperimentation = file.endsWith(`${path.sep}experimentation${path.sep}ceremonies.ts`);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const argument =
          name === "appendEvent"
            ? node.arguments[1]
            : isInvestigation && name === "save"
              ? node.arguments[3]
              : isExperimentation && name === "reduce"
                ? node.arguments[0]
                : undefined;
        if (argument && ts.isStringLiteral(argument))
          kinds.add(
            name === "appendEvent"
              ? argument.text
              : `${isInvestigation ? "investigation" : "experimentation"}.${argument.text}`,
          );
      }
      // closed() forwards its typed outcome into save(), including a dynamic conclusion outcome.
      if (isInvestigation && ts.isFunctionDeclaration(node) && node.name?.text === "closed") {
        const type = node.parameters[3]?.type;
        if (type && ts.isUnionTypeNode(type))
          for (const member of type.types)
            if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal))
              kinds.add(`investigation.${member.literal.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sorted(kinds);
}

function current() {
  return {
    entries: {
      ".": names(core),
      "./scrum": names(scrum),
      "./kanban": names(kanban),
      "./waterfall": names(waterfall),
      "./investigation": names(investigation),
      "./experimentation": names(experimentation),
      "./schema": names(schema),
    },
    usage: [...USAGE],
    schemaDocuments: sorted(
      Object.entries(schema)
        .filter(([, v]) => typeof v === "object" && v !== null && "definitions" in v)
        .map(([k]) => k),
    ),
    eventKinds: eventKinds(),
  };
}

test("the public surface matches test/api-surface.json", () => {
  const now = current();
  if (process.env["UPDATE_API_SURFACE"] === "1") {
    writeFileSync(SURFACE, JSON.stringify(now, null, 2) + "\n");
    return;
  }
  assert.deepEqual(
    now,
    JSON.parse(readFileSync(SURFACE, "utf8")),
    "the public surface changed: a removal is a major version, an addition a minor one; if intended, rerun with UPDATE_API_SURFACE=1",
  );
});
