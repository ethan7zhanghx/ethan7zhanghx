import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const USERNAME = process.env.PROFILE_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || process.env.GITHUB_ACTOR;
const TOKEN = process.env.PROFILE_STATS_TOKEN || process.env.GITHUB_TOKEN;
const OUTPUT_DIR = process.env.PROFILE_OUTPUT_DIR || "assets/profile";
const INCLUDE_REPO_NAMES = process.env.PROFILE_INCLUDE_REPO_NAMES === "true";
const DAYS = 371;

if (!USERNAME) {
  throw new Error("Missing PROFILE_USERNAME, GITHUB_REPOSITORY_OWNER, or GITHUB_ACTOR.");
}

if (!TOKEN) {
  throw new Error("Missing PROFILE_STATS_TOKEN or GITHUB_TOKEN.");
}

const palette = {
  ink: "#111111",
  muted: "#696969",
  faint: "#ececec",
  paper: "#fbfbf8",
  panel: "#ffffff",
  line: "#dad7cf",
  hot: "#111111",
  warm: "#b9a77b",
  cool: "#557c83",
  blue: "#496b9c",
  green: "#6f8f72",
  rose: "#b56d72"
};

const now = new Date();
const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
const from = new Date(to);
from.setUTCDate(from.getUTCDate() - DAYS + 1);

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value || 0));
}

async function githubGraphql(query, variables = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "user-agent": "profile-metrics-wall"
    },
    body: JSON.stringify({ query, variables })
  });

  const body = await response.json();
  if (!response.ok || body.errors) {
    throw new Error(JSON.stringify(body.errors || body, null, 2));
  }
  return body.data;
}

async function githubRest(url) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "profile-metrics-wall"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return response;
}

async function githubRestJson(url) {
  const response = await githubRest(url);
  return response.json();
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function pagedJson(url, limitPages = 10) {
  const results = [];
  let next = url;
  let pages = 0;
  while (next && pages < limitPages) {
    const response = await githubRest(next);
    results.push(...(await response.json()));
    next = parseNextLink(response.headers.get("link"));
    pages += 1;
  }
  return results;
}

async function loadContributionCalendar() {
  const query = `
    query ProfileContributions($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                weekday
                contributionCount
              }
            }
          }
        }
      }
    }
  `;

  const data = await githubGraphql(query, {
    login: USERNAME,
    from: from.toISOString(),
    to: to.toISOString()
  });

  if (!data.user) throw new Error(`GitHub user not found: ${USERNAME}`);
  return data.user.contributionsCollection;
}

async function loadOwnedRepositories() {
  const url = "https://api.github.com/user/repos?per_page=100&visibility=all&affiliation=owner&sort=updated";
  const repos = await pagedJson(url, 3);
  return repos
    .filter((repo) => !repo.archived)
    .filter((repo) => repo.owner?.login?.toLowerCase() === USERNAME.toLowerCase())
    .map((repo) => ({
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      fork: repo.fork,
      stars: repo.stargazers_count || 0,
      forks: repo.forks_count || 0,
      pushedAt: repo.pushed_at,
      languagesUrl: repo.languages_url,
      commitsUrl: `https://api.github.com/repos/${repo.full_name}/commits`
    }));
}

async function loadRepositorySignals(repos) {
  const languages = new Map();
  const hourly = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const dailyCommits = new Map();
  let sampledCommits = 0;

  for (const repo of repos) {
    try {
      const repoLanguages = await githubRestJson(repo.languagesUrl);
      for (const [language, bytes] of Object.entries(repoLanguages)) {
        languages.set(language, (languages.get(language) || 0) + bytes);
      }
    } catch {
      // Some private or empty repositories may not expose language data to the token.
    }

    try {
      const commits = await pagedJson(
        `${repo.commitsUrl}?author=${encodeURIComponent(USERNAME)}&since=${encodeURIComponent(from.toISOString())}&per_page=100`,
        5
      );
      for (const commit of commits) {
        const dateText = commit.commit?.author?.date || commit.commit?.committer?.date;
        if (!dateText) continue;
        const date = new Date(dateText);
        const weekday = date.getUTCDay();
        const hour = date.getUTCHours();
        const dateKey = isoDate(date);
        dailyCommits.set(dateKey, (dailyCommits.get(dateKey) || 0) + 1);
        hourly[weekday][hour] += 1;
        sampledCommits += 1;
      }
    } catch {
      // Commit listing can fail for empty repositories or tokens without access.
    }
  }

  return {
    languages: [...languages.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, bytes]) => ({ name, bytes })),
    hourly,
    dailyCommits,
    sampledCommits
  };
}

