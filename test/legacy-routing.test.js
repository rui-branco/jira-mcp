const { describe, it, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-mcp-legacy-test-"));
const testConfigPath = path.join(testHome, ".config", "jira-mcp", "config.json");
fs.mkdirSync(path.dirname(testConfigPath), { recursive: true });
fs.writeFileSync(testConfigPath, JSON.stringify({
  email: "legacy@example.com",
  token: "legacy-token",
  baseUrl: "https://legacy.atlassian.net",
  projects: [" old ", "OLD", "legacy"],
  scopes: { preset: "unrestricted" },
  dryRun: true,
  defaultTeam: { name: "Legacy Team", id: "legacy-team" },
  projectTeams: { OLD: "none" },
  confluenceBaseUrl: "https://legacy.example.com/wiki",
}, null, 2), { mode: 0o600 });
process.env.HOME = testHome;
process.env.JIRA_MCP_CONFIG_PATH = testConfigPath;

const fetchMock = mock.fn(async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: () => Promise.resolve("{}"),
}));
require.cache[require.resolve("node-fetch")] = {
  id: require.resolve("node-fetch"),
  filename: require.resolve("node-fetch"),
  loaded: true,
  exports: fetchMock,
};

const toolHandlers = {};
const mockServer = {
  setRequestHandler: (schema, handler) => {
    toolHandlers[schema] = handler;
  },
  connect: () => Promise.resolve(),
};
const sdkPath = require.resolve("@modelcontextprotocol/sdk/server/index.js");
require.cache[sdkPath] = {
  id: sdkPath,
  filename: sdkPath,
  loaded: true,
  exports: {
    Server: class {
      constructor() {
        return mockServer;
      }
    },
  },
};
const sdkTypesPath = require.resolve("@modelcontextprotocol/sdk/types.js");
require.cache[sdkTypesPath] = {
  id: sdkTypesPath,
  filename: sdkTypesPath,
  loaded: true,
  exports: {
    ListToolsRequestSchema: "ListToolsRequestSchema",
    CallToolRequestSchema: "CallToolRequestSchema",
  },
};
const stdioPath = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
require.cache[stdioPath] = {
  id: stdioPath,
  filename: stdioPath,
  loaded: true,
  exports: { StdioServerTransport: class {} },
};

require("../index.js");
const callToolHandler = toolHandlers.CallToolRequestSchema;

function readConfig() {
  return JSON.parse(fs.readFileSync(testConfigPath, "utf8"));
}

async function callTool(name, args) {
  return callToolHandler({ params: { name, arguments: args } });
}

after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("legacy Jira configuration migration", { concurrency: false }, () => {
  it("preserves top-level projects and instance fields when MCP adds an instance", async () => {
    const result = await callTool("jira_add_instance", {
      name: "new",
      email: "new@example.com",
      token: "new-token",
      baseUrl: "https://new.atlassian.net",
      projects: ["NEW"],
      defaultTeam: "none",
    });

    assert.equal(result.isError, undefined);
    const config = readConfig();
    assert.equal(config.projects, undefined);
    assert.deepStrictEqual(config.instances[0].projects, ["OLD", "LEGACY"]);
    assert.deepStrictEqual(config.instances[0].scopes, { preset: "unrestricted" });
    assert.equal(config.instances[0].dryRun, true);
    assert.deepStrictEqual(config.instances[0].defaultTeam, { name: "Legacy Team", id: "legacy-team" });
    assert.deepStrictEqual(config.instances[0].projectTeams, { OLD: "none" });
    assert.equal(config.instances[0].confluenceBaseUrl, "https://legacy.example.com/wiki");
    assert.deepStrictEqual(config.instances[1].projects, ["NEW"]);
  });
});
