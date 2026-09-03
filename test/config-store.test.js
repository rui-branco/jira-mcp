const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-mcp-config-store-test-"));
const configDir = path.join(testHome, ".config", "jira-mcp");
const configPath = path.join(configDir, "config.json");
const targetPath = path.join(configDir, "config-target.json");
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(targetPath, JSON.stringify({
  instances: [{ name: "one", projects: [] }],
  defaultInstance: "one",
}, null, 2));

let symlinkSupported = true;
try {
  fs.symlinkSync(path.basename(targetPath), configPath);
} catch (error) {
  if (["EACCES", "EPERM", "ENOSYS", "ENOTSUP"].includes(error.code)) {
    symlinkSupported = false;
    fs.copyFileSync(targetPath, configPath);
  } else {
    throw error;
  }
}

let modeSupported = true;
const expectedMode = 0o640;
try {
  fs.chmodSync(configPath, expectedMode);
  modeSupported = (fs.statSync(configPath).mode & 0o7777) === expectedMode;
} catch (error) {
  if (["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
    modeSupported = false;
  } else {
    throw error;
  }
}

process.env.HOME = testHome;
process.env.JIRA_MCP_CONFIG_PATH = configPath;
const configStore = require("../config-store.js");

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function spawnChild(prefix, lockWaitMs) {
  const modulePath = path.join(__dirname, "..", "config-store.js");
  const script = `
    const store = require(${JSON.stringify(modulePath)});
    const prefix = process.argv[1];
    store.updateConfigSync((config) => {
      const instance = config.instances.find((item) => item.name === "one");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      instance.projects.push(prefix);
    });
  `;
  return spawn(process.execPath, ["-e", script, prefix], {
    env: {
      ...process.env,
      ...(lockWaitMs ? { JIRA_MCP_LOCK_WAIT_MS: String(lockWaitMs) } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runChild(prefix, lockWaitMs) {
  return waitForChild(spawnChild(prefix, lockWaitMs));
}

function runTicketChild(prefix, coordinationDir) {
  const modulePath = path.join(__dirname, "..", "config-store.js");
  const script = `
    const fs = require("fs");
    const path = require("path");
    const lockPath = process.env.JIRA_MCP_TEST_LOCK_PATH;
    const prefix = process.argv[1];
    const coordinationDir = process.argv[2];
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    const signal = (name) => fs.writeFileSync(path.join(coordinationDir, name), "");
    const waitForSignal = (name) => {
      while (!fs.existsSync(path.join(coordinationDir, name))) {
        Atomics.wait(waitBuffer, 0, 0, 5);
      }
    };

    const originalOpenSync = fs.openSync;
    let claimSignaled = false;
    fs.openSync = (filePath, flags, mode) => {
      const fd = originalOpenSync(filePath, flags, mode);
      if (
        !claimSignaled &&
        flags === "wx" &&
        filePath.startsWith(lockPath + path.sep)
      ) {
        claimSignaled = true;
        signal("claimed-" + prefix);
        waitForSignal("start-updates");
      }
      return fd;
    };

    const store = require(${JSON.stringify(modulePath)});
    store.updateConfigSync((config) => {
      const instance = config.instances.find((item) => item.name === "one");
      Atomics.wait(waitBuffer, 0, 0, 100);
      instance.projects.push(prefix);
    });
  `;
  return spawn(process.execPath, ["-e", script, prefix, coordinationDir], {
    env: {
      ...process.env,
      JIRA_MCP_TEST_LOCK_PATH: `${configStore.resolveConfigTargetPath()}.lock`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runHeldChild(prefix, coordinationDir) {
  const modulePath = path.join(__dirname, "..", "config-store.js");
  const script = `
    const fs = require("fs");
    const path = require("path");
    const prefix = process.argv[1];
    const coordinationDir = process.argv[2];
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    const signal = (name) => fs.writeFileSync(path.join(coordinationDir, name), "");
    const waitForSignal = (name) => {
      while (!fs.existsSync(path.join(coordinationDir, name))) {
        Atomics.wait(waitBuffer, 0, 0, 5);
      }
    };
    const store = require(${JSON.stringify(modulePath)});
    store.updateConfigSync((config) => {
      const instance = config.instances.find((item) => item.name === "one");
      signal("owner-held");
      waitForSignal("release-owner");
      instance.projects.push(prefix);
    });
  `;
  return spawn(process.execPath, ["-e", script, prefix, coordinationDir], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createDeadClaim(claimPath) {
  const script = `
    const fs = require("fs");
    const os = require("os");
    const claimPath = process.argv[1];
    const fd = fs.openSync(claimPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({
      owner: "dead-" + process.pid,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: Date.now(),
      state: "held",
    }));
    fs.closeSync(fd);
  `;
  return spawnSync(process.execPath, ["-e", script, claimPath], {
    encoding: "utf8",
  });
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Child exited with ${code}: ${stderr}`));
    });
  });
}

function waitForChildResult(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForEither(filePaths) {
  const deadline = Date.now() + 5000;
  while (!filePaths.some((filePath) => fs.existsSync(filePath))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${filePaths.join(" or ")}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("config store", { concurrency: false }, () => {
  it("updates the symlink target atomically and preserves its mode", () => {
    configStore.updateConfigSync((config) => {
      config.instances[0].projects.push("SYMLINK");
    });

    assert.equal(readConfig().instances[0].projects.includes("SYMLINK"), true);
    if (symlinkSupported) {
      assert.equal(fs.lstatSync(configPath).isSymbolicLink(), true);
      assert.equal(fs.realpathSync(configPath), fs.realpathSync(targetPath));
    }
    if (modeSupported) {
      assert.equal(fs.statSync(configPath).mode & 0o7777, expectedMode);
    }
    assert.equal(fs.readdirSync(configDir).some((name) => name.endsWith(".tmp")), false);
    assert.equal(fs.existsSync(`${configStore.resolveConfigTargetPath()}.lock`), false);
  });

  it("recovers a stale ticket claim without a recovery guard", () => {
    const lockPath = `${configStore.resolveConfigTargetPath()}.lock`;
    const claimPath = path.join(lockPath, "1");
    const old = new Date(Date.now() - 60000);
    fs.mkdirSync(lockPath);
    fs.writeFileSync(claimPath, "stale");
    fs.utimesSync(claimPath, old, old);

    configStore.updateConfigSync((config) => {
      config.instances[0].projects.push("STALE");
    });

    assert.equal(readConfig().instances[0].projects.includes("STALE"), true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(`${lockPath}.recovery`), false);
  });

  it("serializes updates from separate processes without losing mappings", async () => {
    await Promise.all([runChild("CHILD_A"), runChild("CHILD_B")]);

    const projects = readConfig().instances[0].projects;
    assert.equal(projects.includes("CHILD_A"), true);
    assert.equal(projects.includes("CHILD_B"), true);
    if (symlinkSupported) assert.equal(fs.lstatSync(configPath).isSymbolicLink(), true);
  });

  it("recovers a concurrent dead claim without losing updates", async () => {
    const lockPath = `${configStore.resolveConfigTargetPath()}.lock`;
    const coordinationDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-mcp-dead-claim-"));
    fs.mkdirSync(lockPath);
    const deadClaimPath = path.join(lockPath, "1");
    const deadClaim = createDeadClaim(deadClaimPath);
    assert.equal(deadClaim.status, 0, deadClaim.stderr);

    const first = runTicketChild("RECOVERY_A", coordinationDir);
    const firstDone = waitForChild(first);
    const second = runTicketChild("RECOVERY_B", coordinationDir);
    const secondDone = waitForChild(second);
    try {
      await Promise.all([
        waitForFile(path.join(coordinationDir, "claimed-RECOVERY_A")),
        waitForFile(path.join(coordinationDir, "claimed-RECOVERY_B")),
      ]);
      assert.deepStrictEqual(
        fs.readdirSync(lockPath).filter((name) => /^\d+$/.test(name)).sort(),
        ["1", "2", "3"],
      );
      fs.writeFileSync(path.join(coordinationDir, "start-updates"), "");
      await Promise.all([firstDone, secondDone]);
    } finally {
      if (first.exitCode === null) first.kill();
      if (second.exitCode === null) second.kill();
      fs.rmSync(coordinationDir, { recursive: true, force: true });
    }

    const projects = readConfig().instances[0].projects;
    assert.equal(projects.includes("RECOVERY_A"), true);
    assert.equal(projects.includes("RECOVERY_B"), true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(`${lockPath}.recovery`), false);
  });

  it("does not reclaim an aged claim owned by a live process", async () => {
    const lockPath = `${configStore.resolveConfigTargetPath()}.lock`;
    const coordinationDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-mcp-live-claim-"));
    const owner = runHeldChild("LIVE_OWNER", coordinationDir);
    const ownerDone = waitForChild(owner);
    let contender;
    try {
      await waitForFile(path.join(coordinationDir, "owner-held"));
      const [claimName] = fs.readdirSync(lockPath).filter((name) => /^\d+$/.test(name));
      const claimPath = path.join(lockPath, claimName);
      const metadata = JSON.parse(fs.readFileSync(claimPath, "utf8"));
      const old = new Date(Date.now() - 60000);
      metadata.createdAt = old.getTime();
      fs.writeFileSync(claimPath, JSON.stringify(metadata));
      fs.utimesSync(claimPath, old, old);

      contender = spawnChild("LIVE_CONTENDER", 200);
      const contenderResult = await waitForChildResult(contender);
      assert.notEqual(contenderResult.code, 0);
      assert.match(contenderResult.stderr, /Timed out waiting for the Jira config lock/);
      assert.equal(fs.existsSync(`${lockPath}.recovery`), false);
      assert.equal(readConfig().instances[0].projects.includes("LIVE_CONTENDER"), false);
      fs.writeFileSync(path.join(coordinationDir, "release-owner"), "");
      await ownerDone;
    } finally {
      if (contender && contender.exitCode === null) contender.kill();
      if (owner.exitCode === null) {
        fs.writeFileSync(path.join(coordinationDir, "release-owner"), "");
        try { await ownerDone; } catch {}
      }
      fs.rmSync(coordinationDir, { recursive: true, force: true });
    }

    const projects = readConfig().instances[0].projects;
    assert.equal(projects.includes("LIVE_OWNER"), true);
    assert.equal(projects.includes("LIVE_CONTENDER"), false);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(`${lockPath}.recovery`), false);
  });
});
