/**
 * MCP Server — exposes tools to the Agent and external MCP clients.
 *
 * This is a stateful MCP server (McpAgent) that exposes callable tools
 * the agent can invoke during its reasoning loop. External MCP clients
 * (Claude Desktop, etc.) can also connect to /mcp.
 *
 * Docs: https://developers.cloudflare.com/agents/model-context-protocol/
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export class ToolsMCP extends McpAgent {
  server = new McpServer({
    name: "agent-tools",
    version: "1.0.0",
  });

  initialState = {
    lookupCount: 0,
  };

  async init() {
    // ── Tool: get_weather ──────────────────────────────────────────
    this.server.tool(
      "get_weather",
      "Get the current weather for a city",
      { city: z.string().describe("City name, e.g. 'San Francisco'") },
      async ({ city }) => {
        // Replace with a real weather API call
        const temp = Math.floor(Math.random() * 30) + 5;
        this.setState({ ...this.state, lookupCount: this.state.lookupCount + 1 });
        return {
          content: [
            { type: "text", text: `Weather in ${city}: ${temp}°C, partly cloudy` },
          ],
        };
      },
    );

    // ── Tool: search_knowledge ─────────────────────────────────────
    this.server.tool(
      "search_knowledge",
      "Search the knowledge base for relevant content",
      { query: z.string().describe("Search query") },
      async ({ query }) => {
        // Replace with AI Search, Vectorize, or any search backend
        const results = [
          { title: "Result 1", snippet: `Information about: ${query}` },
          { title: "Result 2", snippet: `More details about: ${query}` },
        ];
        return {
          content: [
            { type: "text", text: JSON.stringify(results, null, 2) },
          ],
        };
      },
    );

    // ── Tool: create_task ──────────────────────────────────────────
    this.server.tool(
      "create_task",
      "Create a task in the task tracker",
      {
        title: z.string(),
        description: z.string().optional(),
      },
      async ({ title, description }) => {
        return {
          content: [
            {
              type: "text",
              text: `Task created: ${title}${description ? ` — ${description}` : ""}`,
            },
          ],
        };
      },
    );
  }
}
