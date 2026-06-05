const core = require('@actions/core');
const github = require('@actions/github');
const https = require('https');

const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const COMMENT_MARKER = '<!-- zai-code-review -->';
const MAX_RESPONSE_SIZE = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 300_000;

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

function buildPrompt(prContext, changedFiles, instructionFiles, maxDiffChars, minConfidence) {
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

  sections.push(`## Review Instructions
You are performing a high-signal code review. Your goal is to find real issues, not to be thorough for its own sake.

**Report ONLY:**
- Real bugs and logic errors that will cause incorrect behavior
- Compilation errors, type errors, or import errors
- Clear security vulnerabilities (injection, auth bypass, data exposure, etc.)
- Explicit violations of the project instructions listed above

**DO NOT report:**
- Style issues, naming preferences, or formatting
- Nitpicks or subjective improvements
- Pre-existing issues not introduced by this PR
- Issues that a linter or type checker would catch automatically
- Speculative or uncertain findings

**Confidence requirement:** Only include findings with confidence >= ${minConfidence}%.

Respond with ONLY valid JSON (no markdown fences, no explanation) in this exact schema:
{
  "summary": "Brief overall summary of the review",
  "findings": [
    {
      "path": "path/to/file.js",
      "line": 42,
      "severity": "critical|high|medium|low",
      "confidence": 90,
      "title": "Short title of the issue",
      "body": "Detailed explanation of the issue",
      "suggestion": "Optional code or fix suggestion"
    }
  ]
}`);

  return sections.join('\n\n');
}

function parseReviewResponse(responseText, minConfidence) {
  let jsonText = responseText.trim();

  const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) jsonText = codeBlockMatch[1].trim();

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

  const prompt = buildPrompt(prContext, filteredFiles, instructionFiles, maxDiffChars, minConfidence);

  core.info(`Sending ${filteredFiles.length} file(s) to Z.ai for review...`);
  const rawResponse = await callZaiApi(apiKey, model, systemPrompt, prompt);

  const parsed = parseReviewResponse(rawResponse, minConfidence);

  if (!parsed) {
    core.warning('Could not parse JSON response from Z.ai. Falling back to raw response.');
    const fallbackBody = `## ${reviewerName}\n\n${rawResponse}\n\n${COMMENT_MARKER}`;
    await postOrUpdateGeneralComment(octokit, owner, repo, pullNumber, fallbackBody);
    return;
  }

  core.info(`Parsed ${parsed.findings.length} finding(s) with confidence >= ${minConfidence}%.`);

  if (parsed.findings.length === 0) {
    const noIssuesBody = `## ${reviewerName}\n\nNo high-confidence issues found. Checked for bugs and project-instruction compliance.\n\n${COMMENT_MARKER}`;
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
