#!/usr/bin/env node
import { runCommand } from "./commands.ts";

runCommand(process.argv.slice(2), process.cwd()).then(
  (r) => {
    process.stdout.write(JSON.stringify(r.out, null, 2) + "\n");
    process.exitCode = r.exit;
  },
  (e: unknown) => {
    process.stderr.write(`exwf crashed: ${(e as Error).stack ?? String(e)}\n`);
    process.exitCode = 2;
  },
);
