// Generates profile/stats.svg from your real GitHub contributions.
// Runs every day in .github/workflows/update-profile.yml
// Uses only Node's built-in modules: no npm install needed.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GLYPHS = JSON.parse(readFileSync(`${here}/glyphs.json`, "utf8"));

const LOGIN = process.env.GH_LOGIN || process.env.GITHUB_REPOSITORY_OWNER;
const TOKEN = process.env.GITHUB_TOKEN;
const GOAL = Number(process.env.YEARLY_GOAL || 365);
const OUTPUT = process.env.OUTPUT || "profile/stats.svg";

// ---------------- palette (same as the other cards) ----------------
const C = {
  bg0: "#020C07", bg1: "#05170F", bg2: "#0A2B1E", tile: "#0B2A1D",
  line: "#163D2D", line2: "#1F5136", g500: "#22C55E", g400: "#4ADE80",
  g300: "#86EFAC", white: "#FFFFFF", muted: "#A7C4B5", dim: "#6E9C86",
};
const LEVELS = ["#14382A", "#14532D", "#16A34A", "#22C55E", "#4ADE80"];

// ---------------- data ----------------
async function fetchDays() {
  if (process.env.MOCK) return mockDays();
  if (!TOKEN || !LOGIN) throw new Error("GITHUB_TOKEN and the user login are required");
  const now = new Date();
  const from = `${now.getUTCFullYear()}-01-01T00:00:00Z`;
  const query = `query($login:String!,$from:DateTime!,$to:DateTime!){
    user(login:$login){
      year: contributionsCollection(from:$from,to:$to){ contributionCalendar{ totalContributions } }
      last: contributionsCollection{ contributionCalendar{ weeks{ contributionDays{ date contributionCount } } } }
    }
  }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-card",
    },
    body: JSON.stringify({ query, variables: { login: LOGIN, from, to: now.toISOString() } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  const u = json.data.user;
  const weeks = u.last.contributionCalendar.weeks.map((w) => w.contributionDays);
  return { yearTotal: u.year.contributionCalendar.totalContributions, weeks };
}

function mockDays() {
  // Fake data shaped like the real API, used only to preview the card locally.
  const weeks = [];
  const start = new Date(Date.UTC(2025, 10, 23));
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  let yearTotal = 0;
  for (let w = 0; w < 53; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getTime() + (w * 7 + d) * 864e5);
      const active = date >= new Date(Date.UTC(2026, 8, 1)) && rnd() > 0.45;
      const count = active ? 1 + Math.floor(rnd() * 4) : 0;
      if (date.getUTCFullYear() === 2026) yearTotal += count;
      days.push({ date: date.toISOString().slice(0, 10), contributionCount: count });
    }
    weeks.push(days);
  }
  return { yearTotal, weeks };
}

function computeStats({ yearTotal, weeks }) {
  const days = weeks.flat().sort((a, b) => a.date.localeCompare(b.date));
  // current streak: today may not have contributions yet, so it doesn't break the streak
  let i = days.length - 1;
  if (i >= 0 && days[i].contributionCount === 0) i--;
  let current = 0;
  for (; i >= 0 && days[i].contributionCount > 0; i--) current++;
  let longest = 0, run = 0, active = 0;
  for (const d of days) {
    if (d.contributionCount > 0) { run++; active++; longest = Math.max(longest, run); }
    else run = 0;
  }
  const weekly = weeks.slice(-52).map((w) => w.reduce((s, d) => s + d.contributionCount, 0));
  return { yearTotal, current, longest, active, weekly };
}

// ---------------- text as glyph paths (renders the same everywhere) ----------------
const used = new Map();
function gid(fontKey, ch) {
  const k = `${fontKey}|${ch}`;
  if (!used.has(k)) used.set(k, `s${used.size.toString(36)}`);
  return used.get(k);
}
function measure(text, fontKey, size, ls = 0) {
  const f = GLYPHS[fontKey];
  const s = size / f.upem;
  let x = 0, prev = null;
  const items = [];
  for (const ch of text) {
    const g = f.glyphs[ch];
    if (!g) continue;
    if (prev) x += (f.kern[prev + ch] || 0) * s;
    items.push({ ch, x });
    x += g.a * s + ls;
    prev = ch;
  }
  return { items, width: items.length ? x - ls : 0 };
}
function text(str, fontKey, size, x, y, fill, { anchor = "start", ls = 0, attrs = "" } = {}) {
  const { items, width } = measure(str, fontKey, size, ls);
  const f = GLYPHS[fontKey];
  const s = size / f.upem;
  const x0 = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
  const uses = items
    .filter((it) => it.ch !== " ")
    .map((it) => `<use xlink:href="#${gid(fontKey, it.ch)}" transform="translate(${(x0 + it.x).toFixed(1)} ${y}) scale(${s.toFixed(5)} ${(-s).toFixed(5)})"/>`)
    .join("");
  return { svg: `<g fill="${fill}"${attrs}>${uses}</g>`, width };
}
function glyphDefs() {
  return [...used.entries()]
    .map(([k, id]) => {
      const [fontKey, ch] = k.split("|");
      return `<path id="${id}" d="${GLYPHS[fontKey].glyphs[ch].d}"/>`;
    })
    .join("\n");
}


// Animations start at t=0, so the card still shows everything if a viewer doesn't animate SVGs.
function fadeIn(begin, dur) {
  const total = begin + dur;
  return `<animate attributeName="opacity" values="0;0;1" keyTimes="0;${(begin / total).toFixed(4)};1" dur="${total.toFixed(2)}s" begin="0s" fill="freeze"/>`;
}
function grow(attr, from, to, begin, dur) {
  const total = begin + dur;
  return `<animate attributeName="${attr}" values="${from.toFixed(1)};${from.toFixed(1)};${to.toFixed(1)}" keyTimes="0;${(begin / total).toFixed(4)};1" dur="${total.toFixed(2)}s" begin="0s" fill="freeze"/>`;
}

// ---------------- card ----------------
function render(st) {
  const W = 1280, H = 440, P = 48;
  const year = new Date().getUTCFullYear();
  const fmt = (n) => n.toLocaleString("en-US");
  const out = [];

  out.push(`<rect width="${W}" height="${H}" rx="28" fill="url(#bg)"/>`);
  out.push(`<rect width="${W}" height="${H}" rx="28" fill="url(#grid)"/>`);
  out.push(`<ellipse cx="${W * 0.85}" cy="0" rx="560" ry="420" fill="url(#glow)" opacity=".85"><animate attributeName="opacity" values=".7;1;.7" dur="7s" repeatCount="indefinite"/></ellipse>`);
  out.push(`<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="28" fill="none" stroke="${C.line}"/>`);

  out.push(text("ACTIVITY · LAST 12 MONTHS", "mono-b", 13, P, 60, C.g300, { ls: 2 }).svg);
  const updated = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Bogota" });
  out.push(text(`Updated ${updated}`, "inter-m", 14, W - P, 60, C.dim, { anchor: "end" }).svg);

  // stat tiles
  const tiles = [
    [fmt(st.yearTotal), "", `Contributions in ${year}`],
    [fmt(st.current), st.current === 1 ? "day" : "days", "Current streak"],
    [fmt(st.longest), st.longest === 1 ? "day" : "days", "Longest streak"],
    [fmt(st.active), "", "Active days"],
  ];
  const gap = 20, tw = (W - 2 * P - 3 * gap) / 4, ty = 84, th = 128;
  tiles.forEach(([num, unit, label], i) => {
    const x = P + i * (tw + gap);
    out.push(`<g>${fadeIn(0.15 + i * 0.12, 0.5)}`);
    out.push(`<rect x="${x.toFixed(1)}" y="${ty}" width="${tw.toFixed(1)}" height="${th}" rx="18" fill="${C.tile}" stroke="${C.line2}"/>`);
    const n = text(num, "display-b", 52, x + 26, ty + 72, C.white);
    out.push(n.svg);
    if (unit) out.push(text(unit, "display-b", 22, x + 26 + n.width + 8, ty + 72, C.g400).svg);
    out.push(text(label, "inter-m", 15, x + 26, ty + 104, C.muted).svg);
    out.push(`</g>`);
  });

  // weekly bars
  const by = 252;
  out.push(text("Weekly contributions", "inter-m", 15, P, by, C.dim).svg);
  const bars = st.weekly;
  const max = Math.max(1, ...bars);
  const bg = 6, bw = (W - 2 * P - (bars.length - 1) * bg) / bars.length, base = by + 88, maxH = 64;
  bars.forEach((v, i) => {
    const h = v ? Math.max(6, (v / max) * maxH) : 4;
    const lvl = v === 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.99));
    const x = P + i * (bw + bg);
    out.push(`<rect x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${LEVELS[lvl]}">${grow("height", 0, h, 0.4 + i * 0.015, 0.5)}${grow("y", base, base - h, 0.4 + i * 0.015, 0.5)}</rect>`);
  });

  // yearly goal
  const gy = 384;
  const pct = Math.min(1, st.yearTotal / GOAL);
  out.push(text(`${year} goal · ${fmt(GOAL)} contributions`, "inter-m", 15, P, gy, C.white).svg);
  out.push(text(`${fmt(st.yearTotal)} / ${fmt(GOAL)}  ·  ${Math.round(pct * 100)}%`, "inter-m", 15, W - P, gy, C.g300, { anchor: "end" }).svg);
  const trackW = W - 2 * P, fillW = Math.max(12, trackW * pct);
  out.push(`<rect x="${P}" y="${gy + 14}" width="${trackW}" height="12" rx="6" fill="#0E3324"/>`);
  out.push(`<rect x="${P}" y="${gy + 14}" width="${fillW.toFixed(1)}" height="12" rx="6" fill="url(#bar)">${grow("width", 0, fillW, 0.6, 1.4)}</rect>`);

  const body = out.join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t">
<title id="t">${st.yearTotal} contributions in ${year}, current streak ${st.current} days, longest streak ${st.longest} days, ${st.active} active days</title>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bg0}"/><stop offset=".55" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg2}"/></linearGradient>
<pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#FFFFFF" stroke-opacity=".045"/></pattern>
<radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${C.g500}" stop-opacity=".42"/><stop offset=".45" stop-color="${C.g500}" stop-opacity=".14"/><stop offset="1" stop-color="${C.g500}" stop-opacity="0"/></radialGradient>
<linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.g500}"/><stop offset="1" stop-color="${C.g300}"/></linearGradient>
<clipPath id="clip"><rect width="${W}" height="${H}" rx="28"/></clipPath>
${glyphDefs()}
</defs>
<g clip-path="url(#clip)">
${body}
</g>
</svg>
`;
}

const stats = computeStats(await fetchDays());
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, render(stats));
console.log(`Wrote ${OUTPUT}:`, stats);
