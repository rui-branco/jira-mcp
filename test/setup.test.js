const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-mcp-setup-test-"));
const testConfigPath = path.join(testHome, ".config", "jira-mcp", "config.json");
fs.mkdirSync(path.dirname(testConfigPath), { recursive: true });
const setupPath = path.join(__dirname, "..", "setup.js");
const childEnv = {
  ...process.env,
  HOME: testHome,
  JIRA_MCP_CONFIG_PATH: testConfigPath,
};

function writeConfig(config) {
  fs.writeFileSync(testConfigPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function runSetup(...args) {
  return spawnSync(process.execPath, [setupPath, ...args], {
    env: childEnv,
    encoding: "utf8",
  });
}

function readConfig() {
  return JSON.parse(fs.readFileSync(testConfigPath, "utf8"));
}

after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("setup config persistence", { concurrency: false }, () => {
  it("migrates and normalizes legacy projects into the default instance", () => {
    writeConfig({
      email: "legacy@example.com",
      token: "legacy-token",
      baseUrl: "https://legacy.atlassian.net",
      projects: [" old ", "OLD", "new"],
      scopes: { preset: "read-only" },
      dryRun: true,
      defaultTeam: { name: "Legacy Team", id: "legacy-team" },
      projectTeams: { OLD: "none" },
      confluenceBaseUrl: "https://legacy.example.com/wiki",
    });

    const result = runSetup(
      "add",
      "new",
      "new@example.com",
      "new-token",
      "https://new.atlassian.net",
      "NEWPROJECT",
    );

    assert.equal(result.status, 0, result.stderr);
    const config = readConfig();
    assert.equal(config.projects, undefined);
    assert.deepStrictEqual(config.instances[0].projects, ["OLD", "NEW"]);
    assert.deepStrictEqual(config.instances[0].scopes, { preset: "read-only" });
    assert.equal(config.instances[0].dryRun, true);
    assert.deepStrictEqual(config.instances[0].defaultTeam, { name: "Legacy Team", id: "legacy-team" });
    assert.deepStrictEqual(config.instances[0].projectTeams, { OLD: "none" });
    assert.equal(config.instances[0].confluenceBaseUrl, "https://legacy.example.com/wiki");
    assert.deepStrictEqual(config.instances[1].projects, ["NEWPROJECT"]);
  });

  it("updates only credentials and base URL in a legacy config", () => {
    const config = {
      email: "legacy@example.com",
      token: "legacy-token",
      baseUrl: "https://legacy.atlassian.net",
      projects: ["OLD", "LEGACY"],
      scopes: { preset: "read-only" },
      dryRun: true,
      defaultTeam: { name: "Legacy Team", id: "legacy-team" },
      projectTeams: { OLD: "none" },
      confluenceBaseUrl: "https://legacy.example.com/wiki",
      defaultInstance: "legacy",
      audit: { enabled: true },
      custom: { preserve: true },
    };
    writeConfig(config);

    const result = runSetup(
      "updated@example.com",
      "updated-token",
      "https://updated.atlassian.net/",
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepStrictEqual(readConfig(), {
      ...config,
      email: "updated@example.com",
      token: "updated-token",
      baseUrl: "https://updated.atlassian.net",
    });
  });

  it("updates the configured default instance without changing multi-instance config", () => {
    const config = {
      instances: [
        {
          name: "one",
          email: "one@example.com",
          token: "one-token",
          baseUrl: "https://one.atlassian.net",
          projects: ["ONE"],
          scopes: { preset: "read-only" },
          defaultTeam: { name: "One Team", id: "one-team" },
        },
        {
          name: "two",
          email: "two@example.com",
          token: "two-token",
          baseUrl: "https://two.atlassian.net",
          projects: ["TWO"],
          scopes: { preset: "unrestricted" },
          dryRun: true,
          defaultTeam: { name: "Two Team", id: "two-team" },
          projectTeams: { TWO: "two-team" },
          confluenceBaseUrl: "https://two.example.com/wiki",
        },
      ],
      defaultInstance: "two",
      projectMappings: { ONE: "one", TWO: "two" },
      defaults: { team: "two-team" },
      policy: { allowWrites: false },
      audit: { enabled: true },
    };
    const expected = JSON.parse(JSON.stringify(config));
    expected.instances[1].email = "updated@example.com";
    expected.instances[1].token = "updated-token";
    expected.instances[1].baseUrl = "https://updated.atlassian.net";
    writeConfig(config);

    const result = runSetup(
      "updated@example.com",
      "updated-token",
      "https://updated.atlassian.net/",
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepStrictEqual(readConfig(), expected);
  });

  it("falls back to the first instance when no default is configured", () => {
    const config = {
      instances: [
        {
          name: "first",
          email: "first@example.com",
          token: "first-token",
          baseUrl: "https://first.atlassian.net",
          projects: ["FIRST"],
        },
        {
          name: "second",
          email: "second@example.com",
          token: "second-token",
          baseUrl: "https://second.atlassian.net",
          projects: ["SECOND"],
        },
      ],
      mappings: { FIRST: "first", SECOND: "second" },
    };
    const expected = JSON.parse(JSON.stringify(config));
    expected.instances[0].email = "updated@example.com";
    expected.instances[0].token = "updated-token";
    expected.instances[0].baseUrl = "https://updated.atlassian.net";
    writeConfig(config);

    const result = runSetup(
      "updated@example.com",
      "updated-token",
      "https://updated.atlassian.net/",
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepStrictEqual(readConfig(), expected);
  });

  it("rejects duplicate project ownership when adding an instance", () => {
    writeConfig({
      instances: [
        {
          name: "one",
          email: "one@example.com",
          token: "one-token",
          baseUrl: "https://one.atlassian.net",
          projects: ["DUP"],
        },
      ],
      defaultInstance: "one",
    });

    const result = runSetup(
      "add",
      "two",
      "two@example.com",
      "two-token",
      "https://two.atlassian.net",
      "DUP",
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already mapped|multiple/i);
    assert.deepStrictEqual(readConfig().instances.map((instance) => instance.name), ["one"]);
  });
});
