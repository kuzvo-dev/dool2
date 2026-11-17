#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createReadyServer } from './index.js'

await (await createReadyServer()).connect(new StdioServerTransport())
