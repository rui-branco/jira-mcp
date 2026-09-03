#!/usr/bin/env node

const readline = require("readline");
const fs = require("fs");
const path = require("path");
const configStore = require("./config-store.js");

const configPath = configStore.configPath;

// Check for command line arguments
let args = process.argv.slice(2);
// Skip "setup" arg if called via index.js
if (args[0] === "setup") args = args.slice(1);

// Load existing config if present
function loadConfig() {
  return configStore.loadConfig();
}

function saveConfig(mutator) {
  return configStore.updateConfigSync(mutator);
}

// Non-interactive: setup add <name> <email> <token> <baseUrl> <projects>
if (args[0] === "add" && args.length >= 5) {
  const [, name, email, token, baseUrl, ...projectArgs] = args;
  const projects = projectArgs.length > 0
    ? configStore.normalizeProjects(projectArgs.join(",").split(","))
    : [];

  let saved;
  try {
    saved = saveConfig((config) => {
      configStore.migrateLegacyConfig(config);
      const existingIdx = config.instances.findIndex((instance) => instance.name === name);
      const previous = existingIdx >= 0 ? config.instances[existingIdx] : {};
      const mergedProjects = configStore.normalizeProjects([
        ...(previous.projects || []),
        ...projects,
      ]);
      configStore.assertNoDuplicateProjectOwnership(config, name, mergedProjects);
      const instance = {
        ...previous,
        name,
        email,
        token,
        baseUrl: baseUrl.replace(/\/$/, ""),
        projects: mergedProjects,
      };
      if (existingIdx >= 0) {
        config.instances[existingIdx] = instance;
      } else {
        config.instances.push(instance);
      }
      if (!config.defaultInstance) config.defaultInstance = name;
      return { instance };
    });
  } catch (error) {
    console.error("Setup failed:", error.message);
    process.exit(1);
  }

  console.log(`Instance "${name}" saved to ${configPath}`);
  if (saved.instance.projects.length > 0) {
    console.log(`Projects: ${saved.instance.projects.join(", ")}`);
  }
  process.exit(0);
}

