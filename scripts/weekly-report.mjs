// Weekly website analytics digest -> emailed to David via Resend.
//
// Pulls the last 7 days from Cloudflare Web Analytics (the free, cookieless RUM
// product) through Cloudflare's GraphQL Analytics API, formats a compact digest,
// and sends it with Resend (the same service the contact form already uses).
//
// Runs on a schedule from .github/workflows/weekly-analytics.yml. Nothing here is
// secret - all config comes from environment variables (GitHub Actions secrets):
//
//   CF_API_TOKEN            (required) Cloudflare API token, permission:
//                                      Account > Account Analytics > Read
//   CF_ACCOUNT_ID           (required) Cloudflare account ID
//   CF_WEB_ANALYTICS_SITE_TAG (optional) the Web Analytics "site tag". Only needed
//                                      if the account has more than one Web Analytics
//                                      site; with a single site (davidgoodloe.ai) the
//                                      account filter alone already scopes the data.
//   RESEND_API_KEY          (required) same key the contact form uses
//   REPORT_TO               (required) inbox to receive the digest
//   REPORT_FROM             (optional) verified Resend sender; defaults to Resend's
//                                      shared onboarding sender until a domain is verified
//   SITE_LABEL              (optional) display name in the email (default davidgoodloe.ai)
//   DRY_RUN                 (optional) if set (not "" / "0" / "false"), print the report
//                                      to stdout instead of emailing it - for testing.
//
// Run locally with those vars set: `node scripts/weekly-report.mjs`

const {
  CF_API_TOKEN,
  CF_ACCOUNT_ID,
  CF_WEB_ANALYTICS_SITE_TAG,
  RESEND_API_KEY,
  REPORT_TO,
  REPORT_FROM,
  SITE_LABEL = 'davidgoodloe.ai',
} = process.env;
const DRY_RUN = !!process.env.DRY_RUN && !['', '0', 'false'].includes(process.env.DRY_RUN);

// The site's own hostnames - traffic "referred" by these is internal navigation,
// not outside discovery, so it's separated out of the referrers list.
const OWN_HOSTS = ['davidgoodloe.ai', 'www.davidgoodloe.ai'];

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}
requireEnv('CF_API_TOKEN', CF_API_TOKEN);
requireEnv('CF_ACCOUNT_ID', CF_ACCOUNT_ID);
if (!DRY_RUN) {
  requireEnv('RESEND_API_KEY', RESEND_API_KEY);
  requireEnv('REPORT_TO', REPORT_TO);
}
// CF_WEB_ANALYTICS_SITE_TAG is optional - only needed to disambiguate multiple sites.

// --- Date ranges: last 7 full days, and the 7 before that (for week-over-week) ---
const now = new Date();
const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); // today 00:00
const start = new Date(end);
start.setUTCDate(start.getUTCDate() - 7);
const prevStart = new Date(start);
prevStart.setUTCDate(prevStart.getUTCDate() - 7);
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const dayLabel = (d) => d.toISOString().slice(0, 10);
const rangeLabel = `${dayLabel(start)} to ${dayLabel(new Date(end.getTime() - 86400000))}`;

