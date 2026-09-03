const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const configPath = path.resolve(
  process.env.JIRA_MCP_CONFIG_PATH ||
    path.join(process.env.HOME, ".config/jira-mcp/config.json"),
);
const configuredLockWaitMs = Number(process.env.JIRA_MCP_LOCK_WAIT_MS);
const LOCK_WAIT_MS =
  Number.isInteger(configuredLockWaitMs) && configuredLockWaitMs > 0
    ? configuredLockWaitMs
    : 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;
const HOSTNAME = os.hostname();
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const UNSUPPORTED_FS_ERRORS = new Set([
  "EINVAL",
  "EISDIR",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

function normalizeProjects(projects) {
  return [...new Set(
    (Array.isArray(projects) ? projects : [])
      .filter((project) => typeof project === "string")
      .map((project) => project.trim().toUpperCase())
      .filter(Boolean),
  )];
}

function resolveConfigTargetPath() {
  let current = configPath;
  const seen = new Set();
  while (true) {
    if (seen.has(current)) {
      throw new Error(`Jira config path contains a symlink cycle: ${configPath}.`);
    }
    seen.add(current);

    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      let parent = path.dirname(current);
      try {
        parent = fs.realpathSync(parent);
      } catch (parentError) {
        if (parentError.code !== "ENOENT") throw parentError;
      }
      return path.join(parent, path.basename(current));
    }

    if (!stat.isSymbolicLink()) {
      try {
        return fs.realpathSync(current);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return current;
      }
    }
    current = path.resolve(path.dirname(current), fs.readlinkSync(current));
  }
}

function isUnsupportedFsError(error) {
  return UNSUPPORTED_FS_ERRORS.has(error.code) ||
    (process.platform === "win32" && error.code === "EPERM");
}

function sleepSync(milliseconds) {
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function createOwnershipMetadata() {
  const createdAt = Date.now();
  return {
    owner: `${process.pid}-${createdAt}-${crypto.randomBytes(16).toString("hex")}`,
    pid: process.pid,
    hostname: HOSTNAME,
    createdAt,
    state: "held",
  };
}

function syncFile(fd) {
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    if (!isUnsupportedFsError(error)) throw error;
  }
}

function writeClaimMetadata(fd, metadata) {
  const contents = `${JSON.stringify(metadata)}\n`;
  const written = fs.writeSync(fd, contents, 0, "utf8");
  if (written !== Buffer.byteLength(contents)) {
    throw new Error("Could not write the Jira config lock claim completely.");
  }
  syncFile(fd);
}

function parseClaimMetadata(contents) {
  try {
    const metadata = JSON.parse(contents);
    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata
      : null;
  } catch {
    return null;
  }
}

function isValidClaimMetadata(metadata) {
  return Boolean(
    metadata &&
    typeof metadata.owner === "string" &&
    metadata.owner.length > 0 &&
    Number.isSafeInteger(metadata.pid) &&
    metadata.pid > 0 &&
    typeof metadata.hostname === "string" &&
    metadata.hostname.length > 0 &&
    typeof metadata.createdAt === "number" &&
    Number.isFinite(metadata.createdAt) &&
    (metadata.state === "held" || metadata.state === "released"),
  );
}

function readClaimSnapshot(claimPath) {
  let stat;
  try {
    stat = fs.statSync(claimPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile()) return { stat, contents: null, metadata: null };

  let contents;
  try {
    contents = fs.readFileSync(claimPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return {
    stat,
    contents,
    metadata: parseClaimMetadata(contents),
  };
}

function sameFile(statA, statB) {
  return statA.dev === statB.dev && statA.ino === statB.ino;
}

function sameClaimSnapshot(expected, current) {
  return sameFile(expected.stat, current.stat) &&
    expected.contents === current.contents;
}

function isOlderThanStale(snapshot) {
  const timestamp = isValidClaimMetadata(snapshot.metadata)
    ? snapshot.metadata.createdAt
    : snapshot.stat.mtimeMs;
  return Date.now() - timestamp > LOCK_STALE_MS;
}

function listClaims(lockPath) {
  let names;
  try {
    names = fs.readdirSync(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  return names
    .filter((name) => /^\d+$/.test(name))
    .map((name) => ({
      ticket: BigInt(name),
      claimPath: path.join(lockPath, name),
    }))
    .filter(({ ticket }) => ticket > 0n)
    .sort((left, right) => left.ticket < right.ticket ? -1 : 1);
}

function ensureLockDirectory(lockPath) {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!fs.statSync(lockPath).isDirectory()) {
      throw new Error(`Jira config lock path "${lockPath}" is not a directory.`);
    }
  }
}

function lockTimeout(lockPath) {
  return new Error(`Timed out waiting for the Jira config lock "${lockPath}".`);
}

function allocateClaimSync(lockPath, deadline) {
  while (true) {
    if (Date.now() >= deadline) throw lockTimeout(lockPath);
    ensureLockDirectory(lockPath);

    const claims = listClaims(lockPath);
    const maxTicket = claims.reduce(
      (max, claim) => claim.ticket > max ? claim.ticket : max,
      0n,
    );
    const ticket = maxTicket + 1n;
    const claimPath = path.join(lockPath, ticket.toString());
    let fd = null;
    try {
      const metadata = createOwnershipMetadata();
      fd = fs.openSync(claimPath, "wx", 0o600);
      writeClaimMetadata(fd, metadata);
      return {
        fd,
        lockPath,
        claimPath,
        ticket,
        owner: metadata.owner,
        metadata,
      };
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
        throw error;
      }
      if (error.code !== "EEXIST" && error.code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw lockTimeout(lockPath);
      sleepSync(Math.min(LOCK_RETRY_MS, deadline - Date.now()));
    }
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function getClaimStatus(snapshot) {
  if (!snapshot) return "absent";
  if (!isValidClaimMetadata(snapshot.metadata)) {
    return isOlderThanStale(snapshot) ? "stale" : "waiting";
  }
  if (snapshot.metadata.state === "released") return "released";

  if (snapshot.metadata.hostname === HOSTNAME) {
    return isPidAlive(snapshot.metadata.pid) ? "waiting" : "stale";
  }
  // A PID on another host cannot be checked safely. Fail closed rather than
  // reclaiming a potentially live claim on a shared filesystem.
  return "waiting";
}

function unlinkClaimIfUnchanged(snapshot) {
  if (!snapshot.stat.isFile()) return;
  const current = readClaimSnapshot(snapshot.claimPath);
  if (!current || !sameClaimSnapshot(snapshot, current)) return;
  try {
    fs.unlinkSync(snapshot.claimPath);
  } catch {}
}

function waitForLowerClaims(claim, deadline) {
  while (true) {
    let blocked = false;
    const lowerClaims = listClaims(claim.lockPath)
      .filter(({ ticket }) => ticket < claim.ticket);
    for (const lowerClaim of lowerClaims) {
      const snapshot = readClaimSnapshot(lowerClaim.claimPath);
      const status = getClaimStatus(snapshot);
      if (status === "stale" || status === "released") {
        if (snapshot) unlinkClaimIfUnchanged({ ...snapshot, claimPath: lowerClaim.claimPath });
      } else if (status === "waiting") {
        blocked = true;
      }
    }
    if (!blocked) return;
    if (Date.now() >= deadline) throw lockTimeout(claim.lockPath);
    sleepSync(Math.min(LOCK_RETRY_MS, deadline - Date.now()));
  }
}

function releaseClaim(claim) {
  try {
    const snapshot = readClaimSnapshot(claim.claimPath);
    const fdStat = fs.fstatSync(claim.fd);
    if (
      !snapshot ||
      !snapshot.metadata ||
      snapshot.metadata.owner !== claim.owner ||
      !sameFile(fdStat, snapshot.stat)
    ) {
      return;
    }

    let releaseError = null;
    try {
      const releasedMetadata = { ...snapshot.metadata, state: "released" };
      fs.ftruncateSync(claim.fd, 0);
      writeClaimMetadata(claim.fd, releasedMetadata);
    } catch (error) {
      releaseError = error;
    }

    let unlinked = false;
    try {
      const current = readClaimSnapshot(claim.claimPath);
      if (current && sameFile(fdStat, current.stat)) {
        fs.unlinkSync(claim.claimPath);
        unlinked = true;
      }
    } catch (error) {
      if (!releaseError) releaseError = error;
    }

    // Either a durable released marker or an absent claim lets later tickets
    // proceed. Only surface a release error if neither outcome was achieved.
    if (releaseError && !unlinked) {
      const status = getClaimStatus(readClaimSnapshot(claim.claimPath));
      if (status !== "released" && status !== "absent") throw releaseError;
    }
    try { fs.rmdirSync(claim.lockPath); } catch {}
  } finally {
    try { fs.closeSync(claim.fd); } catch {}
  }
}

function acquireLockSync(targetPath) {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const claim = allocateClaimSync(lockPath, deadline);
  claim.targetPath = targetPath;
  try {
    waitForLowerClaims(claim, deadline);
    return claim;
  } catch (error) {
    try { releaseClaim(claim); } catch {}
    throw error;
  }
}

function inspectConfigTarget(targetPath) {
  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error(`Jira config target "${targetPath}" is not a regular file.`);
  }
  if (
    typeof process.getuid === "function" &&
    typeof stat.uid === "number" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(`Jira config target "${targetPath}" is not owned by the current user.`);
  }
  return stat;
}

function readConfigAtTarget(targetPath) {
  inspectConfigTarget(targetPath);
  try {
    return JSON.parse(fs.readFileSync(targetPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function syncParentDirectory(directory) {
  let fd = null;
  try {
    fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      if (!isUnsupportedFsError(error)) throw error;
    }
  } catch (error) {
    if (!isUnsupportedFsError(error)) throw error;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function writeConfigFileAtomically(config, targetPath = resolveConfigTargetPath()) {
  const serialized = JSON.stringify(config, null, 2);
  const configDir = path.dirname(targetPath);
  const baseName = path.basename(targetPath);
  const existingStat = inspectConfigTarget(targetPath);
  const existingMode = existingStat ? existingStat.mode & 0o7777 : null;
  let tempPath = null;
  let fd = null;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    for (let attempt = 0; attempt < 10; attempt++) {
      tempPath = path.join(
        configDir,
        `.${baseName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.${attempt}.tmp`,
      );
      try {
        fd = fs.openSync(tempPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    if (fd === null) throw new Error("Could not create a unique Jira config temporary file.");
    if (existingMode !== null) {
      try {
        fs.fchmodSync(fd, existingMode);
      } catch (error) {
        if (!isUnsupportedFsError(error)) throw error;
      }
    }
    fs.writeFileSync(fd, serialized, "utf8");
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      if (!isUnsupportedFsError(error)) throw error;
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, targetPath);
    tempPath = null;
    syncParentDirectory(configDir);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }
}

function withConfigLockSync(callback) {
  const lock = acquireLockSync(resolveConfigTargetPath());
  try {
    return callback(lock);
  } finally {
    releaseClaim(lock);
  }
}

function updateConfigSync(mutator) {
  return withConfigLockSync(({ targetPath }) => {
    const config = readConfigAtTarget(targetPath);
    const result = mutator(config);
    writeConfigFileAtomically(config, targetPath);
    return result;
  });
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function loadConfigStrict() {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function migrateLegacyConfig(config, name = "default") {
  if (Array.isArray(config.instances)) return false;
  if (config.instances !== undefined) {
    throw new Error("Jira config has an invalid instances value.");
  }

  if (
    config.email !== undefined ||
    config.token !== undefined ||
    config.baseUrl !== undefined ||
    config.projects !== undefined
  ) {
    const legacyInstance = {
      name,
      email: config.email,
      token: config.token,
      baseUrl: config.baseUrl,
      projects: normalizeProjects(config.projects),
    };
    for (const field of ["scopes", "dryRun", "defaultTeam", "projectTeams", "confluenceBaseUrl"]) {
      if (config[field] !== undefined) legacyInstance[field] = config[field];
    }
    config.instances = [legacyInstance];
    if (!config.defaultInstance) config.defaultInstance = name;
    delete config.email;
    delete config.token;
    delete config.baseUrl;
    delete config.projects;
    return true;
  }

  config.instances = [];
  return true;
}

function assertNoDuplicateProjectOwnership(config, instanceName, projects) {
  const normalized = normalizeProjects(projects);
  if (!Array.isArray(config.instances)) {
    throw new Error("Jira config must use instances before project ownership is updated.");
  }
  for (const prefix of normalized) {
    const owners = config.instances.filter(
      (instance) =>
        instance.name !== instanceName &&
        normalizeProjects(instance.projects).includes(prefix),
    );
    if (owners.length > 0) {
      throw new Error(
        `Project prefix "${prefix}" is already mapped to Jira instance(s) ${owners.map((owner) => `"${owner.name}"`).join(", ")}.`,
      );
    }
  }
}

module.exports = {
  configPath,
  loadConfig,
  loadConfigStrict,
  normalizeProjects,
  resolveConfigTargetPath,
  migrateLegacyConfig,
  assertNoDuplicateProjectOwnership,
  writeConfigFileAtomically,
  withConfigLockSync,
  updateConfigSync,
};