// Non-interactive: setup remove <name>
if (args[0] === "remove" && args.length >= 2) {
  const name = args[1];
  let removed;
  try {
    removed = saveConfig((config) => {
      if (!Array.isArray(config.instances)) {
        throw new Error("No multi-instance config found.");
      }
      config.instances = config.instances.filter((instance) => instance.name !== name);
      if (config.defaultInstance === name) {
        config.defaultInstance = config.instances[0]?.name || null;
      }
      return { defaultInstance: config.defaultInstance };
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  console.log(`Instance "${name}" removed.`);
  process.exit(0);
}

// Non-interactive: setup <email> <token> <baseUrl> (legacy single-instance)
if (args.length >= 3 && args[0] !== "add" && args[0] !== "remove") {
  const [email, token, baseUrl] = args;
  try {
    saveConfig((config) => {
      const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
      if (Array.isArray(config.instances)) {
        const instance =
          config.instances.find((candidate) => candidate.name === config.defaultInstance) ||
          config.instances[0];
        if (!instance) throw new Error("No Jira instances are configured.");
        instance.email = email;
        instance.token = token;
        instance.baseUrl = normalizedBaseUrl;
      } else {
        if (config.instances !== undefined) {
          throw new Error("Jira config has an invalid instances value.");
        }
        config.email = email;
        config.token = token;
        config.baseUrl = normalizedBaseUrl;
      }
    });
  } catch (error) {
    console.error("Setup failed:", error.message);
    process.exit(1);
  }
  console.log(`Config saved to ${configPath}`);
  process.exit(0);
}

// Interactive mode
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function setup() {
  const existing = loadConfig();
  const hasInstances = existing?.instances?.length > 0;
  const isOldFormat = existing?.email && !existing?.instances;

  console.log("\n=== Jira MCP Setup ===\n");

  if (hasInstances || isOldFormat) {
    if (isOldFormat) {
      console.log(`Existing single-instance config found (${existing.baseUrl})\n`);
    } else {
      console.log("Existing instances:");
      const missingTeam = [];
      for (const inst of existing.instances) {
        const isDefault = inst.name === existing.defaultInstance ? " (default)" : "";
        const projs = inst.projects?.length > 0 ? ` [${inst.projects.join(", ")}]` : "";
        const team = inst.defaultTeam ? ` | Team: ${inst.defaultTeam.name}` : "";
        console.log(`  - ${inst.name}${isDefault}: ${inst.baseUrl}${projs}${team}`);
        if (!inst.defaultTeam) missingTeam.push(inst.name);
      }
      if (missingTeam.length > 0) {
        console.log(`\n  ⚠ No default team: ${missingTeam.join(", ")}`);
      }
      console.log();
    }

    const action = await ask("Add new instance, set default team, or fresh setup? (add/team/fresh): ");
    const choice = action.trim().toLowerCase();
    if (choice === "fresh") {
      // Fall through to single setup
    } else if (choice === "team") {
      return await setInstanceTeam(existing);
    } else {
      // Add instance to multi-instance config
      return await addInstance(existing);
    }
  }

  console.log("To get your Jira API token:");
  console.log("1. Go to https://id.atlassian.com/manage-profile/security/api-tokens");
  console.log("2. Click 'Create API token'");
  console.log("3. Copy the token\n");

  const email = await ask("Jira email: ");
  const token = await ask("Jira API token: ");
  const baseUrl = await ask("Jira base URL (e.g., https://company.atlassian.net): ");

  const config = { email, token, baseUrl: baseUrl.replace(/\/$/, "") };
  const authStr = Buffer.from(`${email}:${token}`).toString("base64");
  const team = await pickDefaultTeam(baseUrl.replace(/\/$/, ""), authStr);
  if (team) config.defaultTeam = team;

  saveConfig((latest) => {
    for (const key of Object.keys(latest)) delete latest[key];
    Object.assign(latest, config);
  });
  console.log(`\nConfig saved to ${configPath}`);

  printFigmaStatus();
  printSetupComplete();
  rl.close();
}

async function pickDefaultTeam(baseUrl, authStr) {
  console.log("\nFetching available teams from Jira...");
  try {
    const response = await fetch(`${baseUrl}/rest/teams/1.0/teams/find?query=&excludeMembers=true`, {
      headers: {
        Authorization: `Basic ${authStr}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      console.log("Could not fetch teams (API returned " + response.status + "). Skipping team setup.");
      return null;
    }
    const teams = JSON.parse(await response.text());
    if (!teams || teams.length === 0) {
      console.log("No teams found. Skipping team setup.");
      return null;
    }

    console.log("\nAvailable teams:");
    for (let i = 0; i < teams.length; i++) {
      console.log(`  ${i + 1}. ${teams[i].title}`);
    }
    const choice = await ask("\nSelect default team number (or press Enter to skip): ");
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= teams.length) {
      console.log("No default team set.");
      return null;
    }
    const selected = teams[idx];
    const teamObj = { name: selected.title, id: `${selected.organizationId}-${selected.id}` };
    console.log(`Default team set to: ${teamObj.name}`);
    return teamObj;
  } catch (e) {
    console.log("Could not fetch teams: " + e.message + ". Skipping team setup.");
    return null;
  }
}

async function setInstanceTeam(config) {
  if (!config.instances || config.instances.length === 0) {
    console.log("No instances configured.");
    rl.close();
    return;
  }

  let target;
  if (config.instances.length === 1) {
    target = config.instances[0];
    console.log(`\nConfiguring team for "${target.name}"...`);
  } else {
    console.log("\nWhich instance?");
    for (let i = 0; i < config.instances.length; i++) {
      const inst = config.instances[i];
      const team = inst.defaultTeam ? ` (current: ${inst.defaultTeam.name})` : " (no team)";
      console.log(`  ${i + 1}. ${inst.name}${team}`);
    }
    const choice = await ask("Select instance number: ");
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= config.instances.length) {
      console.log("Invalid selection.");
      rl.close();
      return;
    }
    target = config.instances[idx];
  }

  const authStr = Buffer.from(`${target.email}:${target.token}`).toString("base64");
  const team = await pickDefaultTeam(target.baseUrl, authStr);
  if (team) {
    const targetName = target.name;
    saveConfig((latest) => {
      const current = latest.instances?.find((instance) => instance.name === targetName);
      if (!current) throw new Error(`Instance "${targetName}" no longer exists.`);
      current.defaultTeam = team;
    });
    console.log(`\nSaved default team "${team.name}" for instance "${target.name}".`);
  } else {
    console.log("No changes made.");
  }
  rl.close();
}

async function addInstance(config) {
  let legacyName = null;
  let legacyProjects = [];
  if (config.email && !config.instances) {
    const oldName = await ask("Name for your existing instance (e.g., work): ");
    const oldProjects = await ask("Project prefixes for existing instance (comma-separated, e.g., MODS,ENG): ");
    legacyName = oldName.trim() || "default";
    legacyProjects = configStore.normalizeProjects(oldProjects.split(","));
  }

  console.log("\n--- Add New Instance ---\n");
  console.log("To get your Jira API token:");
  console.log("1. Go to https://id.atlassian.com/manage-profile/security/api-tokens");
  console.log("2. Click 'Create API token'");
  console.log("3. Copy the token\n");

  const name = await ask("Instance name (e.g., personal): ");
  const email = await ask("Jira email: ");
  const token = await ask("Jira API token: ");
  const baseUrl = await ask("Jira base URL (e.g., https://company.atlassian.net): ");
  const projectsInput = await ask("Project prefixes (comma-separated, e.g., SIDE,FUN): ");
  const projects = configStore.normalizeProjects(projectsInput.split(","));

  const trimmedBaseUrl = baseUrl.trim().replace(/\/$/, "");
  const authStr = Buffer.from(`${email.trim()}:${token.trim()}`).toString("base64");
  const team = await pickDefaultTeam(trimmedBaseUrl, authStr);

  const instance = {
    name: name.trim(),
    email: email.trim(),
    token: token.trim(),
    baseUrl: trimmedBaseUrl,
    projects,
  };
  if (team) instance.defaultTeam = team;

  const setDefault = await ask(`Set "${instance.name}" as default? (y/N): `);
  const makeDefault = setDefault.trim().toLowerCase() === "y";

  const savedConfig = saveConfig((latest) => {
    if (legacyName && !Array.isArray(latest.instances)) {
      configStore.migrateLegacyConfig(latest, legacyName);
      const migrated = latest.instances.find((item) => item.name === legacyName);
      migrated.projects = configStore.normalizeProjects([
        ...(migrated.projects || []),
        ...legacyProjects,
      ]);
    } else {
      configStore.migrateLegacyConfig(latest);
    }

    const idx = latest.instances.findIndex((item) => item.name === instance.name);
    const previous = idx >= 0 ? latest.instances[idx] : {};
    const savedProjects = configStore.normalizeProjects([
      ...(previous.projects || []),
      ...instance.projects,
    ]);
    configStore.assertNoDuplicateProjectOwnership(latest, instance.name, savedProjects);
    const toSave = {
      ...previous,
      ...instance,
      projects: savedProjects,
    };
    if (idx >= 0) {
      latest.instances[idx] = toSave;
    } else {
      latest.instances.push(toSave);
    }
    if (!latest.defaultInstance || makeDefault) {
      latest.defaultInstance = instance.name;
    }
    return latest;
  });

  console.log(`\nInstance "${instance.name}" saved to ${configPath}`);

  console.log("\nAll instances:");
  for (const inst of savedConfig.instances) {
    const isDefault = inst.name === savedConfig.defaultInstance ? " (default)" : "";
    const projs = inst.projects?.length > 0 ? ` [${inst.projects.join(", ")}]` : "";
    console.log(`  - ${inst.name}${isDefault}: ${inst.baseUrl}${projs}`);
  }

  printFigmaStatus();
  printSetupComplete();
  rl.close();
}

function printFigmaStatus() {
  const figmaConfigPath = path.join(process.env.HOME, ".config/figma-mcp/config.json");
  if (fs.existsSync(figmaConfigPath)) {
    console.log("\n[OK] Figma MCP detected - Figma links in tickets will be fetched automatically");
  } else {
    console.log("\n[INFO] Figma MCP not installed - Figma links won't be fetched");
    console.log("To enable Figma integration, install figma-mcp");
  }
}

function printSetupComplete() {
  console.log("\n=== Setup Complete ===");
  console.log("\nIf you haven't already, add to Claude Code with:\n");
  console.log("  claude mcp add --transport stdio jira -- npx -y @rui.branco/jira-mcp");
  console.log("\nThen restart Claude Code and run /mcp to verify.");
}

setup().catch((e) => {
  console.error("Setup failed:", e.message);
  rl.close();
  process.exit(1);
});
