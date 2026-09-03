const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-mcp-routing-test-"));
const testConfigPath = path.join(testHome, ".config", "jira-mcp", "config.json");
fs.mkdirSync(path.dirname(testConfigPath), { recursive: true });

const initialConfig = {
  instances: [
    {
      name: "one",
      email: "one@example.com",
      token: "one-token",
      baseUrl: "https://one.atlassian.net",
      projects: [],
      scopes: { preset: "unrestricted" },
      dryRun: true,
      defaultTeam: { name: "One Team", id: "one-team" },
      projectTeams: { OLD: { name: "Old Team", id: "old-team" } },
      confluenceBaseUrl: "https://one.example.com/wiki",
    },
    {
      name: "two",
      email: "two@example.com",
      token: "two-token",
      baseUrl: "https://two.atlassian.net",
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

const projectResponses = new Map();
let delayProjectResponses = false;
const fetchMock = require("node:test").mock.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve("{}"),
  }),
);
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
  extractRoutingPrefixes,
  resolveInstanceForTool,
} = require("../index.js");
const callToolHandler = toolHandlers.CallToolRequestSchema;

function readConfig() {
  return JSON.parse(fs.readFileSync(testConfigPath, "utf8"));
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Server Error",
    text: () => Promise.resolve(
      typeof body === "string" ? body : JSON.stringify(body === undefined ? {} : body),
    ),
  };
}

function projectPrefixFromUrl(url) {
  const marker = "/rest/api/3/project/";
  if (!url.includes(marker)) return null;
  return decodeURIComponent(url.substring(url.indexOf(marker) + marker.length));
}

function instanceNameFromUrl(url) {
  if (url.startsWith("https://one.atlassian.net")) return "one";
  if (url.startsWith("https://two.atlassian.net")) return "two";
  return null;
}

function setDefaultFetch() {
  projectResponses.clear();
  delayProjectResponses = false;
  fetchMock.mock.mockImplementation(async (url) => {
    const prefix = projectPrefixFromUrl(url);
    if (prefix) {
      const configured = projectResponses.get(`${instanceNameFromUrl(url)}:${prefix}`);
      if (configured) {
        if (delayProjectResponses) await new Promise((resolve) => setTimeout(resolve, 5));
        return response(configured.status, configured.body);
      }
      return response(404);
    }
    if (url.includes("/rest/api/3/user/search")) {
      return response(200, [
        { displayName: "Test User", accountId: "account-1" },
      ]);
    }
    if (url.includes("/rest/api/3/issue/") && url.includes("expand=changelog")) {
      return response(200, {
        fields: { created: "2026-01-01T00:00:00.000+0000" },
        changelog: { histories: [] },
      });
    }
    if (url.includes("/rest/api/space/")) {
      return response(200, {
        name: "Test Space",
        key: "SPACE",
        id: "1",
        type: "global",
      });
    }
    return response(200, {});
  });
}

function setProjectResponse(prefix, instanceName, status, body = { key: prefix }) {
  projectResponses.set(`${instanceName}:${prefix}`, { status, body });
}

async function callTool(name, args) {
  return callToolHandler({ params: { name, arguments: args } });
}

beforeEach(() => {
  fetchMock.mock.resetCalls();
  setDefaultFetch();
});

