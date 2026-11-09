const { describe, it, beforeEach, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-mcp-wait-test-"));
const testConfigPath = path.join(testHome, ".config", "jira-mcp", "config.json");
fs.mkdirSync(path.dirname(testConfigPath), { recursive: true });
fs.writeFileSync(testConfigPath, JSON.stringify({
  instances: [
    {
      name: "acme",
      email: "alex@example.com",
      token: "test-token",
      baseUrl: "https://acme.example.net",
      projects: ["ACME"],
    },
  ],
  defaultInstance: "acme",
  audit: { enabled: false },
  rateLimit: { enabled: false },
}));
process.env.HOME = testHome;
// os.homedir() reads USERPROFILE on Windows and ignores HOME, so the sandbox
// has to move both or the real ~/.config/jira-mcp config gets read/written.
process.env.USERPROFILE = testHome;
process.env.JIRA_MCP_CONFIG_PATH = testConfigPath;

after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

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
const stdioPath = require.resolve(
  "@modelcontextprotocol/sdk/server/stdio.js",
);
require.cache[stdioPath] = {
  id: stdioPath,
  filename: stdioPath,
  loaded: true,
  exports: { StdioServerTransport: class {} },
};

const {
  abortableSleep,
  findIssueChanges,
  waitForIssueChange,
  waitAnswer,
} = require("../index.js");

const acme = {
  name: "acme",
  baseUrl: "https://acme.example.net",
  auth: "dGVzdA==",
};
const me = { accountId: "acc-me", displayName: "Me Example" };
const alex = { accountId: "acc-alex", displayName: "Alex Example" };

const T0 = Date.parse("2026-03-02T10:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;

// Jira writes times like 2026-03-02T10:00:00.000+0000
function jiraTime(ms) {
  return new Date(ms).toISOString().replace("Z", "+0000");
}

function adf(text) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : status === 404 ? "Not Found" : status === 429 ? "Too Many Requests" : "Server Error",
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body ?? {})),
  };
}

const ok = (body) => response(200, body);

// Answers fetch by Jira REST path (the part after /rest/api/3). /myself is
// always the test user; everything else goes to `answer`.
function serve(answer) {
  fetchMock.mock.resetCalls();
  fetchMock.mock.mockImplementation(async (url, options = {}) => {
    const marker = "/rest/api/3";
    const apiPath = url.slice(url.indexOf(marker) + marker.length);
    if (apiPath === "/myself") return ok(me);
    return answer(apiPath, options);
  });
}

function apiPathOf(url) {
  return url.slice(url.indexOf("/rest/api/3") + "/rest/api/3".length);
}

function fetchedPaths() {
  return fetchMock.mock.calls.map((call) => apiPathOf(call.arguments[0]));
}

// Every request that was not a GET, as [method, path]
function writes() {
  return fetchMock.mock.calls
    .filter((call) => (call.arguments[1]?.method || "GET") !== "GET")
    .map((call) => [call.arguments[1].method, apiPathOf(call.arguments[0])]);
}

// Answers the issue, comment and changelog requests from a mutable map of
// tickets: { "ACME-1": { updated, status, comments, histories } }.
function ticketAnswers(tickets) {
  return (apiPath) => {
    const match = apiPath.match(/^\/issue\/([^/?]+)(.*)$/);
    const ticket = match && tickets[match[1]];
    if (!ticket) return response(404, "Issue does not exist");
    const rest = match[2];
    if (rest === "?fields=updated,status") {
      return ok({ key: match[1], fields: { updated: ticket.updated, status: { name: ticket.status } } });
    }
    if (rest.startsWith("/comment?")) return ok({ comments: ticket.comments || [] });
    if (rest.startsWith("/changelog?")) {
      const histories = ticket.histories || [];
      const params = new URLSearchParams(rest.slice(rest.indexOf("?") + 1));
      const startAt = Number(params.get("startAt") || 0);
      const maxResults = Number(params.get("maxResults") || 100);
      return ok({
        startAt,
        maxResults,
        total: histories.length,
        values: histories.slice(startAt, startAt + maxResults),
      });
    }
    return response(404, "");
  };
}

function comment(id, author, at, text) {
  return { id, author, created: jiraTime(at), updated: jiraTime(at), body: adf(text) };
}

function history(author, at, items) {
  return { id: String(at), author, created: jiraTime(at), items };
}

const statusItem = (from, to) => ({ field: "status", fromString: from, toString: to });

// A clock that only moves when the fake sleep is called. onSleep gets the
// number of sleeps so far, so tests can change Jira between rounds.
function fakeClock(onSleep = () => {}) {
  const clock = {
    t: T0,
    sleeps: [],
    now: () => clock.t,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.t += ms;
      onSleep(clock.sleeps.length);
    },
  };
  return clock;
}

function waitOptions(clock, overrides = {}) {
  return {
    issueKeys: ["ACME-1"],
    sinceMs: T0,
    watch: ["comments", "status"],
    includeOwn: false,
    timeoutMs: 30 * MINUTE,
    intervalMs: MINUTE,
    instance: acme,
    sleep: clock.sleep,
    now: clock.now,
    ...overrides,
  };
}

// ============ abortableSleep ============