// Full country names from ISO-3166 alpha-2 codes (built into Node - no dependency).
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code) => {
  if (!code) return 'Unknown';
  try {
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
};

// --- GraphQL ---
// The filter is inlined as a literal (dates are ISO, siteTag is a known tag) to
// avoid depending on the exact GraphQL input-type name for typed variables. The
// siteTag clause is only added when provided (a single-site account needs no tag).
const siteTagClause = CF_WEB_ANALYTICS_SITE_TAG ? `, { siteTag: "${CF_WEB_ANALYTICS_SITE_TAG}" }` : '';
const rangeFilter = (from, to) =>
  `{ AND: [ { datetime_geq: "${iso(from)}", datetime_lt: "${iso(to)}" }${siteTagClause} ] }`;
const curFilter = rangeFilter(start, end);
const prevFilter = rangeFilter(prevStart, start);

const QUERY = `
query Weekly {
  viewer {
    accounts(filter: { accountTag: "${CF_ACCOUNT_ID}" }) {
      totals: rumPageloadEventsAdaptiveGroups(limit: 1, filter: ${curFilter}) {
        count
        sum { visits }
      }
      prevTotals: rumPageloadEventsAdaptiveGroups(limit: 1, filter: ${prevFilter}) {
        count
        sum { visits }
      }
      byDay: rumPageloadEventsAdaptiveGroups(limit: 10, filter: ${curFilter}, orderBy: [date_ASC]) {
        count
        dimensions { date }
      }
      pages: rumPageloadEventsAdaptiveGroups(limit: 15, filter: ${curFilter}, orderBy: [count_DESC]) {
        count
        dimensions { requestPath }
      }
      referrers: rumPageloadEventsAdaptiveGroups(limit: 20, filter: ${curFilter}, orderBy: [count_DESC]) {
        count
        dimensions { refererHost }
      }
      countries: rumPageloadEventsAdaptiveGroups(limit: 15, filter: ${curFilter}, orderBy: [count_DESC]) {
        count
        dimensions { countryName }
      }
      devices: rumPageloadEventsAdaptiveGroups(limit: 10, filter: ${curFilter}, orderBy: [count_DESC]) {
        count
        dimensions { deviceType }
      }
    }
  }
}`;

async function fetchAnalytics() {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: QUERY }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error('Cloudflare GraphQL error:', JSON.stringify(json.errors || json, null, 2));
    process.exit(1);
  }
  return json.data.viewer.accounts[0];
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Week-over-week change badge: {html, text}. Up = green (more traffic is good).
function delta(cur, prev) {
  if (!prev) return { html: '<span style="color:#888">new</span>', text: '(new)' };
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return { html: '<span style="color:#888">no change</span>', text: '(no change)' };
  const up = pct > 0;
  const color = up ? '#2f8f4e' : '#c0392b';
  const arrow = up ? '▲' : '▼';
  return {
    html: `<span style="color:${color};font-weight:600">${arrow} ${Math.abs(pct)}%</span>`,
    text: `(${up ? '+' : '-'}${Math.abs(pct)}% vs prior week)`,
  };
}

function statTile(value, label, d) {
  return `<div style="min-width:96px">
    <div style="font-size:30px;font-weight:800;line-height:1">${value}</div>
    <div style="color:#666;font-size:13px;margin-top:2px">${label}</div>
    <div style="font-size:12px;margin-top:3px">${d.html}</div>
  </div>`;
}

function rowsTable(title, rows, emptyLabel = '(none)') {
  const items = rows
    .slice(0, 8)
    .map(
      (r) =>
        `<tr><td style="padding:4px 12px 4px 0">${esc(r.label)}</td>` +
        `<td style="padding:4px 0;text-align:right;color:#9c7016;font-weight:600">${r.count.toLocaleString()}</td></tr>`
    )
    .join('');
  return `<h3 style="margin:22px 0 6px;font-size:15px">${title}</h3>` +
    (items
      ? `<table style="border-collapse:collapse;font-size:14px;width:100%;max-width:520px">${items}</table>`
      : `<p style="margin:2px 0;color:#888;font-size:14px">${emptyLabel}</p>`);
}

const perVisit = (pv, v) => (v > 0 ? (pv / v).toFixed(1) : '0.0');

