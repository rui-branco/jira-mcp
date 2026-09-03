const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-mcp-confluence-test-"));
const testConfigPath = path.join(testHome, ".config", "jira-mcp", "config.json");
fs.mkdirSync(path.dirname(testConfigPath), { recursive: true });

// Integration tests for the Confluence tools. These hit a real Atlassian
// Cloud instance and are skipped when credentials are not provided via env
// vars. Mirrors the pattern of the unit tests in index.test.js but without
// mocking node-fetch — we want real HTTP.
//
// Required env vars:
//   ATLASSIAN_EMAIL      — Atlassian account email
//   ATLASSIAN_TOKEN      — API token (same one used for Jira)
//   ATLASSIAN_BASE_URL   — e.g. https://company.atlassian.net
//
// Optional:
//   CONFLUENCE_TEST_PAGE_ID   — a real page id to fetch/comment on
//   CONFLUENCE_TEST_SPACE_KEY — space key used by search + scoped tests

const email = process.env.ATLASSIAN_EMAIL;
const token = process.env.ATLASSIAN_TOKEN;
const baseUrl = (process.env.ATLASSIAN_BASE_URL || "").replace(/\/$/, "");
const testPageId = process.env.CONFLUENCE_TEST_PAGE_ID;
const testSpaceKey = process.env.CONFLUENCE_TEST_SPACE_KEY;

const envReady = email && token && baseUrl;
fs.writeFileSync(testConfigPath, JSON.stringify({ email, token, baseUrl }));
process.env.HOME = testHome;
process.env.JIRA_MCP_CONFIG_PATH = testConfigPath;

after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

// index.js has module-level side effects (reads the Jira config file, kicks
// off an auto-update check). For integration runs we only need the exported
// helpers, so we stub the MCP SDK before requiring to avoid pulling a real
// server online.
if (envReady) {
  const mockServer = {
    setRequestHandler: () => {},
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
  const stdioPath = require.resolve(
    "@modelcontextprotocol/sdk/server/stdio.js",
  );
  require.cache[stdioPath] = {
    id: stdioPath,
    filename: stdioPath,
    loaded: true,
    exports: { StdioServerTransport: class {} },
  };
}

let fetchConfluence, textToConfluenceStorage;
if (envReady) {
  ({ fetchConfluence, textToConfluenceStorage } = require("../index.js"));
}

const instance = envReady
  ? {
      name: "integration",
      email,
      token,
      baseUrl,
      auth: Buffer.from(`${email}:${token}`).toString("base64"),
    }
  : null;

describe("Confluence integration", { skip: !envReady && "ATLASSIAN_EMAIL/ATLASSIAN_TOKEN/ATLASSIAN_BASE_URL not set" }, () => {
  it("confluence_get_spaces returns at least one global space", async () => {
    const result = await fetchConfluence(
      "/rest/api/space?type=global&limit=100",
      {},
      instance,
    );
    assert.ok(Array.isArray(result.results), "results array present");
    assert.ok(result.results.length > 0, "at least one space");
    const first = result.results[0];
    assert.ok(first.key && first.name && first.id, "space has key/name/id");
  });

  it("confluence_search returns CQL results", async () => {
    const safeQuery = "a";
    let cql = `text ~ "${safeQuery}" AND type = page`;
    if (testSpaceKey) cql += ` AND space = "${testSpaceKey}"`;
    cql += ` ORDER BY lastModified DESC`;
    const result = await fetchConfluence(
      `/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=5&expand=content.version,content.space,content.history.lastUpdated`,
      {},
      instance,
    );
    assert.ok(Array.isArray(result.results), "results array present");
    // Do not assert length — a brand-new test space may be empty.
  });

  it(
    "confluence_get_page merges v1 and v2 ADF",
    { skip: !testPageId && "CONFLUENCE_TEST_PAGE_ID not set" },
    async () => {
      const v1Path = `/rest/api/content/${encodeURIComponent(testPageId)}?expand=body.view,body.storage,version,space,ancestors,history.lastUpdated,metadata.labels`;
      const v2Path = `/api/v2/pages/${encodeURIComponent(testPageId)}?body-format=atlas_doc_format`;
      const [v1, v2] = await Promise.all([
        fetchConfluence(v1Path, {}, instance),
        fetchConfluence(v2Path, {}, instance).catch(() => null),
      ]);
      assert.equal(String(v1.id), String(testPageId));
      assert.ok(v1.body, "body present on v1");
      assert.ok(v1.body.storage, "body.storage present");
      assert.ok(v1.body.view, "body.view present");
      if (v2 && v2.body && v2.body.atlas_doc_format) {
        v1.body.atlas_doc_format = v2.body.atlas_doc_format;
        assert.ok(v1.body.atlas_doc_format.value, "merged ADF value present");
      }
    },
  );

  it(
    "confluence_get_comments lists comments",
    { skip: !testPageId && "CONFLUENCE_TEST_PAGE_ID not set" },
    async () => {
      const result = await fetchConfluence(
        `/rest/api/content/${encodeURIComponent(testPageId)}/child/comment?limit=10&depth=all&expand=body.view,version,history.createdBy,history.lastUpdated`,
        {},
        instance,
      );
      assert.ok(Array.isArray(result.results), "results array present");
    },
  );

  it(
    "confluence_add_comment posts a comment",
    { skip: !testPageId && "CONFLUENCE_TEST_PAGE_ID not set" },
    async () => {
      const value = textToConfluenceStorage(
        `Integration test comment @ ${new Date().toISOString()}\n\nSecond paragraph.`,
      );
      const body = {
        type: "comment",
        container: { id: testPageId, type: "page" },
        body: { storage: { value, representation: "storage" } },
      };
      const result = await fetchConfluence(
        "/rest/api/content",
        { method: "POST", body },
        instance,
      );
      assert.ok(result.id, "returned comment has id");
      assert.equal(result.type, "comment");

      // Best-effort cleanup so repeated runs don't pollute the test page.
      try {
        await fetchConfluence(
          `/rest/api/content/${encodeURIComponent(result.id)}`,
          { method: "DELETE" },
          instance,
        );
      } catch {
        /* leave the comment if delete is not permitted */
      }
    },
  );
});
