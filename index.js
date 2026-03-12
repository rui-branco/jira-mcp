#!/usr/bin/env node

// Handle setup command
if (process.argv[2] === "setup") {
  require("./setup.js");
  return;
}

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { spawn, execSync } = require("child_process");

// Auto-update: check GitHub for new commits, install in background
const GITHUB_REPO = "rui-branco/jira-mcp";
const INSTALLED_SHA_FILE = path.join(__dirname, ".installed-sha");
try {
  const localSha = fs.existsSync(INSTALLED_SHA_FILE)
    ? fs.readFileSync(INSTALLED_SHA_FILE, "utf-8").trim()
    : "";
  const remoteSha = execSync(
    `git ls-remote https://github.com/${GITHUB_REPO}.git HEAD`,
    { stdio: "pipe", timeout: 5000 },
  )
    .toString()
    .split("\t")[0]
    .trim();
  if (remoteSha && remoteSha !== localSha) {
    const child = spawn(
      "sh",
      [
        "-c",
        `npm install -g git+ssh://git@github.com/${GITHUB_REPO}.git && echo "${remoteSha}" > "${INSTALLED_SHA_FILE}"`,
      ],
      { stdio: "ignore", detached: true },
    );
    child.unref();
  }
} catch {}

// Load Jira config (supports single-instance and multi-instance formats)
const jiraConfigPath = path.join(
  process.env.HOME,
  ".config/jira-mcp/config.json",
);
const rawConfig = JSON.parse(fs.readFileSync(jiraConfigPath, "utf8"));

// Normalize config to multi-instance format
let instances;
if (rawConfig.instances) {
  // New multi-instance format
  instances = rawConfig.instances.map((inst) => ({
    ...inst,
    projects: (inst.projects || []).map((p) => p.toUpperCase()),
    auth: Buffer.from(`${inst.email}:${inst.token}`).toString("base64"),
  }));
} else {
  // Old single-instance format — wrap as array
  instances = [
    {
      name: "default",
      email: rawConfig.email,
      token: rawConfig.token,
      baseUrl: rawConfig.baseUrl,
      projects: [],
      auth: Buffer.from(`${rawConfig.email}:${rawConfig.token}`).toString("base64"),
    },
  ];
}

// Resolve default instance
const defaultInstance =
  (rawConfig.defaultInstance && instances.find((i) => i.name === rawConfig.defaultInstance)) ||
  instances[0];

// Re-read config file (for persisting changes)
function loadConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(jiraConfigPath, "utf8"));
  } catch {
    return {};
  }
}

// Instance resolution helpers
function getInstanceForProject(projectPrefix) {
  const upper = projectPrefix.toUpperCase();
  return instances.find((i) => i.projects.includes(upper)) || defaultInstance;
}

function getInstanceForKey(issueKey) {
  const prefix = issueKey.split("-")[0];
  return getInstanceForProject(prefix);
}

function getInstanceByName(name) {
  if (!name) return defaultInstance;
  return instances.find((i) => i.name === name) || defaultInstance;
}

// Load Figma config (optional)
let figmaConfig = null;
const figmaConfigPath = path.join(
  process.env.HOME,
  ".config/figma-mcp/config.json",
);
try {
  if (fs.existsSync(figmaConfigPath)) {
    figmaConfig = JSON.parse(fs.readFileSync(figmaConfigPath, "utf8"));
  }
} catch (e) {
  // Figma not configured, that's ok
}

// Directories
const attachmentDir = path.join(
  process.env.HOME,
  ".config/jira-mcp/attachments",
);
const figmaExportsDir = path.join(
  process.env.HOME,
  ".config/figma-mcp/exports",
);

if (!fs.existsSync(attachmentDir)) {
  fs.mkdirSync(attachmentDir, { recursive: true });
}

// ============ JIRA FUNCTIONS ============

