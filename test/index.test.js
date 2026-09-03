const { describe, it, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");

// Mock node-fetch before requiring index.js
// This prevents the MCP server from making real HTTP calls
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

// Mock the MCP SDK to prevent server startup issues
// Capture tool handlers so we can invoke them in tests
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
const stdioPath = require.resolve(
  "@modelcontextprotocol/sdk/server/stdio.js",
);
require.cache[stdioPath] = {
  id: stdioPath,
  filename: stdioPath,
  loaded: true,
  exports: { StdioServerTransport: class {} },
};

const { buildCommentADF, parseInlineFormatting, autoLinkTextNodes, findJiraTicketKeys, resolveTeamId, fetchJiraTeams, listTeams, searchTeamsViaJql } = require("../index.js");

const fakeInstance = { baseUrl: "https://test.atlassian.net" };

// ============ parseInlineFormatting ============

describe("parseInlineFormatting", () => {
  it("should parse plain text", async () => {
    const result = await parseInlineFormatting("hello world");
    assert.deepStrictEqual(result, [{ type: "text", text: "hello world" }]);
  });

  it("should parse **bold**", async () => {
    const result = await parseInlineFormatting("this is **bold** text");
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result[0], { type: "text", text: "this is " });
    assert.deepStrictEqual(result[1], {
      type: "text",
      text: "bold",
      marks: [{ type: "strong" }],
    });
    assert.deepStrictEqual(result[2], { type: "text", text: " text" });
  });

  it("should parse *italic*", async () => {
    const result = await parseInlineFormatting("this is *italic* text");
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result[1], {
      type: "text",
      text: "italic",
      marks: [{ type: "em" }],
    });
  });

  it("should parse `inline code`", async () => {
    const result = await parseInlineFormatting("use `console.log` here");
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result[1], {
      type: "text",
      text: "console.log",
      marks: [{ type: "code" }],
    });
  });

  it("should parse ~~strikethrough~~", async () => {
    const result = await parseInlineFormatting("this is ~~deleted~~ text");
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result[1], {
      type: "text",
      text: "deleted",
      marks: [{ type: "strike" }],
    });
  });

  it("should parse [link text](url)", async () => {
    const result = await parseInlineFormatting(
      "click [here](https://example.com) now",
    );
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result[1], {
      type: "text",
      text: "here",
      marks: [{ type: "link", attrs: { href: "https://example.com" } }],
    });
  });

  it("should auto-link bare URLs", async () => {
    const result = await parseInlineFormatting("see https://example.com now", fakeInstance);
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result[0], { type: "text", text: "see " });
    assert.deepStrictEqual(result[1], {
      type: "text",
      text: "https://example.com",
      marks: [{ type: "link", attrs: { href: "https://example.com" } }],
    });
    assert.deepStrictEqual(result[2], { type: "text", text: " now" });
  });

  it("should strip trailing punctuation from auto-linked URLs", async () => {
    const result = await parseInlineFormatting("visit https://example.com.", fakeInstance);
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result[1], {
      type: "text",
      text: "https://example.com",
      marks: [{ type: "link", attrs: { href: "https://example.com" } }],
    });
    assert.deepStrictEqual(result[2], { type: "text", text: "." });
  });

  it("should auto-link bare Jira ticket keys", async () => {
    const result = await parseInlineFormatting("from MODS-14941 onward", fakeInstance);
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result[1], {
      type: "text",
      text: "MODS-14941",
      marks: [{ type: "link", attrs: { href: "https://test.atlassian.net/browse/MODS-14941" } }],
    });
  });

  it("should parse Jira wiki [text|url] markup", async () => {
    const result = await parseInlineFormatting("see [the docs|https://example.com] here", fakeInstance);
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result[1], {
      type: "text",
      text: "the docs",
      marks: [{ type: "link", attrs: { href: "https://example.com" } }],
    });
  });

  it("should not double-link URLs that contain a ticket key", async () => {
    const result = await parseInlineFormatting(
      "https://test.atlassian.net/browse/MODS-14941",
      fakeInstance,
    );
    assert.equal(result.length, 1);
    assert.deepStrictEqual(result[0], {
      type: "text",
      text: "https://test.atlassian.net/browse/MODS-14941",
      marks: [{ type: "link", attrs: { href: "https://test.atlassian.net/browse/MODS-14941" } }],
    });
  });

  it("should parse multiple inline formats", async () => {
    const result = await parseInlineFormatting("**bold** and *italic*");
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result[0], {
      type: "text",
      text: "bold",
      marks: [{ type: "strong" }],
    });
    assert.deepStrictEqual(result[1], { type: "text", text: " and " });
    assert.deepStrictEqual(result[2], {
      type: "text",
      text: "italic",
      marks: [{ type: "em" }],
    });
  });
});

