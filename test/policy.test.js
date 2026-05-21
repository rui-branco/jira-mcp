const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Same mock-injection scaffold as index.test.js so requiring index.js does
// not start an MCP server or hit the network.
const fetchMock = mock.fn(() =>
  Promise.resolve({
    ok: true,
    text: () => Promise.resolve("{}"),
    json: () => Promise.resolve({}),
  }),
);
require.cache[require.resolve("node-fetch")] = {
  id: require.resolve("node-fetch"),
  filename: require.resolve("node-fetch"),
  loaded: true,
  exports: fetchMock,
};

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
const stdioPath = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
require.cache[stdioPath] = {
  id: stdioPath,
  filename: stdioPath,
  loaded: true,
  exports: { StdioServerTransport: class {} },
};

const {
  TOOL_METADATA,
  checkScope,
  resolveDryRun,
  scrubArgs,
  extractTarget,
  checkRateLimit,
  _setClockForTests,
  _resetBucketsForTests,
  _injectDryRunSchema,
} = require("../index.js");

// ============ TOOL_METADATA completeness ============

describe("TOOL_METADATA", () => {
  it("classifies every entry as read/write/destructive", () => {
    for (const [name, meta] of Object.entries(TOOL_METADATA)) {
      assert.ok(
        ["read", "write", "destructive"].includes(meta.op),
        `${name} has invalid op: ${meta.op}`,
      );
      assert.ok(
        ["jira", "confluence"].includes(meta.product),
        `${name} has invalid product: ${meta.product}`,
      );
    }
  });

  it("classifies all destructive tools correctly", () => {
    const destructive = Object.entries(TOOL_METADATA)
      .filter(([, m]) => m.op === "destructive")
      .map(([name]) => name)
      .sort();
    assert.deepStrictEqual(destructive, [
      "confluence_delete_page",
      "confluence_delete_space",
      "jira_delete_comment",
      "jira_delete_ticket",
      "jira_remove_attachment",
      "jira_remove_instance",
    ]);
  });

  it("classifies jira_search as a read (not a write) even though the API endpoint is POST", () => {
    assert.equal(TOOL_METADATA.jira_search.op, "read");
  });
});

// ============ Scopes ============

describe("checkScope", () => {
  it("fails open when instance has no scopes block (backwards compat)", () => {
    const inst = { name: "default" };
    assert.equal(checkScope("jira_delete_ticket", inst).allowed, true);
    assert.equal(checkScope("confluence_delete_page", inst).allowed, true);
  });

  it("read-only preset allows reads, blocks writes and destructives", () => {
    const inst = { name: "ro", scopes: { preset: "read-only" } };
    assert.equal(checkScope("jira_get_ticket", inst).allowed, true);
    assert.equal(checkScope("jira_search", inst).allowed, true);
    assert.equal(checkScope("jira_add_comment", inst).allowed, false);
    assert.equal(checkScope("jira_delete_ticket", inst).allowed, false);
    assert.equal(checkScope("confluence_get_page", inst).allowed, true);
    assert.equal(checkScope("confluence_delete_page", inst).allowed, false);
  });

  it("comments-only preset allows reads and comment tools", () => {
    const inst = { name: "co", scopes: { preset: "comments-only" } };
    assert.equal(checkScope("jira_add_comment", inst).allowed, true);
    assert.equal(checkScope("jira_edit_comment", inst).allowed, true);
    assert.equal(checkScope("confluence_add_comment", inst).allowed, true);
    assert.equal(checkScope("jira_get_ticket", inst).allowed, true);
    assert.equal(checkScope("jira_update_ticket", inst).allowed, false);
    assert.equal(checkScope("jira_delete_comment", inst).allowed, false);
  });

  it("no-destructive preset blocks only destructives", () => {
    const inst = { name: "nd", scopes: { preset: "no-destructive" } };
    assert.equal(checkScope("jira_update_ticket", inst).allowed, true);
    assert.equal(checkScope("jira_add_comment", inst).allowed, true);
    assert.equal(checkScope("jira_delete_ticket", inst).allowed, false);
    assert.equal(checkScope("jira_remove_attachment", inst).allowed, false);
  });

  it("explicit deny wins over preset", () => {
    const inst = {
      name: "x",
      scopes: { preset: "unrestricted", deny: ["jira_delete_ticket"] },
    };
    assert.equal(checkScope("jira_update_ticket", inst).allowed, true);
    assert.equal(checkScope("jira_delete_ticket", inst).allowed, false);
  });

  it("explicit allow overrides absent preset", () => {
    const inst = {
      name: "x",
      scopes: { allow: ["jira_add_comment"] },
    };
    assert.equal(checkScope("jira_add_comment", inst).allowed, true);
    assert.equal(checkScope("jira_update_ticket", inst).allowed, false);
  });

  it("fails closed for unknown tool when scopes block exists", () => {
    const inst = { name: "x", scopes: { preset: "unrestricted" } };
    const r = checkScope("jira_made_up_tool", inst);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /no metadata/);
  });

  it("rejects unknown preset name", () => {
    const inst = { name: "x", scopes: { preset: "nope" } };
    const r = checkScope("jira_get_ticket", inst);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /Unknown scope preset/);
  });
});

