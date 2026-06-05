const core = require('@actions/core');
const github = require('@actions/github');
const https = require('https');

const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const COMMENT_MARKER = '<!-- zai-code-review -->';
const MAX_RESPONSE_SIZE = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 300_000;

const AGENT_CONFIGS = {
  compliance: {
    label: 'Compliance',
    buildSystemPrompt: (base) =>
      `${base}\n\nYou are a compliance auditor. Your ONLY job is to find violations of the project rules in the "Project Instructions" section. For every finding you MUST quote the exact rule being violated. If you cannot quote an exact rule, do not report the issue.`,
    buildInstructions: (minConfidence) => `## Review Instructions — Compliance
Your ONLY job is to find violations of the rules defined in the "Project Instructions" section.

**Report ONLY:**
- Violations where you can quote the EXACT sentence or rule from the project instructions
- Include the quoted rule at the start of \`body\` using a blockquote

**DO NOT report:**
- Bugs, logic errors, or runtime issues (another agent handles those)
- Security vulnerabilities (another agent handles those)
- Issues where no explicit rule exists in the project instructions
- Style or formatting preferences not explicitly listed in the instructions

**Confidence requirement:** Only include findings with confidence >= ${minConfidence}%.`,
  },

  bugs: {
    label: 'Bugs',
    buildSystemPrompt: (base) =>
      `${base}\n\nYou are a bug hunter. Your ONLY job is to find code that will definitely fail to compile or produce wrong results at runtime.`,
    buildInstructions: (minConfidence) => `## Review Instructions — Bugs & Compilation Errors
Your ONLY job is to find code that will definitively fail.

**Report ONLY:**
- Compilation errors (missing imports, wrong constructor/method visibility, unresolved types, missing interface methods)
- Clear logic errors that produce wrong results for any input
- Null / undefined access that will throw at runtime
- Type mismatches that will fail at compile or runtime

**DO NOT report:**
- Architecture or design concerns (another agent handles those)
- CLAUDE.md / project rule violations (another agent handles those)
- Issues that only occur under specific or edge-case inputs you cannot verify from the code
- Style, naming, or formatting

**Confidence requirement:** Only include findings with confidence >= ${minConfidence}%.`,
  },

  architecture: {
    label: 'Architecture & Security',
    buildSystemPrompt: (base) =>
      `${base}\n\nYou are an architecture and security reviewer. Your ONLY job is to find security vulnerabilities, significant code duplication, and architectural violations.`,
    buildInstructions: (minConfidence) => `## Review Instructions — Architecture & Security
Your ONLY job is to find architectural and security issues.

**Report ONLY:**
- Security vulnerabilities (injection, auth bypass, data exposure, missing input bounds)
- Significant code duplication across 3+ files (identical or near-identical logic copy-pasted)
- Architectural violations (wrong dependency direction, infrastructure leaking into domain, etc.)
- Missing validation that creates real security or correctness risk (e.g., unbounded page size, unvalidated sort fields)

**DO NOT report:**
- Compilation errors or runtime bugs (another agent handles those)
- CLAUDE.md / project instruction violations (another agent handles those)
- Minor quality concerns or nitpicks
- Speculative issues without clear evidence in the diff or full file content

**Confidence requirement:** Only include findings with confidence >= ${minConfidence}%.`,
  },
};

function matchesPattern(filename, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  const basename = filename.split('/').pop();
  return regex.test(filename) || regex.test(basename);
}

function filterFiles(files, excludePatterns) {
  if (!excludePatterns || excludePatterns.length === 0) return files;
  return files.filter(f => !excludePatterns.some(p => matchesPattern(f.filename, p)));
}

async function getChangedFiles(octokit, owner, repo, pullNumber) {
  const files = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    files.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return files;
}

async function getFileContent(octokit, owner, repo, path, ref) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (data.type !== 'file' || !data.content) return null;
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

async function getFullFileContents(octokit, owner, repo, changedFiles, ref, maxChars) {
  if (maxChars === 0) return {};
  const result = {};
  await Promise.all(
    changedFiles
      .filter(f => f.status !== 'removed')
      .map(async f => {
        const content = await getFileContent(octokit, owner, repo, f.filename, ref);
        if (content && content.length <= maxChars) {
          result[f.filename] = content;
        }
      })
  );
  return result;
}

async function collectInstructionFiles(octokit, owner, repo, instructionFileNames, changedFiles, ref) {
  const dirsToCheck = new Set(['']);
  for (const f of changedFiles) {
    const parts = f.filename.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirsToCheck.add(parts.slice(0, i).join('/'));
    }
  }

  const collected = [];
  for (const dir of [...dirsToCheck].sort()) {
    for (const name of instructionFileNames) {
      const path = dir ? `${dir}/${name}` : name;
      const content = await getFileContent(octokit, owner, repo, path, ref);
      if (content) collected.push({ path, content });
    }
  }
  return collected;
}