// ============ buildCommentADF ============

describe("buildCommentADF", () => {
  it("should create a simple paragraph", async () => {
    const result = await buildCommentADF("Hello world");
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "paragraph");
    assert.deepStrictEqual(result[0].content, [
      { type: "text", text: "Hello world" },
    ]);
  });

  it("should create headings from # syntax", async () => {
    const result = await buildCommentADF("# Main Title");
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "heading");
    assert.equal(result[0].attrs.level, 1);
    assert.deepStrictEqual(result[0].content, [
      { type: "text", text: "Main Title" },
    ]);
  });

  it("should create h2 and h3 headings", async () => {
    const result = await buildCommentADF("## Sub Title\n### Sub Sub");
    assert.equal(result.length, 2);
    assert.equal(result[0].type, "heading");
    assert.equal(result[0].attrs.level, 2);
    assert.equal(result[1].type, "heading");
    assert.equal(result[1].attrs.level, 3);
  });

  it("should create bullet lists", async () => {
    const result = await buildCommentADF("- item one\n- item two\n- item three");
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "bulletList");
    assert.equal(result[0].content.length, 3);
    assert.equal(result[0].content[0].type, "listItem");
  });

  it("should create ordered lists", async () => {
    const result = await buildCommentADF("1. first\n2. second\n3. third");
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "orderedList");
    assert.equal(result[0].content.length, 3);
    assert.equal(result[0].content[0].type, "listItem");
  });

  it("should create code blocks", async () => {
    const result = await buildCommentADF("```javascript\nconst x = 1;\n```");
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "codeBlock");
    assert.deepStrictEqual(result[0].attrs, { language: "javascript" });
    assert.deepStrictEqual(result[0].content, [
      { type: "text", text: "const x = 1;" },
    ]);
  });

  it("should create code blocks without language", async () => {
    const result = await buildCommentADF("```\nsome code\n```");
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "codeBlock");
    assert.equal(result[0].attrs, undefined);
  });

  it("should create horizontal rules", async () => {
    const result = await buildCommentADF("above\n---\nbelow");
    assert.equal(result.length, 3);
    assert.equal(result[0].type, "paragraph");
    assert.equal(result[1].type, "rule");
    assert.equal(result[2].type, "paragraph");
  });

  it("should create blockquotes", async () => {
    const result = await buildCommentADF("> This is a quote");
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "blockquote");
    assert.equal(result[0].content[0].type, "paragraph");
  });

  it("should create multi-line blockquotes", async () => {
    const result = await buildCommentADF("> line one\n> line two");
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "blockquote");
  });

  it("should create tables", async () => {
    const input = "| Name | Value |\n|---|---|\n| foo | bar |\n| baz | qux |";
    const result = await buildCommentADF(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "table");
    const rows = result[0].content;
    assert.equal(rows.length, 3); // header + 2 data rows
    assert.equal(rows[0].content[0].type, "tableHeader");
    assert.equal(rows[1].content[0].type, "tableCell");
    assert.equal(rows[2].content[0].type, "tableCell");
  });

  it("should handle mixed content", async () => {
    const input = [
      "# Requirements",
      "",
      "The following must be done:",
      "",
      "1. Build the API",
      "2. Write tests",
      "",
      "---",
      "",
      "> Important note here",
      "",
      "- bullet a",
      "- bullet b",
    ].join("\n");

    const result = await buildCommentADF(input);
    const types = result.map((n) => n.type);
    assert.deepStrictEqual(types, [
      "heading",
      "paragraph",
      "orderedList",
      "rule",
      "blockquote",
      "bulletList",
    ]);
  });

  it("should sanitize em dashes and en dashes", async () => {
    const result = await buildCommentADF("hello \u2014 world \u2013 test");
    assert.equal(result[0].content[0].text, "hello - world - test");
  });

  it("should handle inline formatting inside headings", async () => {
    const result = await buildCommentADF("## **Bold** heading");
    assert.equal(result[0].type, "heading");
    assert.equal(result[0].attrs.level, 2);
    assert.deepStrictEqual(result[0].content[0], {
      type: "text",
      text: "Bold",
      marks: [{ type: "strong" }],
    });
  });

  it("should handle inline formatting inside bullet lists", async () => {
    const result = await buildCommentADF("- **bold item**\n- *italic item*");
    assert.equal(result[0].type, "bulletList");
    const firstItem = result[0].content[0].content[0].content;
    assert.deepStrictEqual(firstItem[0], {
      type: "text",
      text: "bold item",
      marks: [{ type: "strong" }],
    });
  });

  it("should handle links inside content", async () => {
    const result = await buildCommentADF(
      "See [JIRA docs](https://example.com) for details",
    );
    assert.equal(result[0].type, "paragraph");
    const linkNode = result[0].content.find(
      (n) => n.marks && n.marks[0]?.type === "link",
    );
    assert.ok(linkNode);
    assert.equal(linkNode.text, "JIRA docs");
    assert.equal(linkNode.marks[0].attrs.href, "https://example.com");
  });

  it("should handle tables with inline formatting", async () => {
    const input =
      "| **Header** | Value |\n|---|---|\n| `code` | [link](https://x.com) |";
    const result = await buildCommentADF(input);
    assert.equal(result[0].type, "table");
    const headerCell = result[0].content[0].content[0];
    assert.equal(headerCell.type, "tableHeader");
    assert.deepStrictEqual(headerCell.content[0].content[0], {
      type: "text",
      text: "Header",
      marks: [{ type: "strong" }],
    });
  });
});

