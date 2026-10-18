// Canonical OpenCode `read` tool (same schema as opencode_tools.json).
export const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file from the local filesystem.",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The absolute path to the file to read.",
        },
        offset: {
          type: "integer",
          description: "Line offset to start reading from.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of lines to read.",
        },
      },
      required: ["filePath"],
    },
  },
} as const