describe("abortableSleep", () => {
  it("resolves as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(10 * MINUTE, controller.signal);
    controller.abort();
    await sleeping;
    assert.ok(Date.now() - started < 5 * SECOND);
  });

  it("resolves at once when the signal is already aborted", async () => {
    await abortableSleep(10 * MINUTE, AbortSignal.abort());
  });

  it("resolves after the time without a signal", async () => {
    await abortableSleep(5);
  });
});

// ============ findIssueChanges ============

describe("findIssueChanges", () => {
  const base = { sinceMs: T0, includeOwn: false, me: "acc-me" };

  it("returns a new comment by someone else with its text", async () => {
    serve(ticketAnswers({
      "ACME-1": { comments: [comment("10001", alex, T0 + MINUTE, "Looks good to me")] },
    }));
    const changes = await findIssueChanges("ACME-1", { ...base, watch: ["comments"] }, acme);
    assert.deepStrictEqual(changes, [{
      type: "comment",
      issueKey: "ACME-1",
      id: "10001",
      author: "Alex Example",
      at: "2026-03-02T10:01:00.000Z",
      text: "Looks good to me\n",
    }]);
  });

  it("ignores your own comment unless includeOwn", async () => {
    serve(ticketAnswers({
      "ACME-1": { comments: [comment("10002", me, T0 + MINUTE, "Pushed a fix")] },
    }));
    const without = await findIssueChanges("ACME-1", { ...base, watch: ["comments"] }, acme);
    assert.deepStrictEqual(without, []);
    const withOwn = await findIssueChanges(
      "ACME-1",
      { ...base, watch: ["comments"], includeOwn: true, me: null },
      acme,
    );
    assert.equal(withOwn.length, 1);
    assert.equal(withOwn[0].author, "Me Example");
  });

  it("ignores a comment made before since", async () => {
    serve(ticketAnswers({
      "ACME-1": {
        comments: [
          comment("10003", alex, T0 - MINUTE, "Old note"),
          comment("10004", alex, T0, "Exactly at since"),
        ],
      },
    }));
    const changes = await findIssueChanges("ACME-1", { ...base, watch: ["comments"] }, acme);
    assert.deepStrictEqual(changes, []);
  });

  it("cuts a long comment to 2000 characters", async () => {
    serve(ticketAnswers({
      "ACME-1": { comments: [comment("10005", alex, T0 + MINUTE, "x".repeat(2500))] },
    }));
    const [change] = await findIssueChanges("ACME-1", { ...base, watch: ["comments"] }, acme);
    assert.equal(change.text, "x".repeat(2000) + "… [truncated]");
  });

  it("returns a status change with from, to and author", async () => {
    serve(ticketAnswers({
      "ACME-1": { histories: [history(alex, T0 + MINUTE, [statusItem("To Do", "In Progress")])] },
    }));
    const changes = await findIssueChanges("ACME-1", { ...base, watch: ["status"] }, acme);
    assert.deepStrictEqual(changes, [{
      type: "status",
      issueKey: "ACME-1",
      from: "To Do",
      to: "In Progress",
      author: "Alex Example",
      at: "2026-03-02T10:01:00.000Z",
    }]);
    assert.ok(!fetchedPaths().some((p) => p.includes("/comment")));
  });

  it("ignores your own status change and one before since", async () => {
    serve(ticketAnswers({
      "ACME-1": {
        histories: [
          history(alex, T0 - MINUTE, [statusItem("To Do", "In Progress")]),
          history(me, T0 + MINUTE, [statusItem("In Progress", "Done")]),
        ],
      },
    }));
    const changes = await findIssueChanges("ACME-1", { ...base, watch: ["status"] }, acme);
    assert.deepStrictEqual(changes, []);
  });

  it("counts other field changes only with watch any", async () => {
    const tickets = {
      "ACME-1": {
        histories: [
          history(alex, T0 + MINUTE, [
            { field: "priority", fromString: "Low", toString: "High" },
            statusItem("To Do", "In Progress"),
          ]),
          history(alex, T0 + 2 * MINUTE, [
            { field: "description", fromString: "a".repeat(400), toString: "b".repeat(400) },
          ]),
        ],
      },
    };
    serve(ticketAnswers(tickets));
    const statusOnly = await findIssueChanges("ACME-1", { ...base, watch: ["status"] }, acme);
    assert.deepStrictEqual(statusOnly.map((c) => c.type), ["status"]);

    serve(ticketAnswers(tickets));
    const all = await findIssueChanges("ACME-1", { ...base, watch: ["any"] }, acme);
    assert.deepStrictEqual(all.map((c) => c.type), ["update", "status", "update"]);
    assert.deepStrictEqual(all[0], {
      type: "update",
      issueKey: "ACME-1",
      field: "priority",
      from: "Low",
      to: "High",
      author: "Alex Example",
      at: "2026-03-02T10:01:00.000Z",
    });
    assert.equal(all[2].from, "a".repeat(300));
    assert.equal(all[2].to, "b".repeat(300));
    // watch any also reads comments
    assert.ok(fetchedPaths().some((p) => p.startsWith("/issue/ACME-1/comment?")));
  });

  it("reads `to` as null when the item has no toString field", async () => {
    serve(ticketAnswers({
      "ACME-1": {
        histories: [history(alex, T0 + MINUTE, [{ field: "labels", fromString: "old" }])],
      },
    }));
    const [change] = await findIssueChanges("ACME-1", { ...base, watch: ["any"] }, acme);
    assert.equal(change.to, null);
  });

  it("asks the changelog for its last page", async () => {
    const histories = [];
    for (let i = 0; i < 119; i++) {
      histories.push(history(alex, T0 - (200 - i) * MINUTE, [statusItem("A", "B")]));
    }
    histories.push(history(alex, T0 + MINUTE, [statusItem("In Review", "Done")]));
    serve(ticketAnswers({ "ACME-1": { histories } }));

    const changes = await findIssueChanges("ACME-1", { ...base, watch: ["status"] }, acme);
    assert.deepStrictEqual(fetchedPaths(), [
      "/issue/ACME-1/changelog?maxResults=1",
      "/issue/ACME-1/changelog?startAt=70&maxResults=50",
    ]);
    assert.deepStrictEqual(changes.map((c) => c.to), ["Done"]);
  });

  it("starts the changelog at 0 when it has 50 entries or fewer", async () => {
    serve(ticketAnswers({
      "ACME-1": { histories: [history(alex, T0 + MINUTE, [statusItem("To Do", "Done")])] },
    }));
    await findIssueChanges("ACME-1", { ...base, watch: ["status"] }, acme);
    assert.equal(fetchedPaths()[1], "/issue/ACME-1/changelog?startAt=0&maxResults=50");
  });

  it("returns changes oldest first", async () => {
    serve(ticketAnswers({
      "ACME-1": {
        comments: [
          comment("10011", alex, T0 + 3 * MINUTE, "Third"),
          comment("10010", alex, T0 + MINUTE, "First"),
        ],
        histories: [history(alex, T0 + 2 * MINUTE, [statusItem("To Do", "In Progress")])],
      },
    }));
    const changes = await findIssueChanges("ACME-1", { ...base, watch: ["comments", "status"] }, acme);
    assert.deepStrictEqual(changes.map((c) => c.id || c.type), ["10010", "status", "10011"]);
  });
});