function build(data) {
  const total = data.totals[0] || { count: 0, sum: { visits: 0 } };
  const prev = data.prevTotals?.[0] || { count: 0, sum: { visits: 0 } };
  const pageviews = total.count || 0;
  const visits = total.sum?.visits || 0;
  const prevPv = prev.count || 0;
  const prevVisits = prev.sum?.visits || 0;
  const ppv = perVisit(pageviews, visits);
  const prevPpv = perVisit(prevPv, prevVisits);

  const dPv = delta(pageviews, prevPv);
  const dVisits = delta(visits, prevVisits);
  const dPpv = delta(parseFloat(ppv), parseFloat(prevPpv));

  const pages = (data.pages || []).map((r) => ({ label: r.dimensions.requestPath || '(unknown)', count: r.count }));

  // Referrers: split external discovery from internal navigation + direct.
  let internalCount = 0;
  let directCount = 0;
  const external = [];
  for (const r of data.referrers || []) {
    const host = r.dimensions.refererHost || '';
    if (!host) directCount += r.count;
    else if (OWN_HOSTS.some((h) => host === h || host.endsWith('.' + h))) internalCount += r.count;
    else external.push({ label: host, count: r.count });
  }

  const countries = (data.countries || []).map((r) => ({ label: countryName(r.dimensions.countryName), count: r.count }));

  const devices = (data.devices || [])
    .filter((r) => r.dimensions.deviceType)
    .map((r) => ({ label: r.dimensions.deviceType.replace(/^\w/, (c) => c.toUpperCase()), count: r.count }));

  // Busiest day.
  let busiest = null;
  for (const r of data.byDay || []) {
    if (!busiest || r.count > busiest.count) busiest = { date: r.dimensions.date, count: r.count };
  }
  const weekday = busiest
    ? new Date(busiest.date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
    : '';
  const busiestLine = busiest
    ? `Busiest day: ${busiest.date} (${weekday}) - ${busiest.count.toLocaleString()} page views`
    : '';

  const contextLine =
    `Of this week's page views, ${internalCount.toLocaleString()} came from internal navigation ` +
    `and ${directCount.toLocaleString()} were direct/unknown (typed URL, bookmark, or hidden referrer). ` +
    `External referrers below are the real "someone discovered you" signal.`;

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#24272c;line-height:1.5">
    <h2 style="margin:0 0 2px">${esc(SITE_LABEL)} - weekly report</h2>
    <p style="margin:0 0 16px;color:#666;font-size:13px">${rangeLabel} (UTC) &middot; vs. prior 7 days</p>
    <div style="display:flex;gap:26px;margin:0 0 10px;flex-wrap:wrap">
      ${statTile(pageviews.toLocaleString(), 'page views', dPv)}
      ${statTile(visits.toLocaleString(), 'visits', dVisits)}
      ${statTile(ppv, 'pages / visit', dPpv)}
    </div>
    ${busiestLine ? `<p style="margin:0 0 2px;color:#444;font-size:13px">${busiestLine}</p>` : ''}
    <p style="margin:10px 0 0;color:#666;font-size:12.5px;max-width:520px">${contextLine}</p>
    ${rowsTable('Top pages', pages)}
    ${rowsTable('Top referrers (external sources)', external, 'No external referrers yet - traffic was direct or internal. This is where Google, LinkedIn, ChatGPT, etc. will appear as people discover the site.')}
    ${rowsTable('Top countries', countries)}
    ${rowsTable('Devices', devices)}
    <p style="margin:26px 0 0;color:#999;font-size:12px">Source: Cloudflare Web Analytics (cookieless; JavaScript-based, so non-JS crawlers like Googlebot/GPTBot are not counted here). Full dashboard in your Cloudflare account.</p>
  </body></html>`;

  const list = (rows, empty) =>
    rows.length ? rows.slice(0, 8).map((r) => `  ${r.count}  ${r.label}`).join('\n') : `  ${empty}`;
  const text =
    `${SITE_LABEL} - weekly report (${rangeLabel} UTC), vs prior 7 days\n\n` +
    `Page views: ${pageviews} ${dPv.text}\n` +
    `Visits: ${visits} ${dVisits.text}\n` +
    `Pages/visit: ${ppv} ${dPpv.text}\n` +
    (busiestLine ? `${busiestLine}\n` : '') +
    `\n${contextLine}\n\n` +
    `Top pages:\n${list(pages, '(none)')}\n\n` +
    `Top referrers (external):\n${list(external, '(none yet - direct or internal)')}\n\n` +
    `Top countries:\n${list(countries, '(none)')}\n\n` +
    `Devices:\n${list(devices, '(none)')}\n`;

  return { html, text, pageviews, visits };
}

async function send({ html, text }) {
  const from = REPORT_FROM || 'Website Report <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [REPORT_TO],
      subject: `${SITE_LABEL} weekly report - ${rangeLabel}`,
      html,
      text,
    }),
  });
  if (!res.ok) {
    console.error('Resend error:', res.status, await res.text());
    process.exit(1);
  }
}

const data = await fetchAnalytics();
const report = build(data);
if (DRY_RUN) {
  console.log('--- DRY RUN (no email sent) ---\n');
  console.log(report.text);
} else {
  await send(report);
  console.log(`Sent weekly report to ${REPORT_TO}: ${report.pageviews} page views, ${report.visits} visits (${rangeLabel}).`);
}
