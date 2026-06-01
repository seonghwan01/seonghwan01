import fs from 'node:fs/promises';
import path from 'node:path';

const token = process.env.GITHUB_TOKEN;
const username = process.env.USERNAME || process.env.GITHUB_REPOSITORY_OWNER;
const aliases = (process.env.AUTHOR_ALIASES || username || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const outputPath =
  process.env.OUTPUT_PATH ||
  path.join('profile-3d-contrib', 'profile-commit-languages.svg');

if (!token) {
  throw new Error('GITHUB_TOKEN is required.');
}

if (!username) {
  throw new Error('USERNAME or GITHUB_REPOSITORY_OWNER is required.');
}

const now = new Date();
const until = now.toISOString();
const fromDate = new Date(now);
fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 1);
const since = fromDate.toISOString();

const languageByExtension = new Map(
  Object.entries({
    '.java': ['Java', '#b07219'],
    '.kt': ['Kotlin', '#A97BFF'],
    '.kts': ['Kotlin', '#A97BFF'],
    '.ts': ['TypeScript', '#3178c6'],
    '.tsx': ['TypeScript', '#3178c6'],
    '.js': ['JavaScript', '#f1e05a'],
    '.jsx': ['JavaScript', '#f1e05a'],
    '.vue': ['Vue', '#41b883'],
    '.py': ['Python', '#3572A5'],
    '.sql': ['SQL', '#e38c00'],
    '.xml': ['XML', '#0060ac'],
    '.yml': ['YAML', '#cb171e'],
    '.yaml': ['YAML', '#cb171e'],
    '.json': ['JSON', '#292929'],
    '.md': ['Markdown', '#083fa1'],
    '.css': ['CSS', '#563d7c'],
    '.scss': ['SCSS', '#c6538c'],
    '.html': ['HTML', '#e34c26'],
    '.sh': ['Shell', '#89e051'],
    '.bat': ['Batchfile', '#C1F12E'],
    '.ps1': ['PowerShell', '#012456'],
    '.gradle': ['Gradle', '#02303a'],
    '.dockerfile': ['Dockerfile', '#384d54'],
  }),
);

const sourceLanguages = new Set([
  'Java',
  'Kotlin',
  'TypeScript',
  'JavaScript',
  'Vue',
  'Python',
  'SQL',
  'CSS',
  'SCSS',
  'HTML',
  'Shell',
  'Batchfile',
  'PowerShell',
  'Gradle',
  'Dockerfile',
]);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function languageFor(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('dockerfile') || lower.includes('/dockerfile')) {
    return ['Dockerfile', '#384d54'];
  }
  return languageByExtension.get(path.extname(lower)) || ['Other', '#444444'];
}

async function githubFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }

  return response;
}

async function githubJson(url, options) {
  const response = await githubFetch(url, options);
  return response.json();
}

async function graphql(query, variables) {
  const response = await githubJson('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ query, variables }),
  });

  if (response.errors?.length) {
    throw new Error(response.errors.map((error) => error.message).join('\n'));
  }

  return response.data;
}

async function contributionRepositories() {
  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          commitContributionsByRepository(maxRepositories: 100) {
            repository {
              nameWithOwner
              isPrivate
            }
            contributions {
              totalCount
            }
          }
        }
      }
    }
  `;
  const data = await graphql(query, { login: username, from: since, to: until });
  return data.user.contributionsCollection.commitContributionsByRepository
    .map((entry) => entry.repository.nameWithOwner)
    .sort((left, right) => left.localeCompare(right));
}

function parseLinkHeader(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function paginatedJson(url) {
  const items = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await githubFetch(nextUrl);
    items.push(...(await response.json()));
    nextUrl = parseLinkHeader(response.headers.get('link'));
  }

  return items;
}

async function commitsForRepository(nameWithOwner) {
  const commits = new Map();

  for (const alias of aliases) {
    const url = new URL(`https://api.github.com/repos/${nameWithOwner}/commits`);
    url.searchParams.set('author', alias);
    url.searchParams.set('since', since);
    url.searchParams.set('until', until);
    url.searchParams.set('per_page', '100');

    try {
      for (const commit of await paginatedJson(url.toString())) {
        commits.set(commit.sha, commit);
      }
    } catch (error) {
      console.warn(`Skipping ${nameWithOwner} for ${alias}: ${error.message}`);
    }
  }

  return [...commits.values()];
}

async function collectLanguageStats() {
  const stats = new Map();
  const repositories = await contributionRepositories();
  let commitCount = 0;
  let codeCommitCount = 0;

  for (const repository of repositories) {
    const commits = await commitsForRepository(repository);
    commitCount += commits.length;

    for (const commit of commits) {
      const detail = await githubJson(
        `https://api.github.com/repos/${repository}/commits/${commit.sha}`,
      );

      const commitLanguages = new Map();

      for (const file of detail.files || []) {
        const [language, color] = languageFor(file.filename);
        if (!sourceLanguages.has(language)) continue;

        const changes = Number(file.changes || 0);
        if (!changes) continue;

        const current =
          commitLanguages.get(language) || { language, color, changes: 0, files: 0 };
        current.changes += changes;
        current.files += 1;
        commitLanguages.set(language, current);
      }

      const primaryLanguage = [...commitLanguages.values()].sort(
        (a, b) => b.changes - a.changes,
      )[0];

      if (!primaryLanguage) continue;

      codeCommitCount += 1;
      const current =
        stats.get(primaryLanguage.language) || {
          language: primaryLanguage.language,
          color: primaryLanguage.color,
          commits: 0,
          changes: 0,
          files: 0,
        };
      current.commits += 1;
      current.changes += primaryLanguage.changes;
      current.files += primaryLanguage.files;
      stats.set(primaryLanguage.language, current);
    }
  }

  return {
    commitCount,
    codeCommitCount,
    repositories: repositories.length,
    languages: [...stats.values()].sort((a, b) => b.commits - a.commits),
  };
}