// ============ findJiraTicketKeys ============

describe("findJiraTicketKeys", () => {
  it("should find ticket keys in text", () => {
    const result = findJiraTicketKeys("See MODS-123 and ENG-456");
    assert.deepStrictEqual(result, ["MODS-123", "ENG-456"]);
  });

  it("should find ticket keys in URLs", () => {
    const result = findJiraTicketKeys(
      "https://company.atlassian.net/browse/MODS-789",
    );
    assert.ok(result.includes("MODS-789"));
  });

  it("should exclude current key", () => {
    const result = findJiraTicketKeys("See MODS-123 and MODS-456", "MODS-123");
    assert.deepStrictEqual(result, ["MODS-456"]);
  });

  it("should deduplicate keys", () => {
    const result = findJiraTicketKeys("MODS-123 and MODS-123 again");
    assert.deepStrictEqual(result, ["MODS-123"]);
  });

  it("should return empty for no matches", () => {
    const result = findJiraTicketKeys("no tickets here");
    assert.deepStrictEqual(result, []);
  });

  it("should handle empty/null input", () => {
    assert.deepStrictEqual(findJiraTicketKeys(""), []);
    assert.deepStrictEqual(findJiraTicketKeys(null), []);
  });
});

// ============ jira_search_users ============

describe("jira_search_users", () => {
  const callToolHandler = toolHandlers["CallToolRequestSchema"];

  beforeEach(() => {
    fetchMock.mock.resetCalls();
  });

  it("preserves successful global user search behavior", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify([
              {
                displayName: "Julia Doe",
                accountId: "account-1",
                emailAddress: "julia@example.com",
              },
            ]),
          ),
      }),
    );

    const result = await callToolHandler({
      params: {
        name: "jira_search_users",
        arguments: { query: "Julia", maxResults: 10 },
      },
    });

    assert.deepStrictEqual(result, {
      content: [
        {
          type: "text",
          text: 'Found 1 user(s) for "Julia":\n\n- **Julia Doe** (accountId: account-1, email: julia@example.com)',
        },
      ],
    });
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(fetchMock.mock.calls[0].arguments[1].method, "GET");
    assert.ok(
      fetchMock.mock.calls[0].arguments[0].endsWith(
        "/rest/api/3/user/search?query=Julia&maxResults=10",
      ),
    );
  });

  it("falls back to issue-scoped assignable users when global search is empty", async () => {
    fetchMock.mock.mockImplementation((url) =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            url.includes("/user/assignable/search")
              ? JSON.stringify([
                  { displayName: "Assignable User", accountId: "account-2" },
                ])
              : JSON.stringify([]),
          ),
      }),
    );

    const query = "Jane Doe+test@example.com & other";
    const result = await callToolHandler({
      params: {
        name: "jira_search_users",
        arguments: {
          query,
          maxResults: 10,
          issueKey: "MODS-123",
        },
      },
    });

    assert.ok(result.content[0].text.includes("Found 1 user(s)"));
    assert.equal(fetchMock.mock.calls.length, 2);
    assert.ok(
      fetchMock.mock.calls[0].arguments[0].endsWith(
        "/rest/api/3/user/search?query=Jane%20Doe%2Btest%40example.com%20%26%20other&maxResults=10",
      ),
    );
    assert.ok(
      fetchMock.mock.calls[1].arguments[0].endsWith(
        "/rest/api/3/user/assignable/search?issueKey=MODS-123&query=Jane%20Doe%2Btest%40example.com%20%26%20other&maxResults=10",
      ),
    );
  });

  it("falls back to project-scoped assignable users when global search is empty", async () => {
    fetchMock.mock.mockImplementation((url) =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            url.includes("/user/assignable/search")
              ? JSON.stringify([
                  { displayName: "Project User", accountId: "account-3" },
                ])
              : JSON.stringify([]),
          ),
      }),
    );

    const result = await callToolHandler({
      params: {
        name: "jira_search_users",
        arguments: { query: "Alex", maxResults: 3, projectKey: "MODS" },
      },
    });

    assert.ok(result.content[0].text.includes("Found 1 user(s)"));
    assert.equal(fetchMock.mock.calls.length, 2);
    assert.ok(
      fetchMock.mock.calls[1].arguments[0].endsWith(
        "/rest/api/3/user/assignable/search?project=MODS&query=Alex&maxResults=3",
      ),
    );
  });

  it("uses the assignable fallback when global search is forbidden for user browsing", async () => {
    fetchMock.mock.mockImplementation((url) => {
      if (url.includes("/user/search?")) {
        return Promise.resolve({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          text: () =>
            Promise.resolve(
              JSON.stringify({
                errorMessages: [
                  "The calling user does not have permission to browse users and groups.",
                ],
              }),
            ),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify([
              { displayName: "Assignable User", accountId: "account-4" },
            ]),
          ),
      });
    });

    const result = await callToolHandler({
      params: {
        name: "jira_search_users",
        arguments: { query: "Julia", issueKey: "MODS-123" },
      },
    });

    assert.ok(result.content[0].text.includes("Found 1 user(s)"));
    assert.equal(fetchMock.mock.calls.length, 2);
    assert.ok(
      fetchMock.mock.calls[1].arguments[0].endsWith(
        "/rest/api/3/user/assignable/search?issueKey=MODS-123&query=Julia&maxResults=5",
      ),
    );
  });

  it("keeps the existing no-users response when no assignment context is supplied", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([])),
      }),
    );

    const result = await callToolHandler({
      params: {
        name: "jira_search_users",
        arguments: { query: "Nobody" },
      },
    });

    assert.deepStrictEqual(result, {
      content: [{ type: "text", text: 'No users found for "Nobody".' }],
    });
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  it("does not mask unrelated global search errors", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: () => Promise.resolve("Access denied for another reason"),
      }),
    );

    const result = await callToolHandler({
      params: {
        name: "jira_search_users",
        arguments: { query: "Julia", issueKey: "MODS-123" },
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Jira API error: 403 Forbidden/);
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  it("documents assignment context arguments in the tool schema", async () => {
    const result = await toolHandlers["ListToolsRequestSchema"]();
    const tool = result.tools.find((entry) => entry.name === "jira_search_users");

    assert.equal(tool.inputSchema.properties.issueKey.type, "string");
    assert.equal(tool.inputSchema.properties.projectKey.type, "string");
    assert.match(tool.description, /assignment-oriented searches/);
  });
});

