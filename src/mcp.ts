#!/usr/bin/env node
// Optional bonus: expose the same 402 -> pay -> unlock loop as an MCP tool, so an
// MCP-aware agent (Claude Code, etc.) can pay a paywall directly instead of shelling
// out to the CLI. Same core (src/pay.ts) as bin/cli.ts, this is just a second transport.
//
// Deliberately thin: the tool logic lives in mcpTools.ts so it can be tested without
// opening a stdio connection. Everything here is wiring.
//
// Requires @modelcontextprotocol/sdk + zod (optionalDependencies) to use this entry point.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools, configFromEnv } from "./mcpTools.js";

const server = new McpServer({ name: "stellar-agent-pay", version: "0.1.0" });

registerTools(server, configFromEnv());

const transport = new StdioServerTransport();
await server.connect(transport);