function buildAgentPrompt(agentType, prContext, changedFiles, instructionFiles, fullContents, maxDiffChars, minConfidence) {
  const config = AGENT_CONFIGS[agentType];
  const { title, body, author, baseRef, headRef } = prContext;
  const sections = [];

  sections.push(
    `## Pull Request Context\n**Title:** ${title}\n**Author:** ${author}\n**Base:** ${baseRef} → **Head:** ${headRef}` +
    (body ? `\n**Description:**\n${body}` : '')
  );

  const fileList = changedFiles.map(f => `- \`${f.filename}\` (${f.status})`).join('\n');
  sections.push(`## Changed Files\n${fileList}`);

  if (instructionFiles.length > 0) {
    const instrContent = instructionFiles
      .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
      .join('\n\n');
    sections.push(`## Project Instructions\n${instrContent}`);
  }

  const fullContentEntries = changedFiles
    .filter(f => fullContents[f.filename])
    .map(f => `### ${f.filename}\n\`\`\`\n${fullContents[f.filename]}\n\`\`\``);
  if (fullContentEntries.length > 0) {
    sections.push(`## Full File Contents\n${fullContentEntries.join('\n\n')}`);
  }

  const patchableFiles = changedFiles.filter(f => f.patch);
  const includedDiffs = [];
  const skippedFiles = [];
  let totalChars = 0;

  for (const f of patchableFiles) {
    const entry = `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``;
    if (maxDiffChars > 0 && totalChars + entry.length > maxDiffChars) {
      skippedFiles.push(f.filename);
    } else {
      includedDiffs.push(entry);
      totalChars += entry.length;
    }
  }

  let diffsSection = includedDiffs.join('\n\n');
  if (skippedFiles.length > 0) {
    diffsSection += `\n\n> **Note:** The following files were excluded because the diff exceeded the \`MAX_DIFF_CHARS\` limit:\n${skippedFiles.map(f => `> - ${f}`).join('\n')}`;
  }
  sections.push(`## Code Diff\n${diffsSection}`);

  sections.push(config.buildInstructions(minConfidence));

  sections.push(`Respond with ONLY valid JSON (no markdown fences, no explanation) in this exact schema:
{
  "summary": "Brief summary of what you found from your specific review focus (empty string if nothing found)",
  "findings": [
    {
      "path": "path/to/file.js",
      "line": 42,
      "severity": "critical|high|medium|low",
      "confidence": 90,
      "title": "Short title of the issue",
      "body": "Detailed explanation. For compliance: start with a blockquote of the exact rule. Include relevant code snippets where helpful.",
      "suggestion": "Optional: concrete fix or code snippet"
    }
  ]
}`);

  return sections.join('\n\n');
}

function parseReviewResponse(responseText, minConfidence) {
  let jsonText = responseText.trim();

  if (jsonText.startsWith('```')) {
    const codeBlockMatch = jsonText.match(/^```(?:\w+)?\s*\n?([\s\S]*?)\n?```\s*$/);
    if (codeBlockMatch) jsonText = codeBlockMatch[1].trim();
  }

  const firstBrace = jsonText.indexOf('{');
  const lastBrace = jsonText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    jsonText = jsonText.slice(firstBrace, lastBrace + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  if (typeof parsed.summary !== 'string') parsed.summary = '';
  if (!Array.isArray(parsed.findings)) parsed.findings = [];

  const seen = new Set();
  const validFindings = [];

  for (const f of parsed.findings) {
    if (typeof f !== 'object' || f === null) continue;
    if (typeof f.path !== 'string' || !f.path) continue;
    if (typeof f.line !== 'number' || !Number.isInteger(f.line) || f.line < 1) continue;
    if (typeof f.confidence !== 'number' || f.confidence < minConfidence) continue;

    const key = `${f.path}:${f.line}:${String(f.title || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    validFindings.push({
      path: f.path,
      line: f.line,
      severity: ['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium',
      confidence: f.confidence,
      title: typeof f.title === 'string' ? f.title : 'Issue',
      body: typeof f.body === 'string' ? f.body : '',
      suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined,
    });
  }

  return { summary: parsed.summary, findings: validFindings };
}

function groupFindings(findings) {
  const groups = new Map();
  for (const f of findings) {
    const key = f.title.toLowerCase().trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const result = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    group.sort((a, b) => b.confidence - a.confidence);
    const representative = { ...group[0] };
    const otherLocations = group.slice(1).map(f => `\`${f.path}:${f.line}\``).join(', ');
    representative.body += `\n\n**Also affects:** ${otherLocations}`;
    result.push(representative);
  }
  return result;
}

