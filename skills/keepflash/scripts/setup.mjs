#!/usr/bin/env node

import { formatCliError, main } from "./keepflash.mjs";

main(["auth", "login"]).catch((error) => {
  process.stderr.write(`${formatCliError(error)}\n`);
  process.exitCode = 1;
});