// ============ Team functions ============

describe("resolveTeamId", () => {
  const testInstance = {
    name: "test",
    baseUrl: "https://test.atlassian.net",
    auth: "dGVzdDp0ZXN0", // base64 "test:test"
  };

  beforeEach(() => {
    fetchMock.mock.resetCalls();
  });

  it("should resolve team name to orgId-id format", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify([
              { id: 304, title: "Site Surveys (MODS)", organizationId: "c7cef7dd-a0e5-422b-a8b5-af3a63679272" },
              { id: 100, title: "KONE SiteFlow", organizationId: "c7cef7dd-a0e5-422b-a8b5-af3a63679272" },
            ]),
          ),
      }),
    );

    const result = await resolveTeamId("Site Surveys (MODS)", testInstance);
    assert.equal(result, "c7cef7dd-a0e5-422b-a8b5-af3a63679272-304");
  });

  it("should match team name case-insensitively", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify([
              { id: 304, title: "Site Surveys (MODS)", organizationId: "org-123" },
            ]),
          ),
      }),
    );

    const result = await resolveTeamId("site surveys (mods)", testInstance);
    assert.equal(result, "org-123-304");
  });

  it("should fall back to JQL when Teams API fails", async () => {
    let callCount = 0;
    fetchMock.mock.mockImplementation((url) => {
      callCount++;
      if (url.includes("/rest/teams/")) {
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: "Not Found",
          text: () => Promise.resolve("Not Found"),
        });
      }
      // JQL autocomplete fallback
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              results: [
                { value: "org-123-304", displayName: "<b>Site</b> Surveys (MODS)" },
              ],
            }),
          ),
      });
    });

    const result = await resolveTeamId("Site Surveys (MODS)", testInstance);
    assert.equal(result, "org-123-304");
    assert.ok(callCount >= 2); // Teams API + JQL fallback
  });

  it("should throw when team not found in both APIs", async () => {
    fetchMock.mock.mockImplementation((url) => {
      if (url.includes("/rest/teams/")) {
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: "Not Found",
          text: () => Promise.resolve("Not Found"),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              results: [
                { value: "org-1", displayName: "Other Team" },
              ],
            }),
          ),
      });
    });

    await assert.rejects(
      () => resolveTeamId("Nonexistent Team", testInstance),
      (err) => {
        assert.ok(err.message.includes('Team "Nonexistent Team" not found'));
        assert.ok(err.message.includes("Other Team"));
        return true;
      },
    );
  });

  it("should call the correct Teams API endpoint first", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify([
              { id: 1, title: "My Team", organizationId: "org-1" },
            ]),
          ),
      }),
    );

    await resolveTeamId("My Team", testInstance);

    const call = fetchMock.mock.calls[0];
    const url = call.arguments[0];
    assert.ok(url.startsWith("https://test.atlassian.net/rest/teams/1.0/teams/find"));
    assert.ok(url.includes("query=My%20Team"));
    assert.ok(url.includes("excludeMembers=true"));
  });
});

