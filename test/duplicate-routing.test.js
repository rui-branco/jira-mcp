const { describe, it, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-mcp-duplicate-test-"));
const testConfigPath = path.join(testHome, ".config", "jira-mcp", "config.json");
fs.mkdirSync(path.dirname(testConfigPath), { recursive: true });
const initialConfig = {
  instances: [
    {
      name: "one",
      email: "one@example.com",
      token: "one-token",
      baseUrl: "https://one.atlassian.net",
      projects: ["DUP"],
    },
    {
      name: "two",
      email: "two@example.com",
      token: "two-token",
      baseUrl: "https://two.atlassian.net",
      projects: ["DUP"],
    },
    {
      name: "three",
      email: "three@example.com",
      token: "three-token",
      baseUrl: "https://three.atlassian.net",
      projects: [],
    },
  ],
  defaultInstance: "one",
  audit: { enabled: false },
  rateLimit: { enabled: false },
};
fs.writeFileSync(testConfigPath, JSON.stringify(initialConfig, null, 2));
process.env.HOME = testHome;
process.env.JIRA_MCP_CONFIG_PATH = testConfigPath;

const fetchMock = mock.fn(async (url) => {
  if (url.includes("/rest/api/3/user/search")) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(JSON.stringify([
        { displayName: "Test User", accountId: "account-1" },
      ])),
    };
  }
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve("{}"),
  };
});
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

describe("duplicate Jira project mappings", { concurrency: false }, () => {
  it("returns an ambiguity error for duplicate configured owners without probing", async () => {
    fetchMock.mock.resetCalls();

    const result = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "DUP-1",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /multiple|explicit/i);
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it("uses an explicit instance for a duplicate configured prefix", async () => {
    fetchMock.mock.resetCalls();

    const result = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "DUP-1",
      instance: "two",
    });

    assert.match(result.content[0].text, /Found 1 user/);
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.ok(fetchMock.mock.calls[0].arguments[0].startsWith("https://two.atlassian.net/rest/api/3/user/search"));
  });

  it("rejects jira_add_instance from introducing duplicate ownership", async () => {
    fetchMock.mock.resetCalls();
    const before = readConfig();

    const result = await callTool("jira_add_instance", {
      name: "three",
      projects: ["DUP"],
      defaultTeam: "none",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /already mapped|multiple/i);
    assert.deepStrictEqual(readConfig(), before);
    assert.equal(fetchMock.mock.calls.length, 0);
  });
});
