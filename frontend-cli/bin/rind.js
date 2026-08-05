#!/usr/bin/env node

import { runFrontendCli } from "../lib/frontend-cli.js";

await runFrontendCli(process.argv.slice(2));
