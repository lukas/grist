#!/usr/bin/env node
import { runSkillsCli } from "./skillsCliCore.js";

runSkillsCli(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