function mergeAgentFindings(agentResults) {
  const allFindings = [];
  const summaries = [];

  for (const result of agentResults) {
    if (!result) continue;
    if (result.summary) summaries.push(result.summary);
    allFindings.push(...result.findings);
  }

  const grouped = groupFindings(allFindings);

  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  grouped.sort((a, b) => {
    const sv = (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2);
    if (sv !== 0) return sv;
    return b.confidence - a.confidence;
  });

  return { summary: summaries.filter(Boolean).join(' '), findings: grouped };
}

function severityEmoji(severity) {
  return { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[severity] || '⚪';
}

function findingInlineBody(finding) {
  let body = `**${severityEmoji(finding.severity)} ${finding.title}** *(${finding.severity}, confidence: ${finding.confidence}%)*\n\n${finding.body}`;
  if (finding.suggestion) body += `\n\n**Suggestion:**\n${finding.suggestion}`;
  return body;
}

function callZaiApi(apiKey, model, systemPrompt, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    });

    const url = new URL(ZAI_API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_RESPONSE_SIZE) {
          req.destroy(new Error('Z.ai API response exceeded size limit.'));
        }
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            reject(new Error('Z.ai API returned invalid JSON.'));
            return;
          }
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) {
            reject(new Error('Z.ai API returned an empty response.'));
          } else {
            resolve(content);
          }
        } else {
          reject(new Error(`Z.ai API error ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Z.ai API request timed out.'));
    });
    req.write(body);
    req.end();
  });
}

async function runParallelAgents(apiKey, model, baseSystemPrompt, prContext, changedFiles, instructionFiles, fullContents, maxDiffChars, minConfidence) {
  const agentTypes = Object.keys(AGENT_CONFIGS);
  core.info(`Running ${agentTypes.length} parallel review agents (${agentTypes.join(', ')})...`);

  const results = await Promise.all(
    agentTypes.map(async agentType => {
      const config = AGENT_CONFIGS[agentType];
      const systemPrompt = config.buildSystemPrompt(baseSystemPrompt);
      const prompt = buildAgentPrompt(agentType, prContext, changedFiles, instructionFiles, fullContents, maxDiffChars, minConfidence);
      try {
        const rawResponse = await callZaiApi(apiKey, model, systemPrompt, prompt);
        const parsed = parseReviewResponse(rawResponse, minConfidence);
        if (parsed) {
          core.info(`Agent [${config.label}]: ${parsed.findings.length} finding(s).`);
        } else {
          core.warning(`Agent [${config.label}]: could not parse response.`);
        }
        return parsed;
      } catch (err) {
        core.warning(`Agent [${config.label}] failed: ${err.message}`);
        return null;
      }
    })
  );

  return mergeAgentFindings(results);
}

async function postOrUpdateGeneralComment(octokit, owner, repo, pullNumber, body) {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullNumber,
  });
  const existing = comments.find(c => c.body.includes(COMMENT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    core.info('Review comment updated.');
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
    core.info('Review comment posted.');
  }
}

async function run() {
  const apiKey = core.getInput('ZAI_API_KEY', { required: true });
  core.setSecret(apiKey);
  const model = core.getInput('ZAI_MODEL');
  const systemPrompt = core.getInput('ZAI_SYSTEM_PROMPT');
  const reviewerName = core.getInput('ZAI_REVIEWER_NAME');
  const excludePatterns = core.getInput('EXCLUDE_PATTERNS')
    .split(',').map(p => p.trim()).filter(p => p.length > 0);
  const maxDiffChars = parseInt(core.getInput('MAX_DIFF_CHARS'), 10) || 0;
  const maxFileContentCharsRaw = parseInt(core.getInput('MAX_FILE_CONTENT_CHARS'), 10);
  const maxFileContentChars = Number.isNaN(maxFileContentCharsRaw) ? 20000 : maxFileContentCharsRaw;
  const token = core.getInput('GITHUB_TOKEN');
  core.setSecret(token);

  const postInlineComments = core.getInput('POST_INLINE_COMMENTS') !== 'false';
  const includeProjectInstructions = core.getInput('INCLUDE_PROJECT_INSTRUCTIONS') !== 'false';
  const projectInstructionFiles = core.getInput('PROJECT_INSTRUCTION_FILES')
    .split(',').map(p => p.trim()).filter(p => p.length > 0);
  const minConfidence = parseInt(core.getInput('MIN_CONFIDENCE'), 10) || 80;
  const trustedInstructionsRef = core.getInput('TRUSTED_INSTRUCTIONS_REF') || 'base';

  const { context } = github;
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  const pullNumber = pr?.number;

  if (!pullNumber) {
    core.setFailed('This action only runs on pull_request events.');
    return;
  }

  const prContext = {
    number: pullNumber,
    title: pr.title || '',
    body: pr.body || '',
    author: pr.user?.login || '',
    baseRef: pr.base?.ref || '',
    headRef: pr.head?.ref || '',
    headSha: pr.head?.sha || '',
    baseSha: pr.base?.sha || '',
  };

  const octokit = github.getOctokit(token);

  core.info(`Fetching changed files for PR #${pullNumber}...`);
  const files = await getChangedFiles(octokit, owner, repo, pullNumber);
  const filteredFiles = filterFiles(files, excludePatterns);

  if (excludePatterns.length > 0) {
    const excluded = files.length - filteredFiles.length;
    if (excluded > 0) core.info(`Excluded ${excluded} file(s) matching EXCLUDE_PATTERNS.`);
  }

  if (!filteredFiles.some(f => f.patch)) {
    core.info('No patchable changes found after filtering. Skipping review.');
    return;
  }

  let fullContents = {};
  if (maxFileContentChars !== 0) {
    core.info(`Fetching full file contents (max ${maxFileContentChars} chars/file)...`);
    fullContents = await getFullFileContents(octokit, owner, repo, filteredFiles, prContext.headSha, maxFileContentChars);
    core.info(`Fetched full content for ${Object.keys(fullContents).length} file(s).`);
  }

  let instructionFiles = [];
  if (includeProjectInstructions && projectInstructionFiles.length > 0) {
    const ref = trustedInstructionsRef === 'head' ? prContext.headRef : prContext.baseRef;
    core.info(`Reading project instruction files from ref "${ref}"...`);
    instructionFiles = await collectInstructionFiles(
      octokit, owner, repo, projectInstructionFiles, filteredFiles, ref
    );
    if (instructionFiles.length > 0) {
      core.info(`Found instruction file(s): ${instructionFiles.map(f => f.path).join(', ')}`);
    }
  }

  const parsed = await runParallelAgents(
    apiKey, model, systemPrompt,
    prContext, filteredFiles, instructionFiles, fullContents,
    maxDiffChars, minConfidence
  );

  core.info(`Total: ${parsed.findings.length} finding(s) after merging agents.`);

  if (parsed.findings.length === 0) {
    const noIssuesBody = `## ${reviewerName}\n\nNo high-confidence issues found. Checked for bugs, compliance, and architectural concerns.\n\n${COMMENT_MARKER}`;
    await postOrUpdateGeneralComment(octokit, owner, repo, pullNumber, noIssuesBody);
    return;
  }

  if (postInlineComments) {
    const reviewComments = parsed.findings.map(f => ({
      path: f.path,
      line: f.line,
      side: 'RIGHT',
      body: findingInlineBody(f),
    }));

    const summaryBody = [
      `## ${reviewerName}`,
      '',
      parsed.summary || '',
      '',
      `Found **${parsed.findings.length}** issue(s) — see inline comments for details.`,
      '',
      COMMENT_MARKER,
    ].join('\n');

    let fallbackFindings = [];

    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: prContext.headSha,
        event: 'COMMENT',
        body: summaryBody,
        comments: reviewComments,
      });
      core.info(`Posted PR review with ${reviewComments.length} inline comment(s).`);
    } catch (batchErr) {
      core.warning(`Batch review failed (${batchErr.message}). Retrying comments individually...`);
      let successCount = 0;
      for (let i = 0; i < parsed.findings.length; i++) {
        try {
          await octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: pullNumber,
            commit_id: prContext.headSha,
            event: 'COMMENT',
            body: '',
            comments: [reviewComments[i]],
          });
          successCount++;
        } catch {
          fallbackFindings.push(parsed.findings[i]);
        }
      }
      core.info(`Posted ${successCount} inline comment(s), ${fallbackFindings.length} fell back to summary.`);
    }

    if (fallbackFindings.length > 0) {
      const lines = [`## ${reviewerName}`, '', parsed.summary || '', ''];
      for (const f of fallbackFindings) {
        lines.push(`### ${severityEmoji(f.severity)} ${f.title} \`${f.path}:${f.line}\``);
        lines.push(f.body);
        if (f.suggestion) lines.push(`\n**Suggestion:** ${f.suggestion}`);
        lines.push('');
      }
      lines.push(COMMENT_MARKER);
      await postOrUpdateGeneralComment(octokit, owner, repo, pullNumber, lines.join('\n'));
    }
  } else {
    const lines = [`## ${reviewerName}`, ''];
    if (parsed.summary) lines.push(parsed.summary, '');
    for (const f of parsed.findings) {
      lines.push(`### ${severityEmoji(f.severity)} ${f.title} \`${f.path}:${f.line}\``);
      lines.push(f.body);
      if (f.suggestion) lines.push(`\n**Suggestion:** ${f.suggestion}`);
      lines.push('');
    }
    lines.push(COMMENT_MARKER);
    await postOrUpdateGeneralComment(octokit, owner, repo, pullNumber, lines.join('\n'));
  }
}

run().catch(err => core.setFailed(err.message));
