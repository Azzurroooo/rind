#!/usr/bin/env node

import { runFrontendCliApp } from "../lib/frontend-cli-implementation.js";

await runFrontendCliApp(process.argv.slice(2));
