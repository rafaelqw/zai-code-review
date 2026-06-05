const core = require('@actions/core');
const github = require('@actions/github');
const https = require('https');

const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
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
      owner, repo, pull_number: pullNumber, per_page: 100, page,
    });
    files.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return files;
}

async function getPRCommits(octokit, owner, repo, pullNumber) {
  const commits = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listCommits({
      owner, repo, pull_number: pullNumber, per_page: 100, page,
    });
    commits.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return commits.map(c => c.commit.message.split('\n')[0]);
}

async function getFileContent(octokit, owner, repo, path, ref) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (data.type !== 'file' || !data.content) return null;
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (err) {
    if (err.status === 403) core.warning(`No permission to read file contents. Add "contents: read" to your workflow permissions.`);
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

function buildPrompt(prContext, changedFiles, commits, instructionFiles, maxDiffChars) {
  const { title, body, author, baseRef, headRef } = prContext;
  const sections = [];

  sections.push(
    `## Pull Request to Document\n**Title:** ${title}\n**Author:** ${author}\n**Branch:** \`${headRef}\` → \`${baseRef}\`` +
    (body ? `\n\n**Current description (may be empty or incomplete):**\n${body}` : '')
  );

  if (commits.length > 0) {
    sections.push(`## Commit Messages\n${commits.map(m => `- ${m}`).join('\n')}`);
  }

  const fileList = changedFiles.map(f => `- \`${f.filename}\` (${f.status})`).join('\n');
  sections.push(`## Changed Files\n${fileList}`);

  if (instructionFiles.length > 0) {
    const instrContent = instructionFiles
      .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
      .join('\n\n');
    sections.push(`## Project Context\n${instrContent}`);
  }

  const patchable = changedFiles.filter(f => f.patch);
  const diffs = [];
  let totalChars = 0;
  const skipped = [];
  for (const f of patchable) {
    const entry = `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``;
    if (maxDiffChars > 0 && totalChars + entry.length > maxDiffChars) {
      skipped.push(f.filename);
    } else {
      diffs.push(entry);
      totalChars += entry.length;
    }
  }
  let diffsSection = diffs.join('\n\n');
  if (skipped.length > 0) {
    diffsSection += `\n\n> **Note:** ${skipped.length} file(s) omitted due to MAX_DIFF_CHARS limit.`;
  }
  sections.push(`## Code Changes\n${diffsSection}`);

  sections.push(`## Instructions
Generate a clear and specific pull request description in markdown based on the changes above.

Include exactly these sections:
- **O que foi feito**: What was implemented or changed and why (2-4 sentences, be specific)
- **Principais mudanças**: Bullet list of the most significant changes (reference specific classes, endpoints, or files)
- **Como testar**: Concrete steps to validate the changes work correctly
- **Breaking changes**: Any breaking changes introduced, or "Nenhuma" if none

Rules:
- Write in the same language used in the project (check class names, comments, and commit messages for cues)
- Be factual — describe what actually changed, not generic statements like "improves quality"
- Reference specific classes, methods, or endpoints when relevant
- Do NOT repeat the PR title verbatim in the description
- If there is already a description, improve it — do not ignore its content

Respond with ONLY the markdown description. No preamble, no commentary.`);

  return sections.join('\n\n');
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
        if (data.length > MAX_RESPONSE_SIZE) req.destroy(new Error('Z.ai API response exceeded size limit.'));
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let parsed;
          try { parsed = JSON.parse(data); } catch {
            reject(new Error('Z.ai API returned invalid JSON.')); return;
          }
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) reject(new Error('Z.ai API returned an empty response.'));
          else resolve(content);
        } else {
          reject(new Error(`Z.ai API error ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Z.ai API request timed out.')));
    req.write(body);
    req.end();
  });
}

async function run() {
  const apiKey = core.getInput('ZAI_API_KEY', { required: true });
  core.setSecret(apiKey);
  const model = core.getInput('ZAI_MODEL');
  const systemPrompt = core.getInput('ZAI_SYSTEM_PROMPT') ||
    'You are a technical writer who generates pull request descriptions. Write clearly and specifically about what changed and why, using the same language conventions as the project.';
  const token = core.getInput('GITHUB_TOKEN');
  core.setSecret(token);

  const excludePatterns = core.getInput('EXCLUDE_PATTERNS')
    .split(',').map(p => p.trim()).filter(Boolean);
  const maxDiffChars = parseInt(core.getInput('MAX_DIFF_CHARS'), 10) || 0;
  const minDescriptionLength = parseInt(core.getInput('MIN_DESCRIPTION_LENGTH'), 10) || 50;
  const overwriteExisting = core.getInput('OVERWRITE_EXISTING') === 'true';
  const includeProjectInstructions = core.getInput('INCLUDE_PROJECT_INSTRUCTIONS') !== 'false';
  const projectInstructionFiles = core.getInput('PROJECT_INSTRUCTION_FILES')
    .split(',').map(p => p.trim()).filter(Boolean);
  const trustedInstructionsRef = core.getInput('TRUSTED_INSTRUCTIONS_REF') || 'base';

  const { context } = github;
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  const pullNumber = pr?.number;

  if (!pullNumber) {
    core.setFailed('This action only runs on pull_request events.');
    return;
  }

  const currentBody = pr.body || '';
  if (!overwriteExisting && currentBody.trim().length >= minDescriptionLength) {
    core.info(`PR already has a description (${currentBody.trim().length} chars). Skipping. Set OVERWRITE_EXISTING=true to regenerate.`);
    return;
  }

  const prContext = {
    title: pr.title || '',
    body: currentBody,
    author: pr.user?.login || '',
    baseRef: pr.base?.ref || '',
    headRef: pr.head?.ref || '',
    baseSha: pr.base?.sha || '',
  };

  const octokit = github.getOctokit(token);

  core.info(`Fetching changed files for PR #${pullNumber}...`);
  const files = await getChangedFiles(octokit, owner, repo, pullNumber);
  const filteredFiles = filterFiles(files, excludePatterns);

  core.info(`Fetching commit messages...`);
  const commits = await getPRCommits(octokit, owner, repo, pullNumber);
  core.info(`Found ${commits.length} commit(s).`);

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

  const prompt = buildPrompt(prContext, filteredFiles, commits, instructionFiles, maxDiffChars);

  core.info('Generating PR description...');
  const description = await callZaiApi(apiKey, model, systemPrompt, prompt);

  await octokit.rest.pulls.update({
    owner, repo, pull_number: pullNumber, body: description,
  });

  core.info('PR description updated successfully.');
}

run().catch(err => core.setFailed(err.message));
