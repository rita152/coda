#!/usr/bin/env node

import { createNodeCodingAgentApplication } from "./node-application.ts";

const application = createNodeCodingAgentApplication();
process.exitCode = await application.run(process.argv.slice(2));