// ============ Dry-run resolution ============

describe("resolveDryRun", () => {
  it("returns false for read ops regardless of flags", () => {
    assert.equal(
      resolveDryRun("jira_get_ticket", { dryRun: true }, { dryRun: true }),
      false,
    );
  });

  it("returns true when per-call arg dryRun=true on a write tool", () => {
    assert.equal(
      resolveDryRun("jira_add_comment", { dryRun: true }, {}),
      true,
    );
  });

  it("per-call false overrides config true", () => {
    assert.equal(
      resolveDryRun("jira_add_comment", { dryRun: false }, { dryRun: true }),
      false,
    );
  });

  it("falls back to instance config when per-call is absent", () => {
    assert.equal(
      resolveDryRun("jira_add_comment", {}, { dryRun: true }),
      true,
    );
  });

  it("returns false for unknown tools (cannot prove safe)", () => {
    assert.equal(
      resolveDryRun("jira_made_up", { dryRun: true }, {}),
      false,
    );
  });
});

// ============ Audit scrubbing ============

describe("scrubArgs", () => {
  it("redacts token-like keys", () => {
    const scrubbed = scrubArgs({
      issueKey: "PROJ-1",
      token: "ATATT3xFfGF0...",
      Authorization: "Basic xyz",
      password: "hunter2",
      apiKey: "abc",
      api_key: "abc",
    });
    assert.equal(scrubbed.issueKey, "PROJ-1");
    assert.equal(scrubbed.token, "[REDACTED]");
    assert.equal(scrubbed.Authorization, "[REDACTED]");
    assert.equal(scrubbed.password, "[REDACTED]");
    assert.equal(scrubbed.apiKey, "[REDACTED]");
    assert.equal(scrubbed.api_key, "[REDACTED]");
  });

  it("redacts fileContent (base64 attachments)", () => {
    const scrubbed = scrubArgs({ fileName: "x.png", fileContent: "iVBOR..." });
    assert.equal(scrubbed.fileName, "x.png");
    assert.equal(scrubbed.fileContent, "[REDACTED]");
  });

  it("scrubs nested objects", () => {
    const scrubbed = scrubArgs({
      fields: { summary: "hi", token: "secret" },
    });
    assert.equal(scrubbed.fields.summary, "hi");
    assert.equal(scrubbed.fields.token, "[REDACTED]");
  });

  it("truncates very long strings", () => {
    const scrubbed = scrubArgs({ body: "x".repeat(5000) });
    assert.match(scrubbed.body, /\[truncated 1000 chars\]$/);
  });

  it("handles null and primitives", () => {
    assert.equal(scrubArgs(null), null);
    assert.equal(scrubArgs("str"), "str");
    assert.equal(scrubArgs(42), 42);
  });
});

// ============ extractTarget ============