function polarToCartesian(cx, cy, radius, angle) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

function donutSegment(cx, cy, outerRadius, innerRadius, startAngle, endAngle) {
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
  const outerStart = polarToCartesian(cx, cy, outerRadius, endAngle);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, startAngle);
  const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);
  const innerEnd = polarToCartesian(cx, cy, innerRadius, endAngle);

  return [
    `M ${outerStart.x.toFixed(3)} ${outerStart.y.toFixed(3)}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 0 ${outerEnd.x.toFixed(3)} ${outerEnd.y.toFixed(3)}`,
    `L ${innerStart.x.toFixed(3)} ${innerStart.y.toFixed(3)}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 1 ${innerEnd.x.toFixed(3)} ${innerEnd.y.toFixed(3)}`,
    'Z',
  ].join(' ');
}

function compactLanguages(languages) {
  const top = languages.slice(0, 5);
  const rest = languages.slice(5);
  const otherCommits = rest.reduce((sum, language) => sum + language.commits, 0);
  if (otherCommits > 0) {
    const existingOther = top.find((language) => language.language === 'Other');
    if (existingOther) {
      existingOther.commits += otherCommits;
      existingOther.changes += rest.reduce((sum, language) => sum + language.changes, 0);
      existingOther.files += rest.reduce((sum, language) => sum + language.files, 0);
    } else {
      top.push({
        language: 'Other',
        color: '#444444',
        commits: otherCommits,
        changes: rest.reduce((sum, language) => sum + language.changes, 0),
        files: rest.reduce((sum, language) => sum + language.files, 0),
      });
    }
  }
  return top;
}

function renderSvg({ commitCount, codeCommitCount, repositories, languages }) {
  const width = 760;
  const height = 300;
  const cx = 158;
  const cy = 158;
  const outerRadius = 102;
  const innerRadius = 58;
  const visibleLanguages = compactLanguages(languages);
  const totalCommits =
    visibleLanguages.reduce((sum, language) => sum + language.commits, 0) || 1;
  let angle = 0;

  const segments = visibleLanguages
    .map((language) => {
      const sweep = (language.commits / totalCommits) * 360;
      const start = angle;
      const end = angle + sweep;
      angle = end;
      return `<path d="${donutSegment(cx, cy, outerRadius, innerRadius, start, end)}" fill="${language.color}" stroke="#ffffff" stroke-width="2"><title>${escapeHtml(language.language)} ${language.commits} code commits</title></path>`;
    })
    .join('\n');

  const legend = visibleLanguages
    .map((language, index) => {
      const y = 102 + index * 29;
      const percent = ((language.commits / totalCommits) * 100).toFixed(1);
      return `
        <g transform="translate(330 ${y})">
          <rect width="16" height="16" rx="3" fill="${language.color}" />
          <text x="26" y="13" class="legend-name">${escapeHtml(language.language)}</text>
          <text x="278" y="13" class="legend-value">${percent}%</text>
          <text x="360" y="13" class="legend-muted">${language.commits.toLocaleString('en-US')} commits</text>
        </g>`;
    })
    .join('\n');

  const dateLabel = `${since.slice(0, 10)} / ${until.slice(0, 10)}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Commit language distribution</title>
  <desc id="desc">Languages calculated from source files changed in commits authored by ${escapeHtml(username)}.</desc>
  <style>
    * { box-sizing: border-box; }
    text { font-family: "Segoe UI", "Noto Sans KR", Arial, sans-serif; fill: #1f2937; }
    .title { font-size: 24px; font-weight: 700; }
    .subtitle { font-size: 13px; fill: #667085; }
    .metric { font-size: 22px; font-weight: 700; }
    .metric-label { font-size: 12px; fill: #667085; }
    .legend-name { font-size: 15px; font-weight: 600; }
    .legend-value { font-size: 14px; font-weight: 700; text-anchor: end; }
    .legend-muted { font-size: 12px; fill: #667085; }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="#ffffff" stroke="#d0d7de" />
  <text x="32" y="42" class="title">Commit Languages</text>
  <text x="32" y="64" class="subtitle">Dominant source language per commit authored by @${escapeHtml(username)}</text>
  <text x="${width - 28}" y="42" class="subtitle" text-anchor="end">${dateLabel}</text>
  <g>
    ${segments}
    <circle cx="${cx}" cy="${cy}" r="${innerRadius - 2}" fill="#ffffff" />
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="metric">${codeCommitCount.toLocaleString('en-US')}</text>
    <text x="${cx}" y="${cy + 17}" text-anchor="middle" class="metric-label">code commits</text>
  </g>
  ${legend}
  <g transform="translate(330 254)">
    <text class="metric">${commitCount.toLocaleString('en-US')}</text>
    <text x="62" y="0" class="metric-label">authored commits scanned</text>
    <text x="238" y="0" class="metric">${repositories.toLocaleString('en-US')}</text>
    <text x="276" y="0" class="metric-label">repos</text>
  </g>
</svg>
`;
}

const result = await collectLanguageStats();
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, renderSvg(result), 'utf8');

console.log(
  `Generated ${outputPath}: ${result.commitCount} commits, ${result.repositories} repositories`,
);
