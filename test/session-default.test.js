const { describe, it, beforeEach, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-mcp-session-default-test-"));
const testConfigPath = path.join(testHome, ".config", "jira-mcp", "config.json");
fs.mkdirSync(path.dirname(testConfigPath), { recursive: true });
const itoPath = path.join(testHome, "work", "ito");
const itoAppPath = path.join(itoPath, "app");
fs.mkdirSync(itoAppPath, { recursive: true });

const initialConfig = {
  instances: [
    {
      name: "kone",
      email: "kone@example.com",
      token: "kone-token",
      baseUrl: "https://kone.atlassian.net",
      projects: ["MODS"],
    },
    {
      name: "ito",
      email: "ito@example.com",
      token: "ito-token",
      baseUrl: "https://ito.atlassian.net",
      projects: ["AI", "ITT", "IAS"],
      paths: [itoPath],
    },
  ],
  defaultInstance: "kone",
  audit: { enabled: false },
  rateLimit: { enabled: false },
};
fs.writeFileSync(testConfigPath, JSON.stringify(initialConfig, null, 2));
process.env.HOME = testHome;
process.env.JIRA_MCP_CONFIG_PATH = testConfigPath;
delete process.env.JIRA_MCP_INSTANCE;

// The server picks its session default from the working directory at startup.
const originalCwd = process.cwd();
process.chdir(itoAppPath);

const fetchMock = mock.fn();
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
  sendToolListChanged: () => Promise.resolve(),
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

const {
  resolveSessionDefault,
  resolveInstanceForTool,
} = require("../index.js");
const callToolHandler = toolHandlers.CallToolRequestSchema;

function readConfig() {
  return JSON.parse(fs.readFileSync(testConfigPath, "utf8"));
}

function response(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function fetchedUrls() {
  return fetchMock.mock.calls.map((call) => call.arguments[0]);
}

async function callTool(name, args) {
  return callToolHandler({ params: { name, arguments: args } });
}

beforeEach(() => {
  fetchMock.mock.resetCalls();
  fetchMock.mock.mockImplementation(async (url) => {
    if (url.includes("/user/search?")) return response([]);
    // Assignable in IAS only, as on the live ITO Jira.
    if (url.includes("/user/assignable/search?project=IAS&")) {
      return response([{ displayName: "Matthias Bauer", accountId: "account-mb" }]);
    }
    if (url.includes("/user/assignable/search?project=")) return response([]);
    return response({});
  });
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("resolveSessionDefault", () => {
  const kone = { name: "kone" };
  const ito = { name: "ito", paths: ["/work/ito"] };
  const team = { name: "team", paths: ["/work"] };

  it("uses the instance whose path equals the working directory", () => {
    const result = resolveSessionDefault([kone, ito], "kone", "/work/ito", {});
    assert.equal(result.instance, ito);
    assert.equal(result.source, "path");
    assert.equal(result.path, "/work/ito");
  });

  it("uses the instance whose path contains a nested working directory", () => {
    const result = resolveSessionDefault([kone, ito], "kone", "/work/ito/frontend/src", {});
    assert.equal(result.instance, ito);
    assert.equal(result.source, "path");
  });

  it("prefers the longest matching path regardless of instance order", () => {
    for (const list of [[kone, team, ito], [kone, ito, team]]) {
      assert.equal(resolveSessionDefault(list, "kone", "/work/ito/app", {}).instance, ito);
      assert.equal(resolveSessionDefault(list, "kone", "/work/other", {}).instance, team);
    }
  });

  it("does not match a sibling directory that only shares a name prefix", () => {
    const result = resolveSessionDefault([kone, ito], "kone", "/work/ito-agentspace", {});
    assert.equal(result.instance, kone);
    assert.equal(result.source, "config");
  });

  it("falls back to the config default outside every configured path", () => {
    const result = resolveSessionDefault([kone, ito], "kone", "/elsewhere/project", {});
    assert.equal(result.instance, kone);
    assert.equal(result.source, "config");
  });

  it("falls back to the first instance when the config default is missing or unknown", () => {
    assert.equal(resolveSessionDefault([ito, kone], undefined, "/elsewhere", {}).instance, ito);
    assert.equal(resolveSessionDefault([ito, kone], "gone", "/elsewhere", {}).instance, ito);
  });

  it("expands ~ in configured paths (process.env.HOME is testHome here)", () => {
    const home = { name: "home", paths: ["~/work/ito"] };
    const result = resolveSessionDefault([kone, home], "kone", itoAppPath, {});
    assert.equal(result.instance, home);
    assert.equal(result.path, fs.realpathSync(itoPath));
  });

  it("ignores relative configured paths", () => {
    const relative = { name: "relative", paths: ["work/ito"] };
    const result = resolveSessionDefault([kone, relative], "kone", "/work/ito", {});
    assert.equal(result.instance, kone);
  });

  it("lets JIRA_MCP_INSTANCE win over a matching path", () => {
    const result = resolveSessionDefault([kone, ito], "kone", "/work/ito", {
      JIRA_MCP_INSTANCE: "kone",
    });
    assert.equal(result.instance, kone);
    assert.equal(result.source, "env");
  });

  it("ignores an unknown JIRA_MCP_INSTANCE and reports it", () => {
    const result = resolveSessionDefault([kone, ito], "kone", "/work/ito", {
      JIRA_MCP_INSTANCE: "missing",
    });
    assert.equal(result.instance, ito);
    assert.equal(result.source, "path");
    assert.equal(result.ignoredEnv, "missing");
  });
});

describe("session default from the working directory", { concurrency: false }, () => {
  it("uses the path-matched instance at startup without rewriting the config default", async () => {
    const instance = await resolveInstanceForTool("jira_search_users", { query: "x" });
    assert.equal(instance.name, "ito");
    assert.equal(readConfig().defaultInstance, "kone");
  });

  it("routes keyless tools to the session default", async () => {
    const result = await callTool("jira_search", { jql: "project = IAS" });

    assert.equal(result.isError, undefined);
    assert.ok(fetchedUrls()[0].startsWith("https://ito.atlassian.net/rest/api/3/search/jql"));
  });

  it("still routes keyed tools by project prefix", async () => {
    await callTool("jira_search_users", { query: "Julia", issueKey: "MODS-1" });

    assert.ok(fetchedUrls().every((url) => url.startsWith("https://kone.atlassian.net/")));
  });

  it("falls back to per-project assignable search over the session instance's projects in jira_search_users", async () => {
    const result = await callTool("jira_search_users", { query: "Matthias" });

    assert.match(result.content[0].text, /Found 1 user\(s\)/);
    assert.match(result.content[0].text, /Matthias Bauer/);
    assert.deepStrictEqual(fetchedUrls(), [
      "https://ito.atlassian.net/rest/api/3/user/search?query=Matthias&maxResults=5",
      "https://ito.atlassian.net/rest/api/3/user/assignable/search?project=AI&query=Matthias&maxResults=5",
      "https://ito.atlassian.net/rest/api/3/user/assignable/search?project=ITT&query=Matthias&maxResults=5",
      "https://ito.atlassian.net/rest/api/3/user/assignable/search?project=IAS&query=Matthias&maxResults=5",
    ]);
  });

  it("shows the session default and why in jira_list_instances", async () => {
    const result = await callTool("jira_list_instances", {});
    const text = result.content[0].text;

    assert.ok(
      text.includes(
        `Session default: **ito** (from path ${fs.realpathSync(itoPath)} (working directory ${process.cwd()})). Config default: kone.`,
      ),
    );
    assert.ok(text.includes("- **ito** **(default)**: https://ito.atlassian.net"));
    assert.ok(text.includes("- **kone** (config default): https://kone.atlassian.net"));
    assert.ok(text.includes(`Paths: ${itoPath}`));
  });

  it("keeps the path-based session default after jira_add_instance changes the config default", async () => {
    const result = await callTool("jira_add_instance", {
      name: "extra",
      email: "extra@example.com",
      token: "extra-token",
      baseUrl: "https://extra.atlassian.net",
      setDefault: true,
      defaultTeam: "none",
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Set as default\. This session keeps using "ito" \(from path /);
    assert.equal(readConfig().defaultInstance, "extra");
    assert.equal((await resolveInstanceForTool("jira_search", {})).name, "ito");

    const list = (await callTool("jira_list_instances", {})).content[0].text;
    assert.match(list, /Session default: \*\*ito\*\* \(from path .*Config default: extra\./);
  });

  it("falls back to the config default when the path-matched instance is removed", async () => {
    const result = await callTool("jira_remove_instance", { name: "ito" });

    assert.equal(result.isError, undefined);
    assert.equal((await resolveInstanceForTool("jira_search", {})).name, "extra");

    const list = (await callTool("jira_list_instances", {})).content[0].text;
    assert.ok(
      list.includes("Session default: **extra** (from config defaultInstance). Config default: extra."),
    );
  });
});