// ============ waitForIssueChange ============

describe("waitForIssueChange", () => {
  it("returns what changed when updated moves on a later round", async () => {
    const tickets = {
      "ACME-1": { updated: jiraTime(T0 - 60 * MINUTE), status: "In Progress" },
    };
    serve(ticketAnswers(tickets));
    const clock = fakeClock((sleeps) => {
      if (sleeps === 2) {
        tickets["ACME-1"].updated = jiraTime(T0 + 2 * MINUTE + 5 * SECOND);
        tickets["ACME-1"].comments = [comment("10020", alex, T0 + 2 * MINUTE + 5 * SECOND, "Can you check again?")];
      }
    });

    const result = await waitForIssueChange(waitOptions(clock));
    assert.deepStrictEqual(clock.sleeps, [MINUTE, MINUTE]);
    assert.equal(result.found.length, 1);
    assert.equal(result.found[0].id, "10020");
    assert.equal(result.found[0].text, "Can you check again?\n");
    assert.deepStrictEqual(result.statuses, { "ACME-1": "In Progress" });
    // Only the round that saw `updated` move looked at the comments
    assert.equal(fetchedPaths().filter((p) => p.includes("/comment?")).length, 1);
  });

  it("catches on the first round a change made after since but before the call", async () => {
    serve(ticketAnswers({
      "ACME-1": {
        updated: jiraTime(T0 + 10 * SECOND),
        status: "To Do",
        histories: [history(alex, T0 + 10 * SECOND, [statusItem("In Progress", "To Do")])],
      },
    }));
    const clock = fakeClock();
    const result = await waitForIssueChange(waitOptions(clock));
    assert.deepStrictEqual(clock.sleeps, []);
    assert.deepStrictEqual(result.found.map((c) => [c.type, c.to]), [["status", "To Do"]]);
  });

  it("keeps waiting when updated moves for a change that does not count", async () => {
    const tickets = {
      "ACME-1": { updated: jiraTime(T0 - MINUTE), status: "In Progress" },
    };
    serve(ticketAnswers(tickets));
    const clock = fakeClock((sleeps) => {
      if (sleeps === 1) {
        tickets["ACME-1"].updated = jiraTime(T0 + 30 * SECOND);
        tickets["ACME-1"].comments = [comment("10021", me, T0 + 30 * SECOND, "My own note")];
      }
    });
    const result = await waitForIssueChange(waitOptions(clock, { timeoutMs: 3 * MINUTE }));
    assert.deepStrictEqual(result, {
      timedOut: true,
      statuses: { "ACME-1": "In Progress" },
      newestSeenMs: T0 + 30 * SECOND,
    });
  });

  it("times out with the statuses it saw, never sleeping past the timeout", async () => {
    serve(ticketAnswers({
      "ACME-1": { updated: jiraTime(T0 - MINUTE), status: "In Review" },
    }));
    const clock = fakeClock();
    const result = await waitForIssueChange(waitOptions(clock, { timeoutMs: 150 * SECOND }));
    assert.deepStrictEqual(result, { timedOut: true, statuses: { "ACME-1": "In Review" }, newestSeenMs: T0 });
    assert.deepStrictEqual(clock.sleeps, [MINUTE, MINUTE, 30 * SECOND]);
  });

  it("returns cancelled when the signal aborts during the wait", async () => {
    serve(ticketAnswers({
      "ACME-1": { updated: jiraTime(T0 - MINUTE), status: "To Do" },
    }));
    const controller = new AbortController();
    const clock = fakeClock(() => controller.abort());
    const result = await waitForIssueChange(waitOptions(clock, { signal: controller.signal }));
    assert.deepStrictEqual(result, { cancelled: true });
    assert.equal(clock.sleeps.length, 1);
  });

  it("returns cancelled before reading the ticket when already aborted", async () => {
    serve(ticketAnswers({
      "ACME-1": { updated: jiraTime(T0 - MINUTE), status: "To Do" },
    }));
    const clock = fakeClock();
    const result = await waitForIssueChange(waitOptions(clock, { signal: AbortSignal.abort() }));
    assert.deepStrictEqual(result, { cancelled: true });
    assert.ok(!fetchedPaths().some((p) => p.startsWith("/issue/")));
  });

  it("fails at once on a 404", async () => {
    serve(ticketAnswers({}));
    const clock = fakeClock();
    const result = await waitForIssueChange(waitOptions(clock));
    assert.match(result.failed, /404/);
    assert.deepStrictEqual(clock.sleeps, []);
  });

  it("fails after five failed rounds in a row with the last message", async () => {
    const clock = fakeClock();
    serve(() => response(503, `round ${clock.sleeps.length + 1}`));
    const result = await waitForIssueChange(waitOptions(clock));
    assert.match(result.failed, /503/);
    assert.match(result.failed, /round 5$/);
    assert.equal(clock.sleeps.length, 4);
  });

  it("counts a network error as a failed round", async () => {
    const clock = fakeClock();
    serve(() => {
      throw new Error("socket hang up");
    });
    const result = await waitForIssueChange(waitOptions(clock, { maxFailedRounds: 2 }));
    assert.deepStrictEqual(result, { failed: "socket hang up" });
    assert.equal(clock.sleeps.length, 1);
  });

  it("resets the failure count after a clean round", async () => {
    const answers = ticketAnswers({
      "ACME-1": { updated: jiraTime(T0 - MINUTE), status: "To Do" },
    });
    const clock = fakeClock();
    // Rounds 1-4 and 6-9 fail, 5 and 10 are clean
    serve((apiPath) => {
      const round = clock.sleeps.length + 1;
      return round % 5 === 0 ? answers(apiPath) : response(500, "down");
    });
    const result = await waitForIssueChange(waitOptions(clock, { timeoutMs: 9 * MINUTE }));
    assert.deepStrictEqual(result, { timedOut: true, statuses: { "ACME-1": "To Do" }, newestSeenMs: T0 });
    assert.equal(clock.sleeps.length, 9);
  });

  it("sleeps at least 60 seconds after a 429", async () => {
    const answers = ticketAnswers({
      "ACME-1": { updated: jiraTime(T0 - MINUTE), status: "To Do" },
    });
    const clock = fakeClock();
    serve((apiPath) => (clock.sleeps.length === 0 ? response(429, "slow down") : answers(apiPath)));
    await waitForIssueChange(waitOptions(clock, { intervalMs: 15 * SECOND, timeoutMs: 90 * SECOND }));
    assert.deepStrictEqual(clock.sleeps, [MINUTE, 15 * SECOND, 15 * SECOND]);
  });

  it("finds a change on the second of two tickets", async () => {
    const tickets = {
      "ACME-1": { updated: jiraTime(T0 - MINUTE), status: "To Do" },
      "ACME-2": { updated: jiraTime(T0 - MINUTE), status: "To Do" },
    };
    serve(ticketAnswers(tickets));
    const clock = fakeClock((sleeps) => {
      if (sleeps === 1) {
        tickets["ACME-2"].updated = jiraTime(T0 + 45 * SECOND);
        tickets["ACME-2"].status = "Done";
        tickets["ACME-2"].histories = [history(alex, T0 + 45 * SECOND, [statusItem("To Do", "Done")])];
      }
    });
    const result = await waitForIssueChange(waitOptions(clock, { issueKeys: ["ACME-1", "ACME-2"] }));
    assert.deepStrictEqual(result.found.map((c) => [c.issueKey, c.type, c.to]), [["ACME-2", "status", "Done"]]);
    assert.deepStrictEqual(result.statuses, { "ACME-1": "To Do", "ACME-2": "Done" });
    assert.equal(result.newestSeenMs, T0 + 45 * SECOND);
  });

  it("does not lose a change when a later ticket fails in the same round", async () => {
    const answers = ticketAnswers({
      "ACME-1": {
        updated: jiraTime(T0 + 20 * SECOND),
        status: "To Do",
        comments: [comment("10030", alex, T0 + 20 * SECOND, "Question for you")],
      },
      "ACME-2": { updated: jiraTime(T0 - MINUTE), status: "To Do" },
    });
    const clock = fakeClock();
    serve((apiPath) =>
      clock.sleeps.length === 0 && apiPath.startsWith("/issue/ACME-2")
        ? response(502, "bad gateway")
        : answers(apiPath),
    );
    const result = await waitForIssueChange(waitOptions(clock, { issueKeys: ["ACME-1", "ACME-2"] }));
    assert.equal(clock.sleeps.length, 1);
    assert.deepStrictEqual(result.found.map((c) => c.id), ["10030"]);
  });

  // ---- no since: the baseline comes from Jira's clock ----

  it("with no since, finds a comment made before the local now but after the ticket's last update", async () => {
    // The local clock runs ahead of Jira: the comment is earlier than now()
    // on every round, but later than `updated` at first sight.
    const tickets = {
      "ACME-1": { updated: jiraTime(T0 - 20 * SECOND), status: "In Progress" },
    };
    serve(ticketAnswers(tickets));
    const clock = fakeClock((sleeps) => {
      if (sleeps === 1) {
        tickets["ACME-1"].updated = jiraTime(T0 - 5 * SECOND);
        tickets["ACME-1"].comments = [comment("10050", alex, T0 - 5 * SECOND, "Here is the answer")];
      }
    });
    const result = await waitForIssueChange(waitOptions(clock, { sinceMs: null }));
    assert.equal(clock.sleeps.length, 1);
    assert.deepStrictEqual(result.found.map((c) => c.id), ["10050"]);
    assert.ok(Date.parse(result.found[0].at) < clock.now());
    assert.equal(result.newestSeenMs, T0 - 5 * SECOND);
  });

  it("with no since, never reports what happened before the first sight", async () => {
    serve(ticketAnswers({
      "ACME-1": {
        updated: jiraTime(T0 - 10 * MINUTE),
        status: "In Review",
        comments: [comment("10051", alex, T0 - 10 * MINUTE, "Old question")],
        histories: [history(alex, T0 - 20 * MINUTE, [statusItem("To Do", "In Review")])],
      },
    }));
    const clock = fakeClock();
    const result = await waitForIssueChange(waitOptions(clock, { sinceMs: null, timeoutMs: 3 * MINUTE }));
    assert.deepStrictEqual(result, {
      timedOut: true,
      statuses: { "ACME-1": "In Review" },
      newestSeenMs: T0 - 10 * MINUTE,
    });
    assert.ok(!fetchedPaths().some((p) => p.includes("/comment?") || p.includes("/changelog?")));
  });

  it("with no since, keeps the first sight's baseline when that round fails", async () => {
    const tickets = {
      "ACME-1": { updated: jiraTime(T0 - 20 * SECOND), status: "To Do" },
      "ACME-2": { updated: jiraTime(T0 - MINUTE), status: "To Do" },
    };
    const answers = ticketAnswers(tickets);
    const clock = fakeClock((sleeps) => {
      if (sleeps === 1) {
        tickets["ACME-1"].updated = jiraTime(T0 + 10 * SECOND);
        tickets["ACME-1"].comments = [comment("10052", alex, T0 + 10 * SECOND, "Between the rounds")];
      }
    });
    serve((apiPath) =>
      clock.sleeps.length === 0 && apiPath.startsWith("/issue/ACME-2")
        ? response(500, "down")
        : answers(apiPath),
    );
    const result = await waitForIssueChange(
      waitOptions(clock, { sinceMs: null, issueKeys: ["ACME-1", "ACME-2"] }),
    );
    assert.deepStrictEqual(result.found.map((c) => c.id), ["10052"]);
  });

  it("reports the newest time seen across the keys, never below a key's since", async () => {
    serve(ticketAnswers({
      "ACME-1": { updated: jiraTime(T0 - 60 * MINUTE), status: "To Do" },
      "ACME-2": { updated: jiraTime(T0 - 30 * MINUTE), status: "To Do" },
    }));
    const keys = ["ACME-1", "ACME-2"];

    // Both tickets were last updated before the given since: the since wins
    const withSince = await waitForIssueChange(waitOptions(fakeClock(), { issueKeys: keys, timeoutMs: MINUTE }));
    assert.equal(withSince.newestSeenMs, T0);

    // No since: the newest `updated` across the keys
    const withoutSince = await waitForIssueChange(
      waitOptions(fakeClock(), { sinceMs: null, issueKeys: keys, timeoutMs: MINUTE }),
    );
    assert.equal(withoutSince.newestSeenMs, T0 - 30 * MINUTE);
  });

  // ---- the sweep after a find ----

  // Two quiet tickets. In round 2, right after ACME-1 is read, Alex comments
  // on ACME-1 (T0+61s) and moves ACME-2 to Done (T0+62s), so the round finds
  // ACME-2 and only the sweep can see the ACME-1 comment. `failSweep` answers
  // the sweep's requests for ACME-1 matching it with a 503.
  function sweepScenario(failSweep = () => false) {
    const tickets = {
      "ACME-1": { updated: jiraTime(T0 - MINUTE), status: "To Do" },
      "ACME-2": { updated: jiraTime(T0 - MINUTE), status: "To Do" },
    };
    const answers = ticketAnswers(tickets);
    const clock = fakeClock();
    let acme1Reads = 0;
    serve((apiPath) => {
      if (apiPath === "/issue/ACME-1?fields=updated,status") acme1Reads += 1;
      const sweeping = acme1Reads === 3;
      if (sweeping && apiPath.startsWith("/issue/ACME-1") && failSweep(apiPath)) {
        return response(503, "busy");
      }
      const answer = answers(apiPath);
      if (apiPath === "/issue/ACME-1?fields=updated,status" && acme1Reads === 2) {
        tickets["ACME-1"].updated = jiraTime(T0 + 61 * SECOND);
        tickets["ACME-1"].comments = [comment("10080", alex, T0 + 61 * SECOND, "One more thing")];
        tickets["ACME-2"].updated = jiraTime(T0 + 62 * SECOND);
        tickets["ACME-2"].status = "Done";
        tickets["ACME-2"].histories = [history(alex, T0 + 62 * SECOND, [statusItem("To Do", "Done")])];
      }
      return answer;
    });
    return clock;
  }

  it("returns a change that landed on an earlier ticket during the round that found another", async () => {
    const clock = sweepScenario();
    const result = await waitForIssueChange(waitOptions(clock, { issueKeys: ["ACME-1", "ACME-2"] }));
    assert.equal(clock.sleeps.length, 1);
    assert.deepStrictEqual(
      result.found.map((c) => [c.issueKey, c.type, c.id || c.to]),
      [["ACME-1", "comment", "10080"], ["ACME-2", "status", "Done"]],
    );
    assert.deepStrictEqual(result.statuses, { "ACME-1": "To Do", "ACME-2": "Done" });
    assert.equal(result.newestSeenMs, T0 + 62 * SECOND);
    assert.equal(fetchedPaths().filter((p) => p === "/issue/ACME-1?fields=updated,status").length, 3);
    assert.equal(fetchedPaths().filter((p) => p === "/issue/ACME-2?fields=updated,status").length, 2);
  });

  it("keeps the found change when the sweep cannot read the other ticket", async () => {
    const clock = sweepScenario((apiPath) => apiPath === "/issue/ACME-1?fields=updated,status");
    const result = await waitForIssueChange(waitOptions(clock, { issueKeys: ["ACME-1", "ACME-2"] }));
    assert.deepStrictEqual(result.found.map((c) => [c.issueKey, c.type]), [["ACME-2", "status"]]);
    assert.deepStrictEqual(result.statuses, { "ACME-1": "To Do", "ACME-2": "Done" });
    assert.equal(result.newestSeenMs, T0 + 62 * SECOND);
  });

  it("keeps the found change when the sweep cannot read the other ticket's comments", async () => {
    const clock = sweepScenario((apiPath) => apiPath.startsWith("/issue/ACME-1/comment?"));
    const result = await waitForIssueChange(waitOptions(clock, { issueKeys: ["ACME-1", "ACME-2"] }));
    assert.deepStrictEqual(result.found.map((c) => [c.issueKey, c.type]), [["ACME-2", "status"]]);
  });

  it("makes no extra request after finding a change on a single ticket", async () => {
    serve(ticketAnswers({
      "ACME-1": {
        updated: jiraTime(T0 + 10 * SECOND),
        status: "To Do",
        comments: [comment("10081", alex, T0 + 10 * SECOND, "Found it")],
      },
    }));
    const result = await waitForIssueChange(waitOptions(fakeClock()));
    assert.deepStrictEqual(result.found.map((c) => c.id), ["10081"]);
    assert.deepStrictEqual(fetchedPaths().filter((p) => p !== "/myself"), [
      "/issue/ACME-1?fields=updated,status",
      "/issue/ACME-1/comment?orderBy=-created&maxResults=20",
      "/issue/ACME-1/changelog?maxResults=1",
      "/issue/ACME-1/changelog?startAt=0&maxResults=50",
    ]);
  });
});