async function fetchJira(endpoint, options = {}, instance = defaultInstance) {
  const { method = "GET", body } = options;
  const headers = {
    Authorization: `Basic ${instance.auth}`,
    Accept: "application/json",
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${instance.baseUrl}/rest/api/3${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Jira API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
    );
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function downloadAttachment(url, filename, issueKey, instance) {
  const issueDir = path.join(attachmentDir, issueKey);
  if (!fs.existsSync(issueDir)) {
    fs.mkdirSync(issueDir, { recursive: true });
  }

  const localPath = path.join(issueDir, filename);

  if (fs.existsSync(localPath)) {
    return localPath;
  }

  const inst = instance || getInstanceForKey(issueKey);
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${inst.auth}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${filename}: ${response.status}`);
  }

  const buffer = await response.buffer();
  fs.writeFileSync(localPath, buffer);

  return localPath;
}

function extractText(content, urls = []) {
  if (!content) return { text: "", urls };
  if (typeof content === "string") return { text: content, urls };

  let text = "";
  if (content.content) {
    for (const node of content.content) {
      if (node.type === "text") {
        const nodeText = node.text || "";
        // Check for link marks
        const linkMark = node.marks?.find(
          (m) => m.type === "link" && m.attrs?.href,
        );
        if (linkMark) {
          const href = linkMark.attrs.href;
          urls.push(href);
          // Render as markdown link if the display text differs from the URL
          if (nodeText && nodeText !== href) {
            text += `[${nodeText}](${href})`;
          } else {
            text += href;
          }
        } else {
          text += nodeText;
        }
      } else if (node.type === "paragraph") {
        const result = extractText(node, urls);
        text += result.text + "\n";
        urls = result.urls;
      } else if (node.type === "hardBreak") {
        text += "\n";
      } else if (node.type === "mention") {
        text += `@${node.attrs?.text || "user"}`;
      } else if (node.type === "mediaGroup" || node.type === "mediaSingle") {
        text += "[image attachment]\n";
      } else if (
        node.type === "inlineCard" ||
        node.type === "blockCard" ||
        node.type === "embedCard"
      ) {
        // Smart links / embeds - extract URL
        const url = node.attrs?.url;
        if (url) {
          text += url + "\n";
          urls.push(url);
        }
      } else if (node.content) {
        const result = extractText(node, urls);
        text += result.text;
        urls = result.urls;
      }
    }
  }
  return { text, urls };
}

// Wrapper for backward compatibility
function extractTextSimple(content) {
  const result = extractText(content, []);
  return result.text;
}

// ============ USER SEARCH & MENTIONS ============

// Cache for user lookups to avoid repeated API calls
const userCache = new Map();

async function searchUser(query, instance = defaultInstance) {
  // Check cache first (instance-aware)
  const cacheKey = `${instance.name}:${query.toLowerCase()}`;
  if (userCache.has(cacheKey)) {
    return userCache.get(cacheKey);
  }

  try {
    // Search for users by display name
    const users = await fetchJira(
      `/user/search?query=${encodeURIComponent(query)}&maxResults=5`,
      {},
      instance,
    );
    if (users && users.length > 0) {
      // Find best match - prefer exact match, then starts with, then contains
      const exactMatch = users.find(
        (u) => u.displayName.toLowerCase() === query.toLowerCase(),
      );
      const startsWithMatch = users.find((u) =>
        u.displayName.toLowerCase().startsWith(query.toLowerCase()),
      );
      const user = exactMatch || startsWithMatch || users[0];

      const result = {
        accountId: user.accountId,
        displayName: user.displayName,
      };
      userCache.set(cacheKey, result);
      return result;
    }
  } catch (e) {
    // User search failed, return null
  }
  return null;
}

// Parse text with @mentions and build ADF content
// Parse inline formatting: **bold**, *italic*, @mentions
async function parseInlineFormatting(text, instance = defaultInstance) {
  const nodes = [];
  // Bold (**) must come before italic (*) in alternation, backticks for inline code
  const regex = /(`(.+?)`|\*\*(.+?)\*\*|\*(.+?)\*|@([A-Z][a-zA-Zà-ÿ]*(?:\s[A-Z][a-zA-Zà-ÿ]*)*))/g;

  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", text: text.substring(lastIndex, match.index) });
    }

    if (match[2] !== undefined) {
      // `inline code`
      nodes.push({ type: "text", text: match[2], marks: [{ type: "code" }] });
    } else if (match[3] !== undefined) {
      // **bold**
      nodes.push({ type: "text", text: match[3], marks: [{ type: "strong" }] });
    } else if (match[4] !== undefined) {
      // *italic*
      nodes.push({ type: "text", text: match[4], marks: [{ type: "em" }] });
    } else if (match[5] !== undefined) {
      // @Mention — regex may greedily capture extra capitalized words beyond the actual name.
      // After resolving, only consume the portion matching the display name.
      const captured = match[5].trim();
      const user = await searchUser(captured, instance);
      if (user) {
        nodes.push({
          type: "mention",
          attrs: { id: user.accountId, text: `@${user.displayName}` },
        });
        // Only consume "@" + display name length from the captured text.
        // If the captured text starts with the display name (case-insensitive),
        // use the display name length; otherwise fall back to full match.
        const dn = user.displayName;
        const consumeLen = captured.toLowerCase().startsWith(dn.toLowerCase())
          ? dn.length
          : captured.length;
        lastIndex = match.index + 1 + consumeLen;
        regex.lastIndex = lastIndex;
        continue;
      } else {
        nodes.push({ type: "text", text: match[0] });
      }
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push({ type: "text", text: text.substring(lastIndex) });
  }

  return nodes.length > 0 ? nodes : [{ type: "text", text: text }];
}

// Parse text with markdown formatting and @mentions, build ADF content
async function buildCommentADF(text, instance = defaultInstance) {
  // Sanitize: replace em dashes and en dashes with hyphen
  text = text.replace(/[—–]/g, "-");
  // Split into blocks by double newlines (paragraphs)
  const blocks = text.split(/\n\n+/);
  const content = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const lines = trimmed.split("\n");
    const isBulletList = lines.every((l) => l.trimStart().startsWith("- "));

    if (isBulletList) {
      // Bullet list block
      const listItems = [];
      for (const line of lines) {
        const itemText = line.trimStart().substring(2);
        const inlineContent = await parseInlineFormatting(itemText, instance);
        listItems.push({
          type: "listItem",
          content: [{ type: "paragraph", content: inlineContent }],
        });
      }
      content.push({ type: "bulletList", content: listItems });
    } else {
      // Regular paragraph — single newlines become hardBreaks
      const paragraphContent = [];
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) paragraphContent.push({ type: "hardBreak" });
        const inlineNodes = await parseInlineFormatting(lines[i], instance);
        paragraphContent.push(...inlineNodes);
      }
      content.push({ type: "paragraph", content: paragraphContent });
    }
  }

  return content.length > 0
    ? content
    : [{ type: "paragraph", content: [{ type: "text", text: text }] }];
}

// ============ JIRA URL DETECTION ============

function findJiraTicketKeys(text, currentKey = null) {
  if (!text) return [];

  // Match Jira URLs like https://company.atlassian.net/browse/PROJ-123
  const urlRegex = /https?:\/\/[^\s]+\/browse\/([A-Z][A-Z0-9]+-\d+)/g;
  // Match ticket keys directly like PROJ-123
  const keyRegex = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

  const keys = new Set();
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    if (match[1] !== currentKey) {
      keys.add(match[1]);
    }
  }

  while ((match = keyRegex.exec(text)) !== null) {
    if (match[1] !== currentKey) {
      keys.add(match[1]);
    }
  }

  return [...keys];
}

// ============ FIGMA FUNCTIONS ============

function findFigmaUrls(text) {
  if (!text) return [];
  // Match Figma URLs
  const regex =
    /https:\/\/(?:www\.)?figma\.com\/(?:file|design|proto)\/([a-zA-Z0-9]+)\/[^\s)>\]"']*/g;
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[0]);
  }
  return [...new Set(matches)]; // dedupe
}

function parseFigmaUrl(url) {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split("/");

  let fileKey = null;
  for (let i = 0; i < pathParts.length; i++) {
    if (
      pathParts[i] === "file" ||
      pathParts[i] === "design" ||
      pathParts[i] === "proto"
    ) {
      fileKey = pathParts[i + 1];
      break;
    }
  }

  if (!fileKey) return null;

  // Get node ID and convert from hyphen to colon format
  const rawNodeId = urlObj.searchParams.get("node-id");
  const nodeId = rawNodeId ? rawNodeId.replace(/-/g, ":") : null;

  return { fileKey, nodeId };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function figmaFetchWithRetry(
  url,
  options = {},
  { maxRetries = 3, maxWaitSec = 30 } = {},
) {
  let attempts = 0;

  while (true) {
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, "X-Figma-Token": figmaConfig.token },
    });

    if (response.ok) {
      return response;
    }

    if (response.status === 429) {
      const retryAfterSec = Number(response.headers.get("retry-after")) || 60;

      // Don't retry if wait is too long (monthly limit) or too many attempts
      if (retryAfterSec > maxWaitSec || attempts++ >= maxRetries) {
        const waitTime =
          retryAfterSec > 3600
            ? `${Math.round(retryAfterSec / 3600)} hours (monthly limit reached)`
            : `${retryAfterSec} seconds`;
        return { rateLimited: true, retryAfter: waitTime };
      }

      await sleep(retryAfterSec * 1000);
      continue;
    }

    return response;
  }
}

async function fetchFigmaDesign(url) {
  if (!figmaConfig) {
    return {
      error: "Figma not configured. Run: node ~/.config/figma-mcp/setup.js",
    };
  }

  const parsed = parseFigmaUrl(url);
  if (!parsed) {
    return { error: "Invalid Figma URL" };
  }

  const { fileKey, nodeId } = parsed;

  try {
    // Get file info
    const fileRes = await figmaFetchWithRetry(
      `https://api.figma.com/v1/files/${fileKey}?depth=1`,
    );

    if (fileRes.rateLimited) {
      return {
        error: `Figma API rate limit exceeded. Try again in ${fileRes.retryAfter} seconds.`,
      };
    }
    if (!fileRes.ok) {
      if (fileRes.status === 403) {
        return {
          error: "Figma access denied. Check your token or file permissions.",
        };
      } else if (fileRes.status === 404) {
        return { error: "Figma file not found. Check the URL." };
      }
      return { error: `Figma API error: ${fileRes.status}` };
    }
    const fileData = await fileRes.json();

    let result = {
      name: fileData.name,
      lastModified: fileData.lastModified,
      url: url,
      nodeId: nodeId,
      nodeName: null,
      images: [], // Changed to array for multiple images
    };

    if (!fs.existsSync(figmaExportsDir)) {
      fs.mkdirSync(figmaExportsDir, { recursive: true });
    }

    // If specific node, get its info and export images
    if (nodeId) {
      // Get node info with depth=2 to see children
      const nodeRes = await figmaFetchWithRetry(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=2`,
      );

      if (nodeRes.ok) {
        const nodeData = await nodeRes.json();
        const node = nodeData.nodes && nodeData.nodes[nodeId];

        if (node && node.document) {
          const doc = node.document;
          result.nodeName = doc.name;

          // Check if it's a large frame with children
          const bb = doc.absoluteBoundingBox;
          const isLarge = bb && (bb.width > 1500 || bb.height > 2000);
          const exportableChildren = [];

          if (doc.children) {
            for (const child of doc.children) {
              const isExportable = [
                "FRAME",
                "COMPONENT",
                "GROUP",
                "SECTION",
              ].includes(child.type);
              const cbb = child.absoluteBoundingBox;
              const hasSize = cbb && cbb.width >= 100 && cbb.height >= 100;
              if (isExportable && hasSize) {
                exportableChildren.push({ id: child.id, name: child.name });
              }
            }
          }

          // Export children if large frame, otherwise export whole frame
          if (isLarge && exportableChildren.length > 0) {
            const childIds = exportableChildren.slice(0, 8).map((c) => c.id);
            const idsParam = childIds.join(",");

            const imgRes = await figmaFetchWithRetry(
              `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(idsParam)}&format=png&scale=2`,
            );

            if (imgRes.ok) {
              const imgData = await imgRes.json();
              for (const childId of childIds) {
                const imageUrl = imgData.images && imgData.images[childId];
                if (imageUrl) {
                  try {
                    const downloadRes = await fetch(imageUrl);
                    if (downloadRes.ok) {
                      const buffer = await downloadRes.buffer();
                      const childInfo = exportableChildren.find(
                        (c) => c.id === childId,
                      );
                      const sanitizedId = childId.replace(
                        /[^a-zA-Z0-9-]/g,
                        "_",
                      );
                      const filename = `${fileKey}_${sanitizedId}.png`;
                      const imagePath = path.join(figmaExportsDir, filename);
                      fs.writeFileSync(imagePath, buffer);
                      result.images.push({
                        buffer,
                        path: imagePath,
                        name: childInfo?.name || childId,
                      });
                    }
                  } catch (e) {
                    /* skip */
                  }
                }
              }
            }
          } else {
            // Export whole frame
            const imgRes = await figmaFetchWithRetry(
              `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=2`,
            );

            if (imgRes.ok) {
              const imgData = await imgRes.json();
              const imageUrl = imgData.images && imgData.images[nodeId];
              if (imageUrl) {
                const downloadRes = await fetch(imageUrl);
                if (downloadRes.ok) {
                  const buffer = await downloadRes.buffer();
                  const sanitizedId = nodeId.replace(/[^a-zA-Z0-9-]/g, "_");
                  const filename = `${fileKey}_${sanitizedId}.png`;
                  const imagePath = path.join(figmaExportsDir, filename);
                  fs.writeFileSync(imagePath, buffer);
                  result.images.push({
                    buffer,
                    path: imagePath,
                    name: doc.name,
                  });
                }
              }
            }
          }
        }
      }
    }

    return result;
  } catch (e) {
    return { error: `Figma fetch failed: ${e.message}` };
  }
}

// ============ MAIN TICKET FUNCTION ============

async function getTicket(issueKey, downloadImages = true, fetchFigma = true, instance = null) {
  instance = instance || getInstanceForKey(issueKey);
  const issue = await fetchJira(`/issue/${issueKey}?expand=renderedFields`, {}, instance);
  const fields = issue.fields;
  const storyPoints = fields.customfield_10016 ?? fields.story_points ?? null;

  let output = `# ${issueKey}: ${fields.summary}\n\n`;
  output += `**Status:** ${fields.status?.name || "Unknown"}\n`;
  output += `**Type:** ${fields.issuetype?.name || "Unknown"}\n`;
  output += `**Priority:** ${fields.priority?.name || "None"}\n`;
  output += `**Assignee:** ${fields.assignee?.displayName || "Unassigned"}\n`;
  output += `**Reporter:** ${fields.reporter?.displayName || "Unknown"}\n`;

  // Date fields
  if (fields.created) output += `**Created:** ${fields.created}\n`;
  if (fields.updated) output += `**Updated:** ${fields.updated}\n`;
  if (fields.resolutiondate) output += `**Resolved:** ${fields.resolutiondate}\n`;
  if (fields.resolution) output += `**Resolution:** ${fields.resolution.name}\n`;

  // Story points
  if (storyPoints != null) output += `**Story Points:** ${storyPoints}\n`;

  if (fields.sprint) {
    output += `**Sprint:** ${fields.sprint.name}\n`;
  }

  if (fields.parent) {
    output += `**Parent:** ${fields.parent.key} - ${fields.parent.fields?.summary || ""}\n`;
  }

  // Labels, Components, Fix Versions
  if (fields.labels?.length > 0) output += `**Labels:** ${fields.labels.join(", ")}\n`;
  if (fields.components?.length > 0) output += `**Components:** ${fields.components.map(c => c.name).join(", ")}\n`;
  if (fields.fixVersions?.length > 0) output += `**Fix Versions:** ${fields.fixVersions.map(v => v.name).join(", ")}\n`;

  // Time tracking
  if (fields.timetracking && (fields.timetracking.originalEstimate || fields.timetracking.timeSpent)) {
    output += `**Time Tracking:** estimate=${fields.timetracking.originalEstimate || "none"}, spent=${fields.timetracking.timeSpent || "none"}, remaining=${fields.timetracking.remainingEstimate || "none"}\n`;
  }

  // Subtasks
  if (fields.subtasks?.length > 0) {
    output += `**Subtasks:** ${fields.subtasks.length}\n`;
  }

  // Extract description text and embedded URLs
  const descResult = extractText(fields.description, []);
  output += `\n## Description\n\n`;
  output += descResult.text || "_No description_";
  output += "\n";

  // Collect all URLs found in the ticket
  let allUrls = [...descResult.urls];
  let allText = descResult.text;

  // Fetch FULL parent ticket details
  if (fields.parent) {
    output += `\n## Parent Ticket: ${fields.parent.key}\n\n`;
    try {
      const parentIssue = await fetchJira(
        `/issue/${fields.parent.key}?expand=renderedFields`, {}, instance,
      );
      const pf = parentIssue.fields;

      output += `**${pf.summary}**\n`;
      output += `Status: ${pf.status?.name || "Unknown"} | `;
      output += `Type: ${pf.issuetype?.name || "Unknown"} | `;
      output += `Priority: ${pf.priority?.name || "None"}\n`;
      output += `Assignee: ${pf.assignee?.displayName || "Unassigned"}\n\n`;

      // Full description
      const parentDesc = extractText(pf.description, []);
      if (parentDesc.text && parentDesc.text.trim()) {
        output += `### Description\n${parentDesc.text}\n`;
        allText += " " + parentDesc.text;
        allUrls = allUrls.concat(parentDesc.urls);
      }

      // Parent comments
      if (pf.comment?.comments?.length > 0) {
        output += `\n### Comments (${pf.comment.comments.length})\n`;
        for (const comment of pf.comment.comments) {
          const author = comment.author?.displayName || "Unknown";
          const created = new Date(comment.created).toLocaleString();
          const commentText = extractText(comment.body, []);
          output += `**${author}** - ${created}\n`;
          output += `${commentText.text}\n\n`;
          allText += " " + commentText.text;
        }
      }

      output += "\n---\n\n";
    } catch (e) {
      output += `_Could not fetch parent details: ${e.message}_\n\n`;
    }
  }

  // Get comments
  if (fields.comment?.comments?.length > 0) {
    output += `\n## Comments (${fields.comment.comments.length})\n\n`;
    for (const comment of fields.comment.comments) {
      const author = comment.author?.displayName || "Unknown";
      const created = new Date(comment.created).toLocaleString();
      const commentResult = extractText(comment.body, []);
      output += `### ${author} - ${created} (id: ${comment.id})\n`;
      output += commentResult.text + "\n\n";
      allText += " " + commentResult.text;
      allUrls = allUrls.concat(commentResult.urls);
    }
  }

  // Get attachments
  const downloadedImages = [];
  if (fields.attachment?.length > 0) {
    output += `\n## Attachments (${fields.attachment.length})\n\n`;
    for (const att of fields.attachment) {
      const isImage = att.mimeType?.startsWith("image/");
      output += `- **${att.filename}** (${att.mimeType}, ${Math.round(att.size / 1024)}KB)\n`;

      if (downloadImages && isImage) {
        try {
          const localPath = await downloadAttachment(
            att.content,
            att.filename,
            issueKey,
            instance,
          );
          output += `  Local: ${localPath}\n`;
          downloadedImages.push(localPath);
        } catch (e) {
          output += `  Download failed: ${e.message}\n`;
        }
      } else {
        output += `  URL: ${att.content}\n`;
      }
    }
  }

  // Subtasks - fetch full details
  if (fields.subtasks?.length > 0) {
    output += `\n## Subtasks (${fields.subtasks.length})\n\n`;

    for (const subtask of fields.subtasks) {
      output += `### ${subtask.key}: ${subtask.fields?.summary || ""}\n`;
      output += `Status: ${subtask.fields?.status?.name || "Unknown"} | `;
      output += `Type: ${subtask.fields?.issuetype?.name || "Subtask"}\n`;

      try {
        const subtaskDetails = await fetchJira(`/issue/${subtask.key}`, {}, instance);
        const sf = subtaskDetails.fields;

        if (sf.assignee) {
          output += `Assignee: ${sf.assignee.displayName}\n`;
        }

        const subtaskDesc = extractText(sf.description, []);
        if (subtaskDesc.text && subtaskDesc.text.trim()) {
          const desc =
            subtaskDesc.text.length > 300
              ? subtaskDesc.text.substring(0, 300) + "..."
              : subtaskDesc.text;
          output += `\n${desc}\n`;
        }
        output += "\n";
      } catch (e) {
        output += "\n";
      }
    }
  }

  // Linked issues - fetch full details
  if (fields.issuelinks?.length > 0) {
    output += `\n## Linked Issues (${fields.issuelinks.length})\n\n`;

    // Collect linked issue keys
    const linkedIssues = [];
    for (const link of fields.issuelinks) {
      if (link.outwardIssue) {
        linkedIssues.push({
          key: link.outwardIssue.key,
          relation: link.type.outward,
          summary: link.outwardIssue.fields?.summary || "",
        });
      }
      if (link.inwardIssue) {
        linkedIssues.push({
          key: link.inwardIssue.key,
          relation: link.type.inward,
          summary: link.inwardIssue.fields?.summary || "",
        });
      }
    }

    // Fetch full details for each linked issue
    const maxLinkedToFetch = 10;
    for (let i = 0; i < Math.min(linkedIssues.length, maxLinkedToFetch); i++) {
      const linked = linkedIssues[i];
      output += `### ${linked.relation}: ${linked.key}\n`;
      output += `**${linked.summary}**\n\n`;

      try {
        const linkedIssue = await fetchJira(
          `/issue/${linked.key}?expand=renderedFields`, {}, instance,
        );
        const lf = linkedIssue.fields;

        output += `Status: ${lf.status?.name || "Unknown"} | `;
        output += `Type: ${lf.issuetype?.name || "Unknown"} | `;
        output += `Priority: ${lf.priority?.name || "None"}\n`;
        output += `Assignee: ${lf.assignee?.displayName || "Unassigned"}\n\n`;

        // Get FULL description (no truncation)
        const linkedDesc = extractText(lf.description, []);
        if (linkedDesc.text && linkedDesc.text.trim()) {
          output += `#### Description\n${linkedDesc.text}\n`;
        }

        // Get comments from linked ticket
        if (lf.comment?.comments?.length > 0) {
          output += `\n#### Comments (${lf.comment.comments.length})\n`;
          for (const comment of lf.comment.comments) {
            const author = comment.author?.displayName || "Unknown";
            const created = new Date(comment.created).toLocaleString();
            const commentText = extractText(comment.body, []);
            output += `**${author}** - ${created}\n`;
            output += `${commentText.text}\n\n`;
          }
        }

        output += "\n---\n\n";
      } catch (e) {
        output += `_Could not fetch details: ${e.message}_\n\n`;
      }
    }

    if (linkedIssues.length > maxLinkedToFetch) {
      output += `\n_...and ${linkedIssues.length - maxLinkedToFetch} more linked issues_\n`;
    }
  }

  // Find and fetch referenced Jira tickets from text (URLs and ticket keys)
  const referencedKeys = findJiraTicketKeys(allText, issueKey);

  // Exclude already fetched tickets (linked issues, subtasks, parent)
  const alreadyFetched = new Set();
  alreadyFetched.add(issueKey);
  if (fields.parent) alreadyFetched.add(fields.parent.key);
  if (fields.subtasks)
    fields.subtasks.forEach((s) => alreadyFetched.add(s.key));
  if (fields.issuelinks) {
    fields.issuelinks.forEach((link) => {
      if (link.outwardIssue) alreadyFetched.add(link.outwardIssue.key);
      if (link.inwardIssue) alreadyFetched.add(link.inwardIssue.key);
    });
  }

  const ticketsToFetch = referencedKeys.filter(
    (key) => !alreadyFetched.has(key),
  );

  if (ticketsToFetch.length > 0) {
    output += `\n## Referenced Tickets (${ticketsToFetch.length})\n\n`;
    output += `_Auto-detected from description/comments_\n\n`;

    const maxReferencedToFetch = 10;
    for (
      let i = 0;
      i < Math.min(ticketsToFetch.length, maxReferencedToFetch);
      i++
    ) {
      const refKey = ticketsToFetch[i];

      try {
        const refIssue = await fetchJira(
          `/issue/${refKey}?expand=renderedFields`, {}, instance,
        );
        const rf = refIssue.fields;

        output += `### ${refKey}: ${rf.summary || ""}\n`;
        output += `Status: ${rf.status?.name || "Unknown"} | `;
        output += `Type: ${rf.issuetype?.name || "Unknown"} | `;
        output += `Priority: ${rf.priority?.name || "None"}\n`;
        output += `Assignee: ${rf.assignee?.displayName || "Unassigned"}\n\n`;

        // Get FULL description (no truncation)
        const refDesc = extractText(rf.description, []);
        if (refDesc.text && refDesc.text.trim()) {
          output += `#### Description\n${refDesc.text}\n`;
        }

        // Get comments from referenced ticket
        if (rf.comment?.comments?.length > 0) {
          output += `\n#### Comments (${rf.comment.comments.length})\n`;
          for (const comment of rf.comment.comments) {
            const author = comment.author?.displayName || "Unknown";
            const created = new Date(comment.created).toLocaleString();
            const commentText = extractText(comment.body, []);
            output += `**${author}** - ${created}\n`;
            output += `${commentText.text}\n\n`;
          }
        }

        // Check for Figma links in referenced ticket
        const refFigmaUrls = findFigmaUrls(refDesc.text);
        if (refFigmaUrls.length > 0) {
          output += `**Figma:** ${refFigmaUrls.join(", ")}\n`;
          allText += " " + refDesc.text;
        }

        output += "\n---\n\n";
      } catch (e) {
        output += `### ${refKey}\n_Could not fetch: ${e.message}_\n\n`;
      }
    }

    if (ticketsToFetch.length > maxReferencedToFetch) {
      output += `_...and ${ticketsToFetch.length - maxReferencedToFetch} more referenced tickets_\n`;
    }
  }

  // Find and fetch Figma designs
  const figmaDesigns = [];
  if (fetchFigma && figmaConfig) {
    // Combine URLs from regex search AND embedded links
    const textUrls = findFigmaUrls(allText);
    const embeddedFigmaUrls = allUrls.filter(
      (u) => u && u.includes("figma.com"),
    );
    const allFigmaUrls = [...new Set([...textUrls, ...embeddedFigmaUrls])]; // dedupe

    if (allFigmaUrls.length > 0) {
      output += `\n## Figma Designs (${allFigmaUrls.length})\n\n`;

      for (const url of allFigmaUrls) {
        const design = await fetchFigmaDesign(url);
        if (design && design.error) {
          output += `- ${url}\n`;
          output += `  **Error:** ${design.error}\n\n`;
        } else if (design && design.name) {
          output += `### ${design.name}${design.nodeName ? ` - ${design.nodeName}` : ""}\n`;
          output += `- URL: ${url}\n`;
          output += `- Last Modified: ${design.lastModified}\n`;
          if (design.images && design.images.length > 0) {
            output += `- Exported ${design.images.length} image(s):\n`;
            for (const img of design.images) {
              output += `  - ${img.name}: ${img.path}\n`;
            }
            figmaDesigns.push(design);
          }
          output += "\n";
        } else {
          output += `- ${url} (could not fetch)\n\n`;
        }
      }
    }
  }

  return { text: output, jiraImages: downloadedImages, figmaDesigns };
}

async function searchTickets(jql, maxResults = 10, fields = null, instance = defaultInstance) {
  const defaultFields = [
    "summary", "status", "assignee", "reporter", "issuetype", "priority",
    "created", "resolutiondate", "updated", "statuscategorychangedate",
    "resolution", "timetracking", "aggregatetimeoriginalestimate",
    "aggregatetimespent", "parent", "labels", "components", "fixVersions",
    "customfield_10016", // story points (Jira Software)
  ];
  const requestFields = fields || defaultFields;
  const data = await fetchJira(
    `/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${requestFields.join(",")}`,
    {},
    instance,
  );

  const issues = data.issues || [];
  let output = `# Search Results (${data.total || 0} total, showing ${issues.length})\n\n`;

  for (const issue of issues) {
    const f = issue.fields || {};
    const storyPoints = f.customfield_10016 ?? f.story_points ?? null;

    output += `- **${issue.key}**: ${f.summary || "No summary"}\n`;
    output += `  Status: ${f.status?.name || "Unknown"} | Type: ${f.issuetype?.name || "Unknown"} | Priority: ${f.priority?.name || "None"}\n`;
    output += `  Assignee: ${f.assignee?.displayName || "Unassigned"} | Reporter: ${f.reporter?.displayName || "Unknown"}\n`;

    if (f.created) output += `  Created: ${f.created}\n`;
    if (f.updated) output += `  Updated: ${f.updated}\n`;
    if (f.resolutiondate) output += `  Resolved: ${f.resolutiondate}\n`;
    if (f.resolution) output += `  Resolution: ${f.resolution.name}\n`;
    if (storyPoints != null) output += `  Story Points: ${storyPoints}\n`;
    if (f.parent) output += `  Parent: ${f.parent.key}${f.parent.fields?.summary ? ` - ${f.parent.fields.summary}` : ""}\n`;
    if (f.labels?.length > 0) output += `  Labels: ${f.labels.join(", ")}\n`;
    if (f.components?.length > 0) output += `  Components: ${f.components.map(c => c.name).join(", ")}\n`;
    if (f.fixVersions?.length > 0) output += `  Fix Versions: ${f.fixVersions.map(v => v.name).join(", ")}\n`;
    if (f.timetracking && (f.timetracking.originalEstimate || f.timetracking.timeSpent)) {
      output += `  Time Tracking: estimate=${f.timetracking.originalEstimate || "none"}, spent=${f.timetracking.timeSpent || "none"}, remaining=${f.timetracking.remainingEstimate || "none"}\n`;
    }

    output += "\n";
  }

  return output;
}

// ============ CHANGELOG FUNCTIONS ============

function parseStatusHistory(changelog) {
  const statusChanges = [];
  if (!changelog?.histories) return statusChanges;

  for (const history of changelog.histories) {
    for (const item of history.items || []) {
      if (item.field === "status") {
        statusChanges.push({
          from: item.fromString,
          to: item.toString,
          date: history.created,
          author: history.author?.displayName || "Unknown",
        });
      }
    }
  }

  // Sort chronologically
  statusChanges.sort((a, b) => new Date(a.date) - new Date(b.date));
  return statusChanges;
}

function computeMetrics(statusHistory, created) {
  if (!statusHistory.length) return null;

  const metrics = {
    cycleTime: null,
    leadTime: null,
    timesInProgress: 0,
    timeInStatus: {},
  };

  // Build timeline: start with created date in the initial status
  const timeline = [];
  if (created && statusHistory.length > 0) {
    timeline.push({ status: statusHistory[0].from, date: new Date(created) });
  }
  for (const change of statusHistory) {
    timeline.push({ status: change.to, date: new Date(change.date) });
  }

  // Calculate time in each status
  for (let i = 0; i < timeline.length - 1; i++) {
    const status = timeline[i].status;
    const duration = timeline[i + 1].date - timeline[i].date;
    metrics.timeInStatus[status] = (metrics.timeInStatus[status] || 0) + duration;
  }
  // Add current status (time since last transition)
  const last = timeline[timeline.length - 1];
  const sinceLastTransition = Date.now() - last.date;
  metrics.timeInStatus[last.status] = (metrics.timeInStatus[last.status] || 0) + sinceLastTransition;

  // Count times in progress-like statuses
  metrics.timesInProgress = statusHistory.filter(
    (c) => c.to.toLowerCase().includes("progress"),
  ).length;

  // Cycle time: first "In Progress" to last "Done"
  const firstInProgress = statusHistory.find(
    (c) => c.to.toLowerCase().includes("progress"),
  );
  const lastDone = [...statusHistory].reverse().find(
    (c) => c.to.toLowerCase() === "done" || c.to.toLowerCase() === "closed",
  );
  if (firstInProgress && lastDone) {
    metrics.cycleTime = new Date(lastDone.date) - new Date(firstInProgress.date);
  }

  // Lead time: created to done
  if (created && lastDone) {
    metrics.leadTime = new Date(lastDone.date) - new Date(created);
  }

  // Format durations
  const fmt = (ms) => {
    if (ms == null) return null;
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(" ");
  };

  return {
    cycleTime: fmt(metrics.cycleTime),
    leadTime: fmt(metrics.leadTime),
    timesInProgress: metrics.timesInProgress,
    timeInStatus: Object.fromEntries(
      Object.entries(metrics.timeInStatus).map(([k, v]) => [k, fmt(v)]),
    ),
  };
}

function formatChangelog(issueKey, statusHistory, created) {
  let output = `## Status History for ${issueKey}\n\n`;

  if (statusHistory.length === 0) {
    output += "_No status transitions found._\n";
    return output;
  }

  for (const change of statusHistory) {
    const date = new Date(change.date).toLocaleString();
    output += `- **${change.from}** → **${change.to}** (${date}, by ${change.author})\n`;
  }

  const computed = computeMetrics(statusHistory, created);
  if (computed) {
    output += `\n### Computed Metrics\n\n`;
    if (computed.cycleTime) output += `- **Cycle Time:** ${computed.cycleTime}\n`;
    if (computed.leadTime) output += `- **Lead Time:** ${computed.leadTime}\n`;
    output += `- **Times In Progress:** ${computed.timesInProgress}\n`;
    if (Object.keys(computed.timeInStatus).length > 0) {
      output += `- **Time in Status:**\n`;
      for (const [status, time] of Object.entries(computed.timeInStatus)) {
        output += `  - ${status}: ${time}\n`;
      }
    }
  }

  return output;
}

async function getChangelog(issueKey, instance = null) {
  instance = instance || getInstanceForKey(issueKey);
  const issue = await fetchJira(`/issue/${issueKey}?expand=changelog&fields=created`, {}, instance);
  const statusHistory = parseStatusHistory(issue.changelog);
  const created = issue.fields?.created;
  return { statusHistory, created, formatted: formatChangelog(issueKey, statusHistory, created) };
}

async function getChangelogsBulk(jql, maxResults = 50, instance = defaultInstance) {
  // First get the issue keys matching the JQL
  const data = await fetchJira(
    `/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=key,created`,
    {},
    instance,
  );
  const issues = data.issues || [];

  let output = `# Changelogs (${issues.length} of ${data.total || 0} issues)\n\n`;

  // Fetch changelog for each issue (JIRA search API doesn't support expand=changelog on /search/jql)
  for (const issue of issues) {
    try {
      const result = await getChangelog(issue.key, instance);
      output += result.formatted + "\n";
    } catch (e) {
      output += `## ${issue.key}\n\n_Error fetching changelog: ${e.message}_\n\n`;
    }
  }

  return output;
}

// ============ MCP SERVER ============

const server = new Server(
  { name: "jira-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "jira_get_myself",
        description:
          "Get the current authenticated user's info including accountId. Use this to get your account ID for assigning tickets. When multiple Jira instances are configured, use the 'instance' parameter to specify which one.",
        inputSchema: {
          type: "object",
          properties: {
            instance: {
              type: "string",
              description: "Instance name (for multi-instance setups). Uses default instance if omitted.",
            },
          },
          required: [],
        },
      },
      {
        name: "jira_get_ticket",
        description:
          "Fetch a Jira ticket by its key (e.g., MODS-12115). Returns full details including description, comments, attachments, and linked Figma designs.",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "The Jira issue key (e.g., MODS-12115)",
            },
            downloadImages: {
              type: "boolean",
              description: "Download image attachments (default: true)",
            },
            fetchFigma: {
              type: "boolean",
              description:
                "Fetch linked Figma designs and export images (default: true)",
            },
            instance: {
              type: "string",
              description: "Instance name override. Auto-detected from issue key prefix if omitted.",
            },
          },
          required: ["issueKey"],
        },
      },
      {
        name: "jira_search",
        description:
          "Search Jira tickets using JQL. Returns detailed fields including dates, story points, labels, components, fix versions, time tracking, and parent. Examples: 'project = MODS AND status = Open'. When multiple Jira instances are configured, use the 'instance' parameter to specify which one.",
        inputSchema: {
          type: "object",
          properties: {
            jql: { type: "string", description: "JQL query string" },
            maxResults: {
              type: "number",
              description: "Max results (default 10)",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Custom list of fields to return. Default includes: summary, status, assignee, reporter, issuetype, priority, created, resolutiondate, updated, resolution, timetracking, parent, labels, components, fixVersions, customfield_10016 (story points).",
            },
            instance: {
              type: "string",
              description: "Instance name (for multi-instance setups). Uses default instance if omitted.",
            },
          },
          required: ["jql"],
        },
      },
      {
        name: "jira_add_comment",
        description:
          "Add a comment to a Jira ticket. IMPORTANT: Use @DisplayName (e.g. @Julia Pereszta) for mentions — NOT [~accountId:...] syntax. Keep comments non-technical and user-facing. Never mention git details like 'pushed to main', branch names, or technical implementation details — stakeholders don't care about that. NEVER use em dashes (—) or en dashes (–) in comments — use commas, periods, or rewrite the sentence instead.",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "The Jira issue key (e.g., MODS-123)",
            },
            comment: { type: "string", description: "The comment text to add" },
            instance: {
              type: "string",
              description: "Instance name override. Auto-detected from issue key prefix if omitted.",
            },
          },
          required: ["issueKey", "comment"],
        },
      },
      {
        name: "jira_reply_comment",
        description:
          "Reply to a specific comment on a Jira ticket. Quotes the original comment and mentions the author.",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "The Jira issue key (e.g., MODS-123)",
            },
            commentId: {
              type: "string",
              description:
                "The ID of the comment to reply to. Use jira_get_ticket to see comments and their IDs.",
            },
            reply: { type: "string", description: "The reply text" },
            instance: {
              type: "string",
              description: "Instance name override. Auto-detected from issue key prefix if omitted.",
            },
          },
          required: ["issueKey", "commentId", "reply"],
        },
      },
      {
        name: "jira_edit_comment",
        description:
          "Edit an existing comment on a Jira ticket. Replaces the comment text. IMPORTANT: Use @DisplayName (e.g. @Julia Pereszta) for mentions — NOT [~accountId:...] syntax. Keep comments non-technical and user-facing. Never mention git details like 'pushed to main', branch names, or technical implementation details.",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "The Jira issue key (e.g., MODS-123)",
            },
            commentId: {
              type: "string",
              description:
                "The ID of the comment to edit. Use jira_get_ticket to see comments and their IDs.",
            },
            comment: { type: "string", description: "The new comment text" },
            instance: {
              type: "string",
              description: "Instance name override. Auto-detected from issue key prefix if omitted.",
            },
          },
          required: ["issueKey", "commentId", "comment"],
        },
      },
      {
        name: "jira_delete_comment",
        description:
          "Delete a comment from a Jira ticket. This action is irreversible.",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "The Jira issue key (e.g., MODS-123)",
            },
            commentId: {
              type: "string",
              description:
                "The ID of the comment to delete. Use jira_get_ticket to see comments and their IDs.",
            },
            instance: {
              type: "string",
              description: "Instance name override. Auto-detected from issue key prefix if omitted.",
            },
          },
          required: ["issueKey", "commentId"],
        },
      },
      {
        name: "jira_transition",
        description:
          "Change the status of a Jira ticket. Use targetStatus to transition by name (auto-handles intermediate steps like In Progress), transitionId for direct transition, or omit both to list available transitions.",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "The Jira issue key (e.g., MODS-123)",
            },
            transitionId: {
              type: "string",
              description:
                "The transition ID to execute. Omit to list available transitions.",
            },
            targetStatus: {
              type: "string",
              description:
                "Target status name (e.g., 'Review', 'Done'). Will auto-transition through intermediate states if needed.",
            },
            instance: {
              type: "string",
              description: "Instance name override. Auto-detected from issue key prefix if omitted.",
            },
          },
          required: ["issueKey"],
        },
      },
      {
        name: "jira_update_ticket",
        description:
          "Update fields on a Jira ticket. IMPORTANT: Only pass the fields you want to change. Omitted fields are left untouched. NEVER use em dashes (—) or en dashes (–) in text — use commas, periods, or rewrite the sentence instead.",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "The Jira issue key (e.g., MODS-123)",
            },
            summary: {
              type: "string",
              description:
                "Text to add to the title. By default APPENDS to existing title. Set replaceSummary=true to replace instead.",
            },
            replaceSummary: {
              type: "boolean",
              description:
                "If true, replaces the entire title. Default is false (append).",
            },
            description: {
              type: "string",
              description:
                "Text to add to the description. By default APPENDS to existing content. Set replaceDescription=true to replace instead.",
            },
            replaceDescription: {
              type: "boolean",
              description:
                "If true, replaces the entire description. Default is false (append).",
            },
            removeFromDescription: {
              type: "string",
              description:
                "Text to find and remove from the existing description.",
            },
            assignee: {
              type: "string",
              description: "Assignee account ID (use 'unassigned' to clear)",
            },
            priority: {
              type: "string",
              description: "Priority name (e.g., High, Medium, Low)",
            },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "Labels to set on the ticket",
            },
            instance: {
              type: "string",
              description: "Instance name override. Auto-detected from issue key prefix if omitted.",
            },
          },
          required: ["issueKey"],
        },
      },
      {
        name: "jira_search_users",
        description:
          "Search for Jira users by name or email. Returns account IDs and display names. Use this to find users for mentions or assignments. When multiple Jira instances are configured, use the 'instance' parameter to specify which one.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Search query - name or email (e.g., 'Julia', 'hemant', 'rui.branco@kone.com')",
            },
            maxResults: {
              type: "number",
              description: "Max results (default 5)",
            },
            instance: {
              type: "string",
              description: "Instance name (for multi-instance setups). Uses default instance if omitted.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "jira_get_changelog",
        description:
          "Get status change history for a Jira ticket or multiple tickets via JQL. Returns all status transitions with timestamps and authors, plus computed metrics (cycle time, lead time, time in each status). Use issueKey for a single ticket, or jql for bulk retrieval. Instance is auto-detected from issueKey, or use the 'instance' parameter with jql.",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description:
                "Single issue key (e.g., MODS-13996). Use this OR jql, not both.",
            },
            jql: {
              type: "string",
              description:
                "JQL query to get changelogs for multiple tickets (e.g., 'project = MODS AND sprint = 123'). Use this OR issueKey, not both.",
            },
            maxResults: {
              type: "number",
              description:
                "Max results when using jql (default 50). Each ticket requires a separate API call, so keep this reasonable.",
            },
            instance: {
              type: "string",
              description: "Instance name (for multi-instance setups with jql). Auto-detected from issueKey if provided.",
            },
          },
          required: [],
        },
      },
      {
        name: "jira_add_instance",
        description:
          "Add or update a Jira instance configuration. Saves to config and makes it available immediately without restart. To add a new instance, provide name + email + token + baseUrl. To update an existing instance (e.g. change projects or set as default), just provide name and the fields to change.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Unique name for this instance (e.g., 'work', 'personal')",
            },
            email: {
              type: "string",
              description: "Jira account email (required for new instances)",
            },
            token: {
              type: "string",
              description: "Jira API token (required for new instances)",
            },
            baseUrl: {
              type: "string",
              description: "Jira base URL (required for new instances, e.g., https://company.atlassian.net)",
            },
            projects: {
              type: "array",
              items: { type: "string" },
              description: "Project key prefixes to auto-route to this instance (e.g., ['PROJ', 'ENG']). Replaces existing projects.",
            },
            setDefault: {
              type: "boolean",
              description: "Set this instance as the default (default: false)",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "jira_remove_instance",
        description:
          "Remove a Jira instance configuration by name. Cannot remove the last remaining instance.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name of the instance to remove",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "jira_list_instances",
        description:
          "List all configured Jira instances with their names, URLs, project prefixes, and which is the default.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "jira_get_myself") {
      const inst = getInstanceByName(args.instance);
      const result = await fetchJira("/myself", {}, inst);
      return {
        content: [
          {
            type: "text",
            text: `**Account ID:** ${result.accountId}\n**Display Name:** ${result.displayName}\n**Email:** ${result.emailAddress || "N/A"}`,
          },
        ],
      };
    } else if (name === "jira_search_users") {
      const inst = getInstanceByName(args.instance);
      const maxResults = args.maxResults || 5;
      const users = await fetchJira(
        `/user/search?query=${encodeURIComponent(args.query)}&maxResults=${maxResults}`,
        {},
        inst,
      );
      if (!users || users.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No users found for "${args.query}".`,
            },
          ],
        };
      }
      const lines = users.map(
        (u) =>
          `- **${u.displayName}** (accountId: ${u.accountId}${u.emailAddress ? `, email: ${u.emailAddress}` : ""})`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Found ${users.length} user(s) for "${args.query}":\n\n${lines.join("\n")}`,
          },
        ],
      };
    } else if (name === "jira_get_ticket") {
      if (!args.issueKey) {
        return { content: [{ type: "text", text: "Error: Missing required parameter 'issueKey'. You passed 'ticketId' which is not a valid parameter. Use 'issueKey' instead (e.g. issueKey: \"MODS-12115\")." }] };
      }
      const downloadImages = args.downloadImages !== false;
      const fetchFigma = args.fetchFigma !== false;
      const inst = args.instance ? getInstanceByName(args.instance) : null;
      const result = await getTicket(args.issueKey, downloadImages, fetchFigma, inst);

      const content = [{ type: "text", text: result.text }];

      // Add Jira images
      for (const imagePath of result.jiraImages) {
        try {
          const imageData = fs.readFileSync(imagePath);
          const ext = path.extname(imagePath).toLowerCase();
          const mimeType =
            ext === ".png"
              ? "image/png"
              : ext === ".gif"
                ? "image/gif"
                : ext === ".webp"
                  ? "image/webp"
                  : "image/jpeg";
          content.push({
            type: "image",
            data: imageData.toString("base64"),
            mimeType: mimeType,
          });
        } catch (e) {
          /* skip */
        }
      }

      // Add Figma images (now supports multiple images per design)
      for (const design of result.figmaDesigns) {
        if (design.images && design.images.length > 0) {
          for (const img of design.images) {
            if (img.buffer) {
              content.push({
                type: "image",
                data: img.buffer.toString("base64"),
                mimeType: "image/png",
              });
            }
          }
        }
      }

      return { content };
    } else if (name === "jira_search") {
      const inst = getInstanceByName(args.instance);
      const result = await searchTickets(args.jql, args.maxResults || 10, args.fields || null, inst);
      return { content: [{ type: "text", text: result }] };
    } else if (name === "jira_add_comment") {
      const inst = args.instance ? getInstanceByName(args.instance) : getInstanceForKey(args.issueKey);
      // Build ADF content with mention support
      const adfContent = await buildCommentADF(args.comment, inst);
      const body = {
        body: {
          version: 1,
          type: "doc",
          content: adfContent,
        },
      };
      const result = await fetchJira(`/issue/${args.issueKey}/comment`, {
        method: "POST",
        body,
      }, inst);
      const author = result.author?.displayName || "Unknown";
      const created = new Date(result.created).toLocaleString();
      return {
        content: [
          {
            type: "text",
            text: `Comment added to ${args.issueKey} by ${author} at ${created}.`,
          },
        ],
      };
    } else if (name === "jira_reply_comment") {
      const inst = args.instance ? getInstanceByName(args.instance) : getInstanceForKey(args.issueKey);
      // Fetch the original comment
      const original = await fetchJira(
        `/issue/${args.issueKey}/comment/${args.commentId}`,
        {},
        inst,
      );
      const originalAuthor = original.author?.displayName || "Unknown";
      const originalAccountId = original.author?.accountId;
      const originalText = extractTextSimple(original.body).trim();
      // Truncate quote if too long
      const quote =
        originalText.length > 200
          ? originalText.substring(0, 200) + "..."
          : originalText;

      // Build ADF with mention, quote, and reply
      const replyContent = [];

      // Mention the original author
      if (originalAccountId) {
        replyContent.push({
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: { id: originalAccountId, text: `@${originalAuthor}` },
            },
          ],
        });
      }

      // Quote the original comment
      replyContent.push({
        type: "blockquote",
        content: [
          { type: "paragraph", content: [{ type: "text", text: quote }] },
        ],
      });

      // The reply text
      replyContent.push({
        type: "paragraph",
        content: [{ type: "text", text: args.reply }],
      });

      const body = {
        body: {
          version: 1,
          type: "doc",
          content: replyContent,
        },
      };
      const result = await fetchJira(`/issue/${args.issueKey}/comment`, {
        method: "POST",
        body,
      }, inst);
      const author = result.author?.displayName || "Unknown";
      const created = new Date(result.created).toLocaleString();
      return {
        content: [
          {
            type: "text",
            text: `Reply to ${originalAuthor}'s comment posted on ${args.issueKey} by ${author} at ${created}.`,
          },
        ],
      };
    } else if (name === "jira_edit_comment") {
      const inst = args.instance ? getInstanceByName(args.instance) : getInstanceForKey(args.issueKey);
      // Build ADF content with mention support
      const adfContent = await buildCommentADF(args.comment, inst);
      const body = {
        body: {
          version: 1,
          type: "doc",
          content: adfContent,
        },
      };
      const result = await fetchJira(
        `/issue/${args.issueKey}/comment/${args.commentId}`,
        { method: "PUT", body },
        inst,
      );
      return {
        content: [
          {
            type: "text",
            text: `Comment ${args.commentId} on ${args.issueKey} updated.`,
          },
        ],
      };
    } else if (name === "jira_delete_comment") {
      const inst = args.instance ? getInstanceByName(args.instance) : getInstanceForKey(args.issueKey);
      await fetchJira(`/issue/${args.issueKey}/comment/${args.commentId}`, {
        method: "DELETE",
      }, inst);
      return {
        content: [
          {
            type: "text",
            text: `Comment ${args.commentId} on ${args.issueKey} deleted.`,
          },
        ],
      };
    } else if (name === "jira_transition") {
      const inst = args.instance ? getInstanceByName(args.instance) : getInstanceForKey(args.issueKey);
      if (!args.transitionId && !args.targetStatus) {
        // List available transitions
        const result = await fetchJira(`/issue/${args.issueKey}/transitions`, {}, inst);
        let output = `# Available transitions for ${args.issueKey}\n\n`;
        for (const t of result.transitions || []) {
          output += `- **${t.name}** (id: ${t.id}) → status: ${t.to?.name || "Unknown"}\n`;
        }
        if (!result.transitions?.length) {
          output += "_No transitions available._\n";
        }
        return { content: [{ type: "text", text: output }] };
      }

      // If targetStatus is provided, find the transition by status name
      if (args.targetStatus) {
        const targetLower = args.targetStatus.toLowerCase();
        const transitions = [];

        // Try to reach target status, with up to 3 intermediate transitions
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await fetchJira(`/issue/${args.issueKey}/transitions`, {}, inst);
          const available = result.transitions || [];

          // Check if target status is directly available
          const directMatch = available.find(
            (t) =>
              t.to?.name?.toLowerCase() === targetLower ||
              t.name?.toLowerCase() === targetLower,
          );

          if (directMatch) {
            await fetchJira(`/issue/${args.issueKey}/transitions`, {
              method: "POST",
              body: { transition: { id: directMatch.id } },
            }, inst);
            transitions.push(directMatch.to?.name || directMatch.name);
            return {
              content: [
                {
                  type: "text",
                  text: `Transitioned ${args.issueKey} to ${transitions.join(" → ")}.`,
                },
              ],
            };
          }

          // Target not available, try "In Progress" as intermediate step
          const inProgress = available.find(
            (t) =>
              t.to?.name?.toLowerCase() === "in progress" ||
              t.name?.toLowerCase() === "in progress",
          );

          if (inProgress) {
            await fetchJira(`/issue/${args.issueKey}/transitions`, {
              method: "POST",
              body: { transition: { id: inProgress.id } },
            }, inst);
            transitions.push(inProgress.to?.name || "In Progress");
            continue; // Try again to find target
          }

          // No path found
          break;
        }

        // Could not reach target status
        const result = await fetchJira(`/issue/${args.issueKey}/transitions`, {}, inst);
        const availableNames = (result.transitions || [])
          .map((t) => t.to?.name || t.name)
          .join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Could not transition to "${args.targetStatus}". Available: ${availableNames}`,
            },
          ],
        };
      }

      // Execute transition by ID
      await fetchJira(`/issue/${args.issueKey}/transitions`, {
        method: "POST",
        body: { transition: { id: args.transitionId } },
      }, inst);
      return {
        content: [
          {
            type: "text",
            text: `Transition ${args.transitionId} executed on ${args.issueKey}.`,
          },
        ],
      };
    } else if (name === "jira_update_ticket") {
      const inst = args.instance ? getInstanceByName(args.instance) : getInstanceForKey(args.issueKey);
      const fields = {};
      if (args.summary) {
        if (args.replaceSummary) {
          fields.summary = args.summary;
        } else {
          // Append to existing title (default)
          const issue = await fetchJira(
            `/issue/${args.issueKey}?fields=summary`, {}, inst,
          );
          const existing = issue.fields?.summary || "";
          fields.summary = existing + " " + args.summary;
        }
      }
      if (args.description) {
        const newParagraph = {
          type: "paragraph",
          content: [{ type: "text", text: args.description }],
        };
        if (args.replaceDescription) {
          // Full replace
          fields.description = {
            version: 1,
            type: "doc",
            content: [newParagraph],
          };
        } else {
          // Append to existing (default)
          const issue = await fetchJira(
            `/issue/${args.issueKey}?fields=description`, {}, inst,
          );
          const existing = issue.fields?.description;
          if (existing && existing.content) {
            existing.content.push(newParagraph);
            fields.description = existing;
          } else {
            fields.description = {
              version: 1,
              type: "doc",
              content: [newParagraph],
            };
          }
        }
      }
      if (args.removeFromDescription) {
        const issue = await fetchJira(
          `/issue/${args.issueKey}?fields=description`, {}, inst,
        );
        const existing = issue.fields?.description;
        if (existing && existing.content) {
          // Recursively remove matching text from all text nodes
          function removeText(nodes) {
            return nodes
              .map((node) => {
                if (node.type === "text" && node.text) {
                  node.text = node.text.replace(args.removeFromDescription, "");
                }
                if (node.content) {
                  node.content = removeText(node.content);
                }
                return node;
              })
              .filter((node) => {
                // Remove empty text nodes
                if (node.type === "text" && (!node.text || !node.text.trim()))
                  return false;
                // Remove empty paragraphs
                if (
                  node.type === "paragraph" &&
                  (!node.content || node.content.length === 0)
                )
                  return false;
                return true;
              });
          }
          existing.content = removeText(existing.content);
          fields.description = existing;
        }
      }
      if (args.assignee) {
        fields.assignee =
          args.assignee === "unassigned" ? null : { accountId: args.assignee };
      }
      if (args.priority) {
        fields.priority = { name: args.priority };
      }
      if (args.labels) {
        fields.labels = args.labels;
      }

      if (Object.keys(fields).length === 0) {
        return {
          content: [{ type: "text", text: "No fields provided to update." }],
        };
      }

      await fetchJira(`/issue/${args.issueKey}`, {
        method: "PUT",
        body: { fields },
      }, inst);
      const updated = Object.keys(fields).join(", ");
      return {
        content: [
          { type: "text", text: `Updated ${args.issueKey}: ${updated}.` },
        ],
      };
    } else if (name === "jira_get_changelog") {
      if (!args.issueKey && !args.jql) {
        return {
          content: [{ type: "text", text: "Error: Provide either issueKey or jql parameter." }],
          isError: true,
        };
      }
      if (args.issueKey) {
        const result = await getChangelog(args.issueKey);
        return { content: [{ type: "text", text: result.formatted }] };
      } else {
        const inst = getInstanceByName(args.instance);
        const result = await getChangelogsBulk(args.jql, args.maxResults || 50, inst);
        return { content: [{ type: "text", text: result }] };
      }
    } else if (name === "jira_add_instance") {
      const instName = args.name.trim();
      const existingIdx = instances.findIndex((i) => i.name === instName);
      const isUpdate = existingIdx >= 0;

      // For new instances, email/token/baseUrl are required
      if (!isUpdate && (!args.email || !args.token || !args.baseUrl)) {
        return {
          content: [{ type: "text", text: "New instance requires email, token, and baseUrl." }],
          isError: true,
        };
      }

      // Merge with existing or create new
      const existing = isUpdate ? instances[existingIdx] : {};
      const email = args.email || existing.email;
      const token = args.token || existing.token;
      const baseUrl = args.baseUrl ? args.baseUrl.replace(/\/$/, "") : existing.baseUrl;
      const projects = args.projects ? args.projects.map((p) => p.toUpperCase()) : (existing.projects || []);
      const authStr = Buffer.from(`${email}:${token}`).toString("base64");

      const newInstance = { name: instName, email, token, baseUrl, projects, auth: authStr };

      // Update in-memory instances
      if (isUpdate) {
        instances[existingIdx] = newInstance;
      } else {
        instances.push(newInstance);
      }

      // Persist to config file
      const savedConfig = loadConfigFile();
      if (!savedConfig.instances) {
        // Migrate old format
        if (savedConfig.email) {
          savedConfig.instances = [{
            name: "default",
            email: savedConfig.email,
            token: savedConfig.token,
            baseUrl: savedConfig.baseUrl,
            projects: [],
          }];
          savedConfig.defaultInstance = "default";
          delete savedConfig.email;
          delete savedConfig.token;
          delete savedConfig.baseUrl;
        } else {
          savedConfig.instances = [];
        }
      }

      // Save without the computed auth field
      const toSave = { name: instName, email, token, baseUrl, projects };
      const savedIdx = savedConfig.instances.findIndex((i) => i.name === instName);
      if (savedIdx >= 0) {
        savedConfig.instances[savedIdx] = toSave;
      } else {
        savedConfig.instances.push(toSave);
      }
      if (args.setDefault || !savedConfig.defaultInstance) {
        savedConfig.defaultInstance = instName;
      }
      fs.writeFileSync(jiraConfigPath, JSON.stringify(savedConfig, null, 2));

      const action = isUpdate ? "Updated" : "Added";
      let text = `${action} instance "${instName}" (${baseUrl}).`;
      if (projects.length > 0) text += ` Projects: ${projects.join(", ")}.`;
      if (args.setDefault) text += " Set as default.";

      return { content: [{ type: "text", text }] };

    } else if (name === "jira_remove_instance") {
      const instName = args.name.trim();

      if (instances.length <= 1) {
        return {
          content: [{ type: "text", text: "Cannot remove the last remaining instance." }],
          isError: true,
        };
      }

      const idx = instances.findIndex((i) => i.name === instName);
      if (idx < 0) {
        return {
          content: [{ type: "text", text: `Instance "${instName}" not found.` }],
          isError: true,
        };
      }

      instances.splice(idx, 1);

      // Persist to config file
      const savedConfig = loadConfigFile();
      if (savedConfig.instances) {
        savedConfig.instances = savedConfig.instances.filter((i) => i.name !== instName);
        if (savedConfig.defaultInstance === instName) {
          savedConfig.defaultInstance = savedConfig.instances[0]?.name || null;
        }
        fs.writeFileSync(jiraConfigPath, JSON.stringify(savedConfig, null, 2));
      }

      return { content: [{ type: "text", text: `Removed instance "${instName}".` }] };

    } else if (name === "jira_list_instances") {
      if (instances.length === 0) {
        return { content: [{ type: "text", text: "No instances configured." }] };
      }
      const currentDefault = rawConfig.defaultInstance || instances[0].name;
      let text = `# Configured Jira Instances (${instances.length})\n\n`;
      for (const inst of instances) {
        const isDefault = inst.name === currentDefault ? " **(default)**" : "";
        const projs = inst.projects?.length > 0 ? `\n  Projects: ${inst.projects.join(", ")}` : "";
        text += `- **${inst.name}**${isDefault}: ${inst.baseUrl} (${inst.email})${projs}\n`;
      }
      return { content: [{ type: "text", text }] };

    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
