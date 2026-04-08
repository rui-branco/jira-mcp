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

const { buildCommentADF, parseInlineFormatting, findJiraTicketKeys } = require("../index.js");

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