// ============ waitAnswer ============

describe("waitAnswer", () => {
  const sinceMs = T0;

  it("answers done with the newest change as since", () => {
    const changes = [
      { type: "status", issueKey: "ACME-2", at: "2026-03-02T10:05:00.000Z" },
      { type: "comment", issueKey: "ACME-1", at: "2026-03-02T10:02:00.000Z" },
    ];
    assert.deepStrictEqual(waitAnswer({ found: changes, statuses: {} }, { sinceMs, timeoutSeconds: 1800 }), {
      done: true,
      changes,
      since: "2026-03-02T10:05:00.000Z",
      next: "To wait for the next change call jira_wait_for_change again with this since.",
    });
  });

  it("answers a timeout with the newest time it saw as since", () => {
    const answer = waitAnswer(
      { timedOut: true, statuses: { "ACME-1": "To Do" }, newestSeenMs: T0 + 90 * SECOND },
      { sinceMs, timeoutSeconds: 600 },
    );
    assert.deepStrictEqual(answer, {
      done: false,
      timedOut: true,
      waitedSeconds: 600,
      statuses: { "ACME-1": "To Do" },
      since: "2026-03-02T10:01:30.000Z",
      next: "Nothing new yet. This is a timeout, not an answer: to keep waiting call jira_wait_for_change again with this since.",
    });
  });

  it("falls back to the given since, then to now, when nothing was seen", () => {
    const fromSince = waitAnswer(
      { timedOut: true, statuses: {}, newestSeenMs: -Infinity },
      { sinceMs, timeoutSeconds: 600 },
    );
    assert.equal(fromSince.since, "2026-03-02T10:00:00.000Z");

    const before = Date.now();
    const fromNow = waitAnswer(
      { timedOut: true, statuses: {}, newestSeenMs: -Infinity },
      { sinceMs: null, timeoutSeconds: 600 },
    );
    const sinceTime = Date.parse(fromNow.since);
    assert.ok(sinceTime >= before && sinceTime <= Date.now());
  });

  it("answers cancelled", () => {
    assert.deepStrictEqual(
      waitAnswer({ cancelled: true }, { sinceMs, timeoutSeconds: 1800 }),
      { done: false, cancelled: true },
    );
  });

  it("answers a failure as an error", () => {
    assert.deepStrictEqual(
      waitAnswer({ failed: "Jira API error: 404 Not Found" }, { sinceMs, timeoutSeconds: 1800 }),
      { error: "The wait stopped because Jira could not be read: Jira API error: 404 Not Found" },
    );
  });
});