describe("searchTeamsViaJql", () => {
  const testInstance = {
    name: "test",
    baseUrl: "https://test.atlassian.net",
    auth: "dGVzdDp0ZXN0",
  };

  beforeEach(() => {
    fetchMock.mock.resetCalls();
  });

  it("should parse JQL autocomplete results and strip HTML", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              results: [
                { value: "org-304", displayName: "<b>Site</b> Surveys (MODS)" },
                { value: "org-100", displayName: "KONE <b>Site</b>Flow" },
              ],
            }),
          ),
      }),
    );

    const result = await searchTeamsViaJql("site", testInstance);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, "Site Surveys (MODS)");
    assert.equal(result[0].id, "org-304");
    assert.equal(result[1].title, "KONE SiteFlow");
  });

  it("should decode HTML entities", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              results: [
                { value: "id-1", displayName: "Cars &amp; Doors" },
              ],
            }),
          ),
      }),
    );

    const result = await searchTeamsViaJql("cars", testInstance);
    assert.equal(result[0].title, "Cars & Doors");
  });

  it("should return empty array when no results", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ results: [] })),
      }),
    );

    const result = await searchTeamsViaJql("nothing", testInstance);
    assert.deepStrictEqual(result, []);
  });
});

describe("listTeams", () => {
  const testInstance = {
    name: "test",
    baseUrl: "https://test.atlassian.net",
    auth: "dGVzdDp0ZXN0",
  };

  beforeEach(() => {
    fetchMock.mock.resetCalls();
  });

  it("should use Teams API when available", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify([
              { id: 1, title: "Team A", organizationId: "org-1" },
              { id: 2, title: "Team B", organizationId: "org-1" },
            ]),
          ),
      }),
    );

    const result = await listTeams(testInstance);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, "Team A");
    assert.equal(result[0].id, "org-1-1");
  });

  it("should fall back to JQL when Teams API fails", async () => {
    fetchMock.mock.mockImplementation((url) => {
      if (url.includes("/rest/teams/")) {
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: "Not Found",
          text: () => Promise.resolve("Not Found"),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              results: [
                { value: "org-304", displayName: "Site Surveys (MODS)" },
              ],
            }),
          ),
      });
    });

    const result = await listTeams(testInstance);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "Site Surveys (MODS)");
    assert.equal(result[0].id, "org-304");
  });
});

