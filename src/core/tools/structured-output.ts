import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** Stable envelope version for MCP `structuredContent`. Consumers should pin major 1. */
export const TOOL_OUTPUT_SCHEMA_VERSION = "1.0.0" as const;

/**
 * Common output schema applied to every tool. Text content remains unchanged for
 * backwards compatibility; schema-aware clients should consume structuredContent.
 */
export const TOOL_OUTPUT_SCHEMA = {
  schemaVersion: z.literal(TOOL_OUTPUT_SCHEMA_VERSION),
  tool: z.string(),
  result: z.unknown(),
};

export interface StructuredToolOutput {
  schemaVersion: typeof TOOL_OUTPUT_SCHEMA_VERSION;
  tool: string;
  result: unknown;
}

type AnyToolHandler = (...args: any[]) => CallToolResult | Promise<CallToolResult>;

function parseTextContent(response: CallToolResult): unknown {
  const texts = response.content
    .filter((item): item is Extract<(typeof response.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text);

  if (texts.length === 0) return null;
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  return texts.length === 1 ? parse(texts[0]!) : texts.map(parse);
}

export function toStructuredToolOutput(tool: string, response: CallToolResult): StructuredToolOutput {
  return {
    schemaVersion: TOOL_OUTPUT_SCHEMA_VERSION,
    tool,
    result: response.structuredContent ?? parseTextContent(response),
  };
}

/**
 * Return the minimal McpServer-compatible registration facade used by tool
 * modules. It injects a common `outputSchema` and wraps successful callbacks
 * with `structuredContent`; `isError` results keep their existing error contract.
 */
export function withStructuredToolOutputs(server: McpServer): McpServer {
  const registerTool = ((name: string, config: Record<string, unknown>, handler: AnyToolHandler) =>
    (server.registerTool as any)(
      name,
      { ...config, outputSchema: TOOL_OUTPUT_SCHEMA },
      async (...args: any[]) => {
        const response = await handler(...args);
        if (response.isError) return response;
        return {
          ...response,
          structuredContent: toStructuredToolOutput(name, response),
        };
      },
    )) as McpServer["registerTool"];

  return { registerTool } as unknown as McpServer;
}