describe("extractTarget", () => {
  it("prefers issueKey", () => {
    assert.equal(extractTarget({ issueKey: "PROJ-1", pageId: "999" }), "PROJ-1");
  });
  it("falls back to pageId", () => {
    assert.equal(extractTarget({ pageId: "999" }), "999");
  });
  it("returns undefined for empty args", () => {
    assert.equal(extractTarget({}), undefined);
    assert.equal(extractTarget(null), undefined);
  });
});

// ============ Rate limiter ============

describe("checkRateLimit", () => {
  let now;

  beforeEach(() => {
    now = 1_700_000_000_000;
    _setClockForTests(() => now);
    _resetBucketsForTests();
  });

  afterEach(() => {
    _setClockForTests(() => Date.now());
    _resetBucketsForTests();
  });

  const inst = { name: "default" };

  it("read tools always allowed (bypass)", () => {
    for (let i = 0; i < 1000; i++) {
      assert.equal(checkRateLimit("jira_get_ticket", inst).allowed, true);
    }
  });

  it("blocks per-instance write floods", () => {
    // Default per-instance limit is 30/min.
    let denied = 0;
    for (let i = 0; i < 40; i++) {
      const r = checkRateLimit("jira_add_comment", inst);
      if (!r.allowed) denied++;
    }
    assert.ok(denied > 0, "expected some calls to be rate-limited");
  });

  it("destructive tools have a tighter bucket", () => {
    // Default destructive is 5/min. After 5 calls the 6th should hit the
    // destructive bucket specifically.
    let lastDeniedBucket = null;
    for (let i = 0; i < 10; i++) {
      const r = checkRateLimit("jira_delete_ticket", inst);
      if (!r.allowed) lastDeniedBucket = r.bucket;
    }
    assert.equal(lastDeniedBucket, "destructive");
  });

  it("refills tokens over time", () => {
    // Burn the destructive bucket.
    for (let i = 0; i < 5; i++) {
      checkRateLimit("jira_delete_ticket", inst);
    }
    assert.equal(checkRateLimit("jira_delete_ticket", inst).allowed, false);

    // Advance clock 60 seconds — bucket should fully refill.
    now += 60_000;
    assert.equal(checkRateLimit("jira_delete_ticket", inst).allowed, true);
  });

  it("returns retryAfter when blocked", () => {
    for (let i = 0; i < 5; i++) checkRateLimit("jira_delete_ticket", inst);
    const r = checkRateLimit("jira_delete_ticket", inst);
    assert.equal(r.allowed, false);
    assert.ok(typeof r.retryAfter === "number" && r.retryAfter > 0);
  });
});

// ============ Dry-run schema injection ============

describe("_injectDryRunSchema", () => {
  it("adds dryRun property to mutating tool schemas", () => {
    const tool = {
      name: "jira_add_comment",
      inputSchema: {
        type: "object",
        properties: { issueKey: { type: "string" } },
        required: ["issueKey"],
      },
    };
    const result = _injectDryRunSchema(tool);
    assert.ok(result.inputSchema.properties.dryRun);
    assert.equal(result.inputSchema.properties.dryRun.type, "boolean");
    // Existing properties preserved
    assert.ok(result.inputSchema.properties.issueKey);
    // Required list unchanged (dryRun is optional)
    assert.deepStrictEqual(result.inputSchema.required, ["issueKey"]);
  });

  it("does NOT add dryRun to read tools", () => {
    const tool = {
      name: "jira_get_ticket",
      inputSchema: { type: "object", properties: { issueKey: { type: "string" } } },
    };
    const result = _injectDryRunSchema(tool);
    assert.equal(result.inputSchema.properties.dryRun, undefined);
  });

  it("is idempotent (does not double-add if dryRun already exists)", () => {
    const tool = {
      name: "jira_add_comment",
      inputSchema: {
        type: "object",
        properties: { dryRun: { type: "boolean", description: "custom" } },
      },
    };
    const result = _injectDryRunSchema(tool);
    assert.equal(result.inputSchema.properties.dryRun.description, "custom");
  });
});