describe("fetchJiraTeams", () => {
  const testInstance = {
    name: "test",
    baseUrl: "https://test.atlassian.net",
    auth: "dGVzdDp0ZXN0",
  };

  beforeEach(() => {
    fetchMock.mock.resetCalls();
  });

  it("should call the Teams REST API with correct base URL", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([{ id: 1, title: "Team A" }])),
      }),
    );

    const result = await fetchJiraTeams("/teams/find?query=&excludeMembers=true", {}, testInstance);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "Team A");

    const url = fetchMock.mock.calls[0].arguments[0];
    assert.equal(url, "https://test.atlassian.net/rest/teams/1.0/teams/find?query=&excludeMembers=true");
  });

  it("should pass auth header", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve("[]"),
      }),
    );

    await fetchJiraTeams("/teams/find?query=", {}, testInstance);

    const headers = fetchMock.mock.calls[0].arguments[1].headers;
    assert.equal(headers.Authorization, "Basic dGVzdDp0ZXN0");
  });

  it("should throw on API error", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: () => Promise.resolve("Access denied"),
      }),
    );

    await assert.rejects(
      () => fetchJiraTeams("/teams/find?query=", {}, testInstance),
      (err) => {
        assert.ok(err.message.includes("403"));
        assert.ok(err.message.includes("Forbidden"));
        return true;
      },
    );
  });
});