function buildCommitDays(dailyCommits) {
  const days = [];
  const cursor = new Date(from);
  while (cursor <= to) {
    const date = isoDate(cursor);
    days.push({
      date,
      weekday: cursor.getUTCDay(),
      contributionCount: dailyCommits.get(date) || 0
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function maxCount(days) {
  return Math.max(1, ...days.map((day) => day.contributionCount));
}

function level(count, max) {
  if (count <= 0) return 0;
  return Math.max(1, Math.min(5, Math.ceil((count / max) * 5)));
}

function contributionColor(count, max) {
  const colors = ["#efeee9", "#d8d0bd", "#b9a77b", "#7f8b74", "#3f6f73", "#111111"];
  return colors[level(count, max)];
}

function monthLabels(days) {
  const labels = [];
  let seen = "";
  days.forEach((day, index) => {
    const month = day.date.slice(5, 7);
    if (month !== seen && new Date(`${day.date}T00:00:00Z`).getUTCDate() <= 7) {
      seen = month;
      labels.push({ index, label: new Date(`${day.date}T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" }) });
    }
  });
  return labels;
}

function streakStats(days) {
  let current = 0;
  let longest = 0;
  let activeDays = 0;
  for (const day of days) {
    if (day.contributionCount > 0) {
      activeDays += 1;
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  let trailing = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].contributionCount <= 0) break;
    trailing += 1;
  }

  return { activeDays, longest, current: trailing };
}

function svgFrame(width, height, title, subtitle, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <defs>
    <linearGradient id="paper" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#f5f3ed"/>
    </linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000000" flood-opacity="0.09"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" rx="0" fill="url(#paper)"/>
  <rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="18" fill="none" stroke="${palette.line}"/>
  <text x="48" y="64" fill="${palette.ink}" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="23" font-weight="650">${escapeXml(title)}</text>
  <text x="48" y="91" fill="${palette.muted}" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" letter-spacing="1.8">${escapeXml(subtitle)}</text>
  ${body}
</svg>`;
}

function renderStatsStrip(metrics) {
  const width = 1200;
  const height = 285;
  const cards = [
    ["total", metrics.totalContributions],
    ["commits", metrics.totalCommitContributions],
    ["commit days", metrics.commitActiveDays],
    ["longest streak", metrics.longestStreak],
    ["private", metrics.restrictedContributionsCount],
    ["prs/issues", metrics.totalPullRequestContributions + metrics.totalIssueContributions],
    ["reviews", metrics.totalPullRequestReviewContributions]
  ];

  const cardWidth = 250;
  const cardHeight = 48;
  const cardStepX = 270;
  const cardStepY = 66;
  const body = cards
    .map(([label, value], index) => {
      const row = index < 4 ? 0 : 1;
      const col = index < 4 ? index : index - 4;
      const rowOffset = row === 0 ? 48 : 183;
      const x = rowOffset + col * cardStepX;
      const y = 105 + row * cardStepY;
      return `<g transform="translate(${x} ${y})">
        <rect width="${cardWidth}" height="${cardHeight}" rx="9" fill="#fffefa" stroke="${palette.line}"/>
        <text x="14" y="20" fill="${palette.muted}" font-size="11" font-family="Inter, ui-sans-serif, system-ui" letter-spacing="1.2">${escapeXml(label.toUpperCase())}</text>
        <text x="14" y="40" fill="${palette.ink}" font-size="22" font-weight="700" font-family="Inter, ui-sans-serif, system-ui">${number(value)}</text>
      </g>`;
    })
    .join("");

  return svgFrame(width, height, "PRIVATE-AWARE ACTIVITY WALL", `PUBLIC + ACCESSIBLE PRIVATE AGGREGATES / UPDATED ${isoDate(now)}`, body);
}

function renderHeatmap(days) {
  const width = 1200;
  const height = 260;
  const max = maxCount(days);
  const cell = 14;
  const gap = 4;
  const startX = 78;
  const startY = 108;
  const weeks = [];

  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }

  const cells = weeks
    .map((week, weekIndex) =>
      week
        .map((day) => {
          const x = startX + weekIndex * (cell + gap);
          const y = startY + day.weekday * (cell + gap);
          return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${contributionColor(day.contributionCount, max)}"><title>${day.date}: ${day.contributionCount}</title></rect>`;
        })
        .join("")
    )
    .join("");

  const months = monthLabels(days)
    .map(({ index, label }) => `<text x="${startX + Math.floor(index / 7) * (cell + gap)}" y="101" fill="${palette.muted}" font-size="11" font-family="Inter, ui-sans-serif">${label}</text>`)
    .join("");

  const body = `${months}${cells}
    <text x="78" y="238" fill="${palette.muted}" font-size="12" font-family="Inter, ui-sans-serif">less</text>
    ${[0, 1, 2, 3, 4, 5].map((v) => `<rect x="${118 + v * 19}" y="226" width="14" height="14" rx="3" fill="${contributionColor(v, 5)}"/>`).join("")}
    <text x="244" y="238" fill="${palette.muted}" font-size="12" font-family="Inter, ui-sans-serif">more</text>`;

  return svgFrame(width, height, "PRIVATE-AWARE COMMIT HEATMAP", "ACCESSIBLE PRIVATE COMMITS ARE AGGREGATED, NOT IDENTIFIED", body);
}

function renderSkyline(days) {
  const width = 1200;
  const height = 430;
  const max = maxCount(days);
  const baseY = 356;
  const cell = 11;
  const gap = 4;
  const startX = 78;
  const startY = 118;

  const bars = days
    .map((day, index) => {
      const week = Math.floor(index / 7);
      const weekday = day.weekday;
      const x = startX + week * (cell + gap) + weekday * 1.1;
      const depth = weekday * 7;
      const h = day.contributionCount === 0 ? 3 : 8 + (day.contributionCount / max) * 156;
      const y = baseY - depth - h;
      const shade = contributionColor(day.contributionCount, max);
      return `<g opacity="${day.contributionCount === 0 ? 0.35 : 1}">
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell}" height="${h.toFixed(1)}" rx="2" fill="${shade}"/>
        <path d="M ${x.toFixed(1)} ${y.toFixed(1)} l 5 -5 h ${cell} l -5 5 z" fill="#ffffff" opacity="0.58"/>
        <path d="M ${(x + cell).toFixed(1)} ${y.toFixed(1)} l 5 -5 v ${h.toFixed(1)} l -5 5 z" fill="#000000" opacity="0.10"/>
        <title>${day.date}: ${day.contributionCount}</title>
      </g>`;
    })
    .join("");

  const body = `<line x1="68" y1="${baseY + 4}" x2="1132" y2="${baseY + 4}" stroke="${palette.line}"/>
    <g filter="url(#softShadow)">${bars}</g>
    <text x="78" y="390" fill="${palette.muted}" font-size="12" font-family="Inter, ui-sans-serif">365-day contribution skyline / higher towers mean denser days</text>`;

  return svgFrame(width, height, "3D COMMIT SKYLINE", "DAILY COMMIT DENSITY AS A DATA CITY", body);
}

function renderPulse(days) {
  const width = 1200;
  const height = 280;
  const max = maxCount(days);
  const startX = 68;
  const endX = 1132;
  const midY = 173;
  const amp = 74;
  const step = (endX - startX) / Math.max(1, days.length - 1);
  const points = days
    .map((day, index) => {
      const x = startX + index * step;
      const y = midY - (day.contributionCount / max) * amp;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const area = `${startX},${midY + 48} ${points} ${endX},${midY + 48}`;
  const body = `<polyline points="${area}" fill="#d8d0bd" opacity="0.35"/>
    <polyline points="${points}" fill="none" stroke="${palette.ink}" stroke-width="2.4" stroke-linejoin="round"/>
    <line x1="${startX}" y1="${midY}" x2="${endX}" y2="${midY}" stroke="${palette.line}" stroke-dasharray="4 8"/>
    ${monthLabels(days).map(({ index, label }) => {
      const x = startX + index * step;
      return `<line x1="${x.toFixed(1)}" y1="111" x2="${x.toFixed(1)}" y2="226" stroke="${palette.line}" opacity="0.5"/><text x="${x.toFixed(1)}" y="242" fill="${palette.muted}" font-size="11" font-family="Inter, ui-sans-serif">${label}</text>`;
    }).join("")}`;

  return svgFrame(width, height, "YEAR PULSE", "ANNUAL COMMIT WAVEFORM", body);
}

function renderRings(days) {
  const width = 900;
  const height = 900;
  const max = maxCount(days);
  const cx = 450;
  const cy = 470;
  const inner = 204;
  const outer = 348;
  const marks = days
    .map((day, index) => {
      const angle = (index / days.length) * Math.PI * 2 - Math.PI / 2;
      const strength = day.contributionCount / max;
      const r1 = inner;
      const r2 = inner + 18 + strength * (outer - inner - 18);
      const x1 = cx + Math.cos(angle) * r1;
      const y1 = cy + Math.sin(angle) * r1;
      const x2 = cx + Math.cos(angle) * r2;
      const y2 = cy + Math.sin(angle) * r2;
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${contributionColor(day.contributionCount, max)}" stroke-width="5" stroke-linecap="round"><title>${day.date}: ${day.contributionCount}</title></line>`;
    })
    .join("");

  const total = days.reduce((sum, day) => sum + day.contributionCount, 0);
  const body = `<circle cx="${cx}" cy="${cy}" r="${inner - 28}" fill="#fffefa" stroke="${palette.line}"/>
    <g>${marks}</g>
    <text x="${cx}" y="${cy - 14}" text-anchor="middle" fill="${palette.ink}" font-size="54" font-weight="750" font-family="Inter, ui-sans-serif">${number(total)}</text>
    <text x="${cx}" y="${cy + 22}" text-anchor="middle" fill="${palette.muted}" font-size="14" font-family="Inter, ui-sans-serif" letter-spacing="2">COMMITS</text>`;

  return svgFrame(width, height, "COMMIT RINGS", "365-DAY RADIAL COMMIT FIELD", body);
}

function renderWorkRhythm(hourly) {
  const width = 1200;
  const height = 420;
  const max = Math.max(1, ...hourly.flat());
  const startX = 102;
  const startY = 118;
  const cellW = 38;
  const cellH = 31;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const cells = hourly
    .map((row, day) =>
      row
        .map((count, hour) => {
          const x = startX + hour * (cellW + 4);
          const y = startY + day * (cellH + 5);
          const opacity = 0.1 + (count / max) * 0.9;
          return `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="6" fill="${palette.ink}" opacity="${opacity.toFixed(2)}"><title>${weekdays[day]} ${String(hour).padStart(2, "0")}:00 UTC: ${count}</title></rect>`;
        })
        .join("")
    )
    .join("");

  const labels = weekdays
    .map((label, index) => `<text x="62" y="${startY + index * (cellH + 5) + 20}" fill="${palette.muted}" font-size="12" font-family="Inter, ui-sans-serif">${label}</text>`)
    .join("");

  const hours = [0, 3, 6, 9, 12, 15, 18, 21]
    .map((hour) => `<text x="${startX + hour * (cellW + 4)}" y="108" fill="${palette.muted}" font-size="11" font-family="Inter, ui-sans-serif">${String(hour).padStart(2, "0")}</text>`)
    .join("");

  return svgFrame(width, height, "WORK RHYTHM", "COMMIT TIME DISTRIBUTION FROM ACCESSIBLE REPOSITORIES, UTC", `${labels}${hours}${cells}`);
}

function renderLanguageOrbit(languages) {
  const width = 1200;
  const height = 390;
  const total = Math.max(1, languages.reduce((sum, language) => sum + language.bytes, 0));
  const colors = [palette.ink, palette.cool, palette.warm, palette.blue, palette.green, palette.rose, "#8f8a83", "#c2b48d"];
  const cx = 600;
  const cy = 232;
  const bubbles = languages.map((language, index) => {
    const angle = (index / Math.max(1, languages.length)) * Math.PI * 2 - Math.PI / 2;
    const radius = index === 0 ? 0 : 102 + (index % 3) * 34;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    const size = 32 + Math.sqrt(language.bytes / total) * 128;
    const percent = ((language.bytes / total) * 100).toFixed(1);
    return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
      <circle r="${size.toFixed(1)}" fill="${colors[index % colors.length]}" opacity="${index === 0 ? 0.96 : 0.78}"/>
      <text y="-3" text-anchor="middle" fill="#ffffff" font-size="${Math.max(11, Math.min(18, size / 4)).toFixed(0)}" font-weight="700" font-family="Inter, ui-sans-serif">${escapeXml(language.name)}</text>
      <text y="16" text-anchor="middle" fill="#ffffff" opacity="0.82" font-size="11" font-family="Inter, ui-sans-serif">${percent}%</text>
    </g>`;
  }).join("");

  const body = `<circle cx="${cx}" cy="${cy}" r="172" fill="none" stroke="${palette.line}" stroke-dasharray="3 9"/>
    <circle cx="${cx}" cy="${cy}" r="112" fill="none" stroke="${palette.line}" stroke-dasharray="3 9"/>
    ${bubbles || `<text x="${cx}" y="${cy}" text-anchor="middle" fill="${palette.muted}" font-size="16" font-family="Inter, ui-sans-serif">No language data available</text>`}`;

  return svgFrame(width, height, "LANGUAGE ORBIT", "AGGREGATED LANGUAGE BYTES FROM ACCESSIBLE REPOSITORIES", body);
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const contributions = await loadContributionCalendar();
  const repos = await loadOwnedRepositories();
  const signals = await loadRepositorySignals(repos);
  const commitDays = buildCommitDays(signals.dailyCommits);
  const streak = streakStats(commitDays);

  const metrics = {
    username: USERNAME,
    updatedAt: now.toISOString(),
    range: { from: isoDate(from), to: isoDate(to) },
    totalContributions: contributions.contributionCalendar.totalContributions,
    totalCommitContributions: contributions.totalCommitContributions,
    totalIssueContributions: contributions.totalIssueContributions,
    totalPullRequestContributions: contributions.totalPullRequestContributions,
    totalPullRequestReviewContributions: contributions.totalPullRequestReviewContributions,
    restrictedContributionsCount: contributions.restrictedContributionsCount,
    commitActiveDays: streak.activeDays,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    accessibleRepositories: repos.length,
    sampledCommits: signals.sampledCommits,
    languages: signals.languages,
    repositories: INCLUDE_REPO_NAMES
      ? repos.map((repo) => ({ name: repo.name, private: repo.private, fork: repo.fork, stars: repo.stars, forks: repo.forks }))
      : undefined
  };

  const files = {
    "stats-strip.svg": renderStatsStrip(metrics),
    "contribution-heatmap.svg": renderHeatmap(commitDays),
    "contribution-skyline.svg": renderSkyline(commitDays),
    "year-pulse.svg": renderPulse(commitDays),
    "contribution-rings.svg": renderRings(commitDays),
    "work-rhythm.svg": renderWorkRhythm(signals.hourly),
    "language-orbit.svg": renderLanguageOrbit(signals.languages),
    "metrics.json": `${JSON.stringify(metrics, null, 2)}\n`
  };

  await Promise.all(
    Object.entries(files).map(([filename, content]) => writeFile(path.join(OUTPUT_DIR, filename), content, "utf8"))
  );

  console.log(`Generated ${Object.keys(files).length} profile assets for ${USERNAME}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
