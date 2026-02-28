#!/usr/bin/env node

const readline = require("readline");
const fs = require("fs");
const path = require("path");

const configDir = path.join(process.env.HOME, ".config/jira-mcp");
const configPath = path.join(configDir, "config.json");

// Check for command line arguments
let args = process.argv.slice(2);
// Skip "setup" arg if called via index.js
if (args[0] === "setup") args = args.slice(1);

// Load existing config if present
function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch {}
  return null;
}

function saveConfig(config) {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Non-interactive: setup add <name> <email> <token> <baseUrl> <projects>
if (args[0] === "add" && args.length >= 5) {
  const [, name, email, token, baseUrl, ...projectArgs] = args;
  const projects = projectArgs.length > 0
    ? projectArgs.join(",").split(",").map((p) => p.trim().toUpperCase()).filter(Boolean)
    : [];

  const config = loadConfig() || {};

  // Migrate old format if needed
  if (config.email && !config.instances) {
    config.instances = [{
      name: "default",
      email: config.email,
      token: config.token,
      baseUrl: config.baseUrl,
      projects: [],
    }];
    config.defaultInstance = "default";
    delete config.email;
    delete config.token;
    delete config.baseUrl;
  }

  if (!config.instances) config.instances = [];

  // Replace or add instance
  const existing = config.instances.findIndex((i) => i.name === name);
  const instance = { name, email, token, baseUrl: baseUrl.replace(/\/$/, ""), projects };
  if (existing >= 0) {
    config.instances[existing] = instance;
  } else {
    config.instances.push(instance);
  }

  if (!config.defaultInstance) config.defaultInstance = name;

  saveConfig(config);
  console.log(`Instance "${name}" saved to ${configPath}`);
  if (projects.length > 0) {
    console.log(`Projects: ${projects.join(", ")}`);
  }
  process.exit(0);
}

// Non-interactive: setup remove <name>
if (args[0] === "remove" && args.length >= 2) {
  const name = args[1];
  const config = loadConfig();

  if (!config || !config.instances) {
    console.error("No multi-instance config found.");
    process.exit(1);
  }

  config.instances = config.instances.filter((i) => i.name !== name);
  if (config.defaultInstance === name) {
    config.defaultInstance = config.instances[0]?.name || null;
  }

  saveConfig(config);
  console.log(`Instance "${name}" removed.`);
  process.exit(0);
}

// Non-interactive: setup <email> <token> <baseUrl> (legacy single-instance)
if (args.length >= 3 && args[0] !== "add" && args[0] !== "remove") {
  const [email, token, baseUrl] = args;
  saveConfig({ email, token, baseUrl: baseUrl.replace(/\/$/, "") });
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
      for (const inst of existing.instances) {
        const isDefault = inst.name === existing.defaultInstance ? " (default)" : "";
        const projs = inst.projects?.length > 0 ? ` [${inst.projects.join(", ")}]` : "";
        console.log(`  - ${inst.name}${isDefault}: ${inst.baseUrl}${projs}`);
      }
      console.log();
    }

    const action = await ask("Add new instance, or fresh setup? (add/fresh): ");
    if (action.trim().toLowerCase() === "fresh") {
      // Fall through to single setup
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

  saveConfig({ email, token, baseUrl: baseUrl.replace(/\/$/, "") });
  console.log(`\nConfig saved to ${configPath}`);

  printFigmaStatus();
  printSetupComplete();
  rl.close();
}

async function addInstance(config) {
  // Migrate old format if needed
  if (config.email && !config.instances) {
    const oldName = await ask("Name for your existing instance (e.g., work): ");
    const oldProjects = await ask("Project prefixes for existing instance (comma-separated, e.g., MODS,ENG): ");
    config = {
      instances: [{
        name: oldName.trim() || "default",
        email: config.email,
        token: config.token,
        baseUrl: config.baseUrl,
        projects: oldProjects.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean),
      }],
      defaultInstance: oldName.trim() || "default",
    };
  }

  if (!config.instances) config.instances = [];

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
  const projects = projectsInput.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean);

  const instance = {
    name: name.trim(),
    email: email.trim(),
    token: token.trim(),
    baseUrl: baseUrl.trim().replace(/\/$/, ""),
    projects,
  };

  // Replace or add
  const idx = config.instances.findIndex((i) => i.name === instance.name);
  if (idx >= 0) {
    config.instances[idx] = instance;
  } else {
    config.instances.push(instance);
  }

  if (!config.defaultInstance) config.defaultInstance = instance.name;

  const setDefault = await ask(`Set "${instance.name}" as default? (y/N): `);
  if (setDefault.trim().toLowerCase() === "y") {
    config.defaultInstance = instance.name;
  }

  saveConfig(config);
  console.log(`\nInstance "${instance.name}" saved to ${configPath}`);

  console.log("\nAll instances:");
  for (const inst of config.instances) {
    const isDefault = inst.name === config.defaultInstance ? " (default)" : "";
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