// ============ jira_create_subtask — team field omission ============

describe("jira_create_subtask", () => {
  const callToolHandler = toolHandlers["CallToolRequestSchema"];

  beforeEach(() => {
    fetchMock.mock.resetCalls();
  });

  it("should NOT include customfield_10001 in the request body", async () => {
    // fetchJira will be called for POST /issue — capture the body it sends
    fetchMock.mock.mockImplementation((url, opts) => {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ key: "PROJ-124" })),
      });
    });

    await callToolHandler({
      params: {
        name: "jira_create_subtask",
        arguments: {
          parentKey: "PROJ-123",
          summary: "Test subtask",
        },
      },
    });

    // Find the POST call to /issue (the create call)
    const createCall = fetchMock.mock.calls.find((c) => {
      const url = c.arguments[0];
      const opts = c.arguments[1];
      return url.includes("/rest/api/3/issue") && opts?.method === "POST";
    });

    assert.ok(createCall, "Expected a POST /issue call");
    const body = JSON.parse(createCall.arguments[1].body);
    assert.equal(
      body.fields.customfield_10001,
      undefined,
      "customfield_10001 must not be present in subtask request — subtasks inherit team from parent",
    );
  });

  it("should NOT include customfield_10001 even when team param is omitted and parent has a team", async () => {
    fetchMock.mock.mockImplementation((url) => {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ key: "PROJ-125" })),
      });
    });

    await callToolHandler({
      params: {
        name: "jira_create_subtask",
        arguments: {
          parentKey: "PROJ-123",
          summary: "Another subtask",
        },
      },
    });

    const createCall = fetchMock.mock.calls.find((c) => {
      const url = c.arguments[0];
      const opts = c.arguments[1];
      return url.includes("/rest/api/3/issue") && opts?.method === "POST";
    });

    assert.ok(createCall, "Expected a POST /issue call");
    const body = JSON.parse(createCall.arguments[1].body);
    assert.ok(
      !("customfield_10001" in body.fields),
      "customfield_10001 key must not exist at all in subtask fields",
    );
  });

  it("should include standard fields (project, parent, issuetype, summary)", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ key: "PROJ-126" })),
      }),
    );

    await callToolHandler({
      params: {
        name: "jira_create_subtask",
        arguments: {
          parentKey: "PROJ-123",
          summary: "Subtask with fields",
          priority: "High",
          labels: ["backend"],
        },
      },
    });

    const createCall = fetchMock.mock.calls.find((c) => {
      const url = c.arguments[0];
      const opts = c.arguments[1];
      return url.includes("/rest/api/3/issue") && opts?.method === "POST";
    });

    const body = JSON.parse(createCall.arguments[1].body);
    assert.deepStrictEqual(body.fields.project, { key: "PROJ" });
    assert.deepStrictEqual(body.fields.parent, { key: "PROJ-123" });
    assert.deepStrictEqual(body.fields.issuetype, { name: "Sub-task" });
    assert.equal(body.fields.summary, "Subtask with fields");
    assert.deepStrictEqual(body.fields.priority, { name: "High" });
    assert.deepStrictEqual(body.fields.labels, ["backend"]);
    assert.ok(!("customfield_10001" in body.fields), "team field must still be absent");
  });

  it("should not make a fetch call to get parent team", async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ key: "PROJ-127" })),
      }),
    );

    await callToolHandler({
      params: {
        name: "jira_create_subtask",
        arguments: {
          parentKey: "PROJ-123",
          summary: "No parent fetch subtask",
        },
      },
    });

    // Should only have 1 fetch call — the POST /issue create, not a GET for parent team
    const getCalls = fetchMock.mock.calls.filter((c) => {
      const opts = c.arguments[1];
      return !opts?.method || opts.method === "GET";
    });
    assert.equal(getCalls.length, 0, "Should not fetch parent issue for team inheritance");
  });
});