after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("dynamic Jira project routing", { concurrency: false }, () => {
  it("discovers one instance, persists uppercase prefixes, and uses the learned route immediately", async () => {
    setProjectResponse("LEARN", "one", 200);

    const firstResult = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "learn-1",
    });

    assert.match(firstResult.content[0].text, /Found 1 user/);
    const firstCalls = fetchMock.mock.calls.map((call) => call.arguments[0]);
    assert.equal(firstCalls[0], "https://one.atlassian.net/rest/api/3/project/LEARN");
    assert.equal(firstCalls[1], "https://two.atlassian.net/rest/api/3/project/LEARN");
    assert.ok(firstCalls[2].startsWith("https://one.atlassian.net/rest/api/3/user/search"));
    assert.deepStrictEqual(readConfig().instances[0].projects, ["LEARN"]);

    fetchMock.mock.resetCalls();
    setDefaultFetch();
    const secondResult = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "learn-2",
    });

    assert.match(secondResult.content[0].text, /Found 1 user/);
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.ok(fetchMock.mock.calls[0].arguments[0].startsWith("https://one.atlassian.net/rest/api/3/user/search"));
    assert.deepStrictEqual(readConfig().instances[0].projects, ["LEARN"]);
  });

  it("discovers a project key context", async () => {
    setProjectResponse("PROJKEY", "two", 200);

    const result = await callTool("jira_search_users", {
      query: "Test",
      projectKey: "projkey",
    });

    assert.match(result.content[0].text, /Found 1 user/);
    const urls = fetchMock.mock.calls.map((call) => call.arguments[0]);
    assert.equal(urls[0], "https://one.atlassian.net/rest/api/3/project/PROJKEY");
    assert.equal(urls[1], "https://two.atlassian.net/rest/api/3/project/PROJKEY");
    assert.ok(urls[2].startsWith("https://two.atlassian.net/rest/api/3/user/search"));
    assert.ok(readConfig().instances[1].projects.includes("PROJKEY"));
  });

  it("returns a clear not-found error for zero matches", async () => {
    const result = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "MISSING-1",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not found/i);
    assert.equal(fetchMock.mock.calls.length, 2);
    assert.equal(readConfig().instances.some((instance) => instance.projects.includes("MISSING")), false);
  });

  it("returns an ambiguity error for multiple accessible matches", async () => {
    setProjectResponse("AMBIG", "one", 200);
    setProjectResponse("AMBIG", "two", 200);

    const result = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "AMBIG-1",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /multiple|explicit/i);
    assert.equal(readConfig().instances.some((instance) => instance.projects.includes("AMBIG")), false);
  });

  it("returns a permission error when every candidate is inaccessible", async () => {
    setProjectResponse("PRIVATE", "one", 401);
    setProjectResponse("PRIVATE", "two", 403);

    const result = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "PRIVATE-1",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /permission|denied|access/i);
    assert.equal(readConfig().instances.some((instance) => instance.projects.includes("PRIVATE")), false);
  });

  it("validates and persists an unmapped prefix on only the explicit instance", async () => {
    setProjectResponse("EXPLICIT", "two", 200);

    const result = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "explicit-1",
      instance: "two",
    });

    assert.match(result.content[0].text, /Found 1 user/);
    const urls = fetchMock.mock.calls.map((call) => call.arguments[0]);
    assert.equal(urls[0], "https://two.atlassian.net/rest/api/3/project/EXPLICIT");
    assert.equal(urls.filter((url) => projectPrefixFromUrl(url) === "EXPLICIT").length, 1);
    assert.ok(urls[1].startsWith("https://two.atlassian.net/rest/api/3/user/search"));
    assert.ok(readConfig().instances[1].projects.includes("EXPLICIT"));
  });

  it("fails closed when another instance returns 403 during discovery", async () => {
    setProjectResponse("PARTIAL", "one", 200);
    setProjectResponse("PARTIAL", "two", 403);

    const result = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "partial-1",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /permission|denied|access/i);
    const urls = fetchMock.mock.calls.map((call) => call.arguments[0]);
    assert.equal(urls[0], "https://one.atlassian.net/rest/api/3/project/PARTIAL");
    assert.equal(urls[1], "https://two.atlassian.net/rest/api/3/project/PARTIAL");
    assert.equal(urls.some((url) => url.includes("/user/search")), false);
    assert.equal(readConfig().instances[0].projects.includes("PARTIAL"), false);
    assert.equal(readConfig().instances[1].projects.includes("PARTIAL"), false);
  });

  it("does not fall back when project discovery returns a 5xx error", async () => {
    setProjectResponse("SERVERFAIL", "one", 500);
    setProjectResponse("SERVERFAIL", "two", 200);

    const result = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "serverfail-1",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /failed|500/i);
    assert.equal(fetchMock.mock.calls.some((call) => call.arguments[0].includes("/user/search")), false);
    assert.equal(readConfig().instances.some((instance) => instance.projects.includes("SERVERFAIL")), false);
  });

  it("does not fall back when project discovery returns a malformed response", async () => {
    setProjectResponse("MALFORMED", "one", 200, "not-json");
    setProjectResponse("MALFORMED", "two", 200);

    const result = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "malformed-1",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /malformed|failed/i);
    assert.equal(fetchMock.mock.calls.some((call) => call.arguments[0].includes("/user/search")), false);
    assert.equal(readConfig().instances.some((instance) => instance.projects.includes("MALFORMED")), false);
  });

  it("rejects an unknown explicit instance without probing", async () => {
    const result = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "UNKNOWNINSTANCE-1",
      instance: "missing",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Instance "missing" not found/);
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it("rejects keys that resolve to different instances before dispatch", async () => {
    setProjectResponse("CROSSA", "one", 200);
    setProjectResponse("CROSSB", "two", 200);

    const result = await callTool("jira_link_tickets", {
      inwardIssueKey: "CROSSA-1",
      outwardIssueKey: "CROSSB-1",
      linkType: "Relates",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /different instances|same Jira instance/i);
    assert.equal(fetchMock.mock.calls.some((call) => call.arguments[0].includes("/issueLink")), false);
  });

  it("rejects unlinking cross-instance source and linked issues before mutation", async () => {
    setProjectResponse("UNLINKA", "one", 200);
    setProjectResponse("UNLINKB", "two", 200);

    const result = await callTool("jira_unlink_tickets", {
      issueKey: "UNLINKA-1",
      linkedIssueKey: "UNLINKB-1",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /different instances|same Jira instance/i);
    assert.equal(fetchMock.mock.calls.some((call) => call.arguments[0].includes("/issue/")), false);
  });

  it("rejects cloning across source and target instances before mutation", async () => {
    setProjectResponse("CLONEA", "one", 200);
    setProjectResponse("CLONEB", "two", 200);

    const result = await callTool("jira_clone_ticket", {
      issueKey: "CLONEA-1",
      targetProjectKey: "CLONEB",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /different instances|same Jira instance/i);
    assert.equal(fetchMock.mock.calls.some((call) => call.arguments[0].includes("/issue/")), false);
  });

  it("does not discover Confluence space keys or configuration project keys", async () => {
    const confluenceResult = await callTool("confluence_get_space", { spaceKey: "SPACE" });
    assert.match(confluenceResult.content[0].text, /Test Space/);
    assert.equal(fetchMock.mock.calls.some((call) => projectPrefixFromUrl(call.arguments[0])), false);

    assert.deepStrictEqual(
      extractRoutingPrefixes("jira_add_instance", { projectKey: "CONFIGFIELD" }),
      [],
    );
    const configResolver = await resolveInstanceForTool("jira_add_instance", {
      projectKey: "CONFIGFIELD",
    });
    assert.equal(configResolver.name, "one");
    assert.equal(fetchMock.mock.calls.some((call) => projectPrefixFromUrl(call.arguments[0])), false);
  });

  it("preserves configured fields while adding a discovered prefix", async () => {
    setProjectResponse("PRESERVE", "one", 200);

    await callTool("jira_search_users", {
      query: "Test",
      issueKey: "preserve-1",
    });

    const saved = readConfig().instances.find((instance) => instance.name === "one");
    assert.deepStrictEqual(saved.scopes, { preset: "unrestricted" });
    assert.equal(saved.dryRun, true);
    assert.deepStrictEqual(saved.defaultTeam, { name: "One Team", id: "one-team" });
    assert.deepStrictEqual(saved.projectTeams, { OLD: { name: "Old Team", id: "old-team" } });
    assert.equal(saved.confluenceBaseUrl, "https://one.example.com/wiki");
    assert.equal(saved.email, "one@example.com");
    assert.equal(saved.token, "one-token");
  });

  it("preserves the config file permission mode when adding a discovered prefix", async () => {
    const expectedMode = 0o640;
    let modeSupported = true;
    try {
      fs.chmodSync(testConfigPath, expectedMode);
      modeSupported = (fs.statSync(testConfigPath).mode & 0o7777) === expectedMode;
    } catch (error) {
      if (["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
        modeSupported = false;
      } else {
        throw error;
      }
    }

    setProjectResponse("MODE", "one", 200);
    const result = await callTool("jira_search_users", {
      query: "Test",
      issueKey: "mode-1",
    });

    assert.equal(result.isError, undefined);
    if (modeSupported) {
      assert.equal(fs.statSync(testConfigPath).mode & 0o7777, expectedMode);
    }
  });

  it("serializes concurrent prefix persistence without losing either mapping", async () => {
    setProjectResponse("CONCURRENT_A", "one", 200);
    setProjectResponse("CONCURRENT_B", "one", 200);
    delayProjectResponses = true;

    const results = await Promise.all([
      callTool("jira_search_users", { query: "A", issueKey: "concurrent_a-1" }),
      callTool("jira_search_users", { query: "B", issueKey: "concurrent_b-1" }),
    ]);

    assert.equal(results.every((result) => !result.isError), true);
    const projects = readConfig().instances.find((instance) => instance.name === "one").projects;
    assert.ok(projects.includes("CONCURRENT_A"));
    assert.ok(projects.includes("CONCURRENT_B"));
  });

  it("routes changelog requests to the explicit instance", async () => {
    setProjectResponse("CHANGEEXPLICIT", "two", 200);

    const result = await callTool("jira_get_changelog", {
      issueKey: "changeexplicit-1",
      instance: "two",
    });

    assert.equal(result.isError, undefined);
    const issueCall = fetchMock.mock.calls.find((call) => call.arguments[0].includes("/issue/changeexplicit-1"));
    assert.ok(issueCall);
    assert.ok(issueCall.arguments[0].startsWith("https://two.atlassian.net"));
  });

  it("routes discovered changelog requests to the discovered instance", async () => {
    setProjectResponse("CHANGEDISCOVERED", "one", 200);

    const result = await callTool("jira_get_changelog", {
      issueKey: "changediscovered-1",
    });

    assert.equal(result.isError, undefined);
    const issueCall = fetchMock.mock.calls.find((call) => call.arguments[0].includes("/issue/changediscovered-1"));
    assert.ok(issueCall);
    assert.ok(issueCall.arguments[0].startsWith("https://one.atlassian.net"));
  });

  it("extracts only Jira routing fields and ignores excluded contexts", () => {
    assert.deepStrictEqual(
      extractRoutingPrefixes("jira_link_tickets", {
        issueKey: "ONE-1",
        parentKey: "TWO-2",
        inwardIssueKey: "ONE-3",
        outwardIssueKey: "ONE-4",
        linkedIssueKey: "ONE-7",
        projectKey: "ONE",
        projectKeyOrId: "TWO",
        targetProjectKey: "TWO",
        spaceKey: "THREE",
        issueKeys: ["ONE-5", "ONE-6"],
      }),
      ["ONE", "TWO"],
    );
    assert.deepStrictEqual(
      extractRoutingPrefixes("confluence_get_space", { spaceKey: "SPACE" }),
      [],
    );
    assert.deepStrictEqual(
      extractRoutingPrefixes("jira_add_instance", { projectKey: "CONFIG" }),
      [],
    );
    assert.deepStrictEqual(
      extractRoutingPrefixes("jira_get_boards", { projectKeyOrId: "12345" }),
      [],
    );
  });
});