// ============ jira_wait_for_change tool ============

describe("jira_wait_for_change tool", () => {
  const callToolHandler = toolHandlers["CallToolRequestSchema"];

  beforeEach(() => {
    fetchMock.mock.resetCalls();
  });

  it("is listed as a read tool without dryRun", async () => {
    const { tools } = await toolHandlers["ListToolsRequestSchema"]();
    const tool = tools.find((entry) => entry.name === "jira_wait_for_change");
    assert.ok(tool);
    assert.equal(tool.inputSchema.properties.dryRun, undefined);
    assert.deepStrictEqual(tool.inputSchema.required, ["issueKey"]);
    assert.equal(tool.inputSchema.properties.alsoIssueKeys.maxItems, 9);
    assert.deepStrictEqual(tool.inputSchema.properties.watch.items.enum, ["comments", "status", "any"]);
  });

  it("returns done: true with the change when the ticket changed after since", async () => {
    serve(ticketAnswers({
      "ACME-1": {
        updated: jiraTime(T0 + MINUTE),
        status: "In Review",
        comments: [comment("10040", alex, T0 + MINUTE, "Ready for you")],
      },
    }));
    const result = await callToolHandler({
      params: {
        name: "jira_wait_for_change",
        arguments: { issueKey: "acme-1", since: "2026-03-02T10:00:00Z" },
      },
    });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.done, true);
    assert.equal(payload.since, "2026-03-02T10:01:00.000Z");
    assert.deepStrictEqual(payload.changes.map((c) => [c.issueKey, c.author, c.text]), [
      ["ACME-1", "Alex Example", "Ready for you\n"],
    ]);
    assert.ok(fetchedPaths().includes("/issue/ACME-1?fields=updated,status"));
  });

  it("answers cancelled when the request signal is aborted", async () => {
    serve(ticketAnswers({
      "ACME-1": { updated: jiraTime(T0 - MINUTE), status: "To Do" },
    }));
    const result = await callToolHandler(
      { params: { name: "jira_wait_for_change", arguments: { issueKey: "ACME-1" } } },
      { signal: AbortSignal.abort() },
    );
    assert.deepStrictEqual(JSON.parse(result.content[0].text), { done: false, cancelled: true });
  });

  it("returns isError when Jira cannot be read", async () => {
    serve(ticketAnswers({}));
    const result = await callToolHandler({
      params: {
        name: "jira_wait_for_change",
        arguments: { issueKey: "ACME-404", since: "2026-03-02T10:00:00Z" },
      },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).error, /could not be read: Jira API error: 404/);
  });

  it("without since takes the baseline from Jira, not from this clock", async () => {
    // updated and the comment are after this machine's now: a local-clock
    // since would report the comment, a Jira baseline does not.
    const later = Date.now() + 60 * MINUTE;
    const controller = new AbortController();
    const answers = ticketAnswers({
      "ACME-1": {
        updated: jiraTime(later),
        status: "To Do",
        comments: [comment("10060", alex, later, "Already there")],
      },
    });
    serve((apiPath) => {
      controller.abort();
      return answers(apiPath);
    });
    const result = await callToolHandler(
      { params: { name: "jira_wait_for_change", arguments: { issueKey: "ACME-1" } } },
      { signal: controller.signal },
    );
    assert.deepStrictEqual(JSON.parse(result.content[0].text), { done: false, cancelled: true });
    assert.deepStrictEqual(fetchedPaths(), ["/issue/ACME-1?fields=updated,status"]);
  });

  it("watches at most 9 extra tickets", async () => {
    const tickets = {};
    for (let i = 1; i <= 13; i++) {
      tickets[`ACME-${i}`] = { updated: jiraTime(T0 - MINUTE), status: "To Do" };
    }
    const answers = ticketAnswers(tickets);
    const controller = new AbortController();
    serve((apiPath) => {
      controller.abort();
      return answers(apiPath);
    });
    const alsoIssueKeys = [];
    for (let i = 2; i <= 13; i++) alsoIssueKeys.push(`ACME-${i}`);
    await callToolHandler(
      {
        params: {
          name: "jira_wait_for_change",
          arguments: { issueKey: "ACME-1", alsoIssueKeys, since: "2026-03-02T10:00:00Z" },
        },
      },
      { signal: controller.signal },
    );
    const polled = fetchedPaths().map((p) => p.match(/^\/issue\/([^?]+)\?fields=/)?.[1]).filter(Boolean);
    assert.deepStrictEqual(polled, ["ACME-1", "ACME-2", "ACME-3", "ACME-4", "ACME-5", "ACME-6", "ACME-7", "ACME-8", "ACME-9", "ACME-10"]);
  });

  it("returns isError for a since that is not a time", async () => {
    serve(ticketAnswers({}));
    const result = await callToolHandler({
      params: {
        name: "jira_wait_for_change",
        arguments: { issueKey: "ACME-1", since: "yesterday-ish" },
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /since must be an ISO time, e\.g\. 2026-01-31T09:30:00Z/);
    assert.deepStrictEqual(fetchedPaths(), []);
  });
});

// ============ per-call dry-run state ============

describe("per-call dry-run state", () => {
  const callToolHandler = toolHandlers["CallToolRequestSchema"];
  const transitions = { transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] };

  // The first GET to each path waits until the test releases it.
  function holdFirstGet(paths) {
    const holds = {};
    for (const p of paths) {
      const hold = { used: false };
      hold.reached = new Promise((resolve) => { hold.arrive = resolve; });
      hold.released = new Promise((resolve) => { hold.release = resolve; });
      holds[p] = hold;
    }
    const answers = ticketAnswers({
      "ACME-3": {
        updated: jiraTime(T0 + MINUTE),
        status: "In Review",
        comments: [comment("10070", alex, T0 + MINUTE, "Ready")],
      },
    });
    serve(async (apiPath, options) => {
      const hold = holds[apiPath];
      if (hold && !hold.used && (options.method || "GET") === "GET") {
        hold.used = true;
        hold.arrive();
        await hold.released;
      }
      if (apiPath.endsWith("/transitions")) return ok(transitions);
      return answers(apiPath);
    });
    return holds;
  }

  function transition(issueKey, extra = {}) {
    return callToolHandler({
      params: { name: "jira_transition", arguments: { issueKey, targetStatus: "Done", ...extra } },
    });
  }

  it("keeps a dry-run write dry while a real read call starts and finishes", async () => {
    const holds = holdFirstGet(["/issue/ACME-1/transitions"]);
    const dry = transition("ACME-1", { dryRun: true });
    await holds["/issue/ACME-1/transitions"].reached;

    const read = await callToolHandler({
      params: {
        name: "jira_wait_for_change",
        arguments: { issueKey: "ACME-3", since: "2026-03-02T10:00:00Z" },
      },
    });
    assert.equal(JSON.parse(read.content[0].text).done, true);

    holds["/issue/ACME-1/transitions"].release();
    const payload = JSON.parse((await dry).content[0].text);
    assert.equal(payload.dryRun, true);
    assert.deepStrictEqual(
      payload.plan.map((call) => [call.method, call.endpoint]),
      [["POST", "/issue/ACME-1/transitions"]],
    );
    assert.deepStrictEqual(writes(), []);
  });

  it("still performs a real write that overlaps a dry-run call", async () => {
    const holds = holdFirstGet(["/issue/ACME-1/transitions", "/issue/ACME-2/transitions"]);
    const real = transition("ACME-1");
    await holds["/issue/ACME-1/transitions"].reached;
    const dry = transition("ACME-2", { dryRun: true });
    await holds["/issue/ACME-2/transitions"].reached;

    // The dry-run call is still open while the real one writes
    holds["/issue/ACME-1/transitions"].release();
    const realResult = await real;
    assert.equal(realResult.isError, undefined);
    assert.equal(realResult.content[0].text, "Transitioned ACME-1 to Done.");
    assert.deepStrictEqual(writes(), [["POST", "/issue/ACME-1/transitions"]]);

    holds["/issue/ACME-2/transitions"].release();
    const payload = JSON.parse((await dry).content[0].text);
    assert.equal(payload.dryRun, true);
    assert.deepStrictEqual(writes(), [["POST", "/issue/ACME-1/transitions"]]);
  });

  it("gives each overlapping dry-run call its own plan", async () => {
    const holds = holdFirstGet(["/issue/ACME-1/transitions", "/issue/ACME-2/transitions"]);
    const first = transition("ACME-1", { dryRun: true });
    await holds["/issue/ACME-1/transitions"].reached;
    const second = transition("ACME-2", { dryRun: true });
    await holds["/issue/ACME-2/transitions"].reached;

    holds["/issue/ACME-2/transitions"].release();
    holds["/issue/ACME-1/transitions"].release();
    const [firstPlan, secondPlan] = (await Promise.all([first, second]))
      .map((result) => JSON.parse(result.content[0].text).plan.map((call) => call.endpoint));
    assert.deepStrictEqual(firstPlan, ["/issue/ACME-1/transitions"]);
    assert.deepStrictEqual(secondPlan, ["/issue/ACME-2/transitions"]);
    assert.deepStrictEqual(writes(), []);
  });
});
