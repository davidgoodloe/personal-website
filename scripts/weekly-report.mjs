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

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}
requireEnv('CF_API_TOKEN', CF_API_TOKEN);
requireEnv('CF_ACCOUNT_ID', CF_ACCOUNT_ID);
requireEnv('RESEND_API_KEY', RESEND_API_KEY);
requireEnv('REPORT_TO', REPORT_TO);
// CF_WEB_ANALYTICS_SITE_TAG is optional - only needed to disambiguate multiple sites.

// --- Date range: the 7 full days ending yesterday (UTC) ---
const now = new Date();
const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); // today 00:00
const start = new Date(end);
start.setUTCDate(start.getUTCDate() - 7);
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const dayLabel = (d) => d.toISOString().slice(0, 10);
const rangeLabel = `${dayLabel(start)} to ${dayLabel(new Date(end.getTime() - 86400000))}`;

// --- GraphQL: totals, top pages, referrers, countries, daily trend ---
// The filter is inlined as a literal (dates are ISO, siteTag is a known tag) to
// avoid depending on the exact GraphQL input-type name for typed variables. The
// siteTag clause is only added when provided (a single-site account needs no tag).
const siteTagClause = CF_WEB_ANALYTICS_SITE_TAG ? `, { siteTag: "${CF_WEB_ANALYTICS_SITE_TAG}" }` : '';
const filterLiteral = `{ AND: [ { datetime_geq: "${iso(start)}", datetime_lt: "${iso(end)}" }${siteTagClause} ] }`;
const QUERY = `
query Weekly {
  viewer {
    accounts(filter: { accountTag: "${CF_ACCOUNT_ID}" }) {
      totals: rumPageloadEventsAdaptiveGroups(limit: 1, filter: ${filterLiteral}) {
        count
        sum { visits }
      }
      byDay: rumPageloadEventsAdaptiveGroups(limit: 10, filter: ${filterLiteral}, orderBy: [date_ASC]) {
        count
        sum { visits }
        dimensions { date }
      }
      pages: rumPageloadEventsAdaptiveGroups(limit: 10, filter: ${filterLiteral}, orderBy: [count_DESC]) {
        count
        dimensions { requestPath }
      }
      referrers: rumPageloadEventsAdaptiveGroups(limit: 10, filter: ${filterLiteral}, orderBy: [count_DESC]) {
        count
        dimensions { refererHost }
      }
      countries: rumPageloadEventsAdaptiveGroups(limit: 10, filter: ${filterLiteral}, orderBy: [count_DESC]) {
        count
        dimensions { countryName }
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

function rowsTable(title, rows, emptyLabel = '(none)') {
  const items = rows
    .filter((r) => r.label && r.label !== '')
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
      : `<p style="margin:2px 0;color:#666;font-size:14px">${emptyLabel}</p>`);
}

function build(data) {
  const total = data.totals[0] || { count: 0, sum: { visits: 0 } };
  const pageviews = total.count || 0;
  const visits = total.sum?.visits || 0;

  const pages = data.pages.map((r) => ({ label: r.dimensions.requestPath, count: r.count }));
  const referrers = data.referrers.map((r) => ({ label: r.dimensions.refererHost, count: r.count }));
  const countries = data.countries.map((r) => ({ label: r.dimensions.countryName, count: r.count }));

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#24272c;line-height:1.5">
    <h2 style="margin:0 0 2px">${esc(SITE_LABEL)} - weekly report</h2>
    <p style="margin:0 0 18px;color:#666;font-size:13px">${rangeLabel} (UTC)</p>
    <div style="display:flex;gap:28px;margin:0 0 6px">
      <div><div style="font-size:30px;font-weight:800">${pageviews.toLocaleString()}</div>
        <div style="color:#666;font-size:13px">page views</div></div>
      <div><div style="font-size:30px;font-weight:800">${visits.toLocaleString()}</div>
        <div style="color:#666;font-size:13px">visits</div></div>
    </div>
    ${rowsTable('Top pages', pages)}
    ${rowsTable('Top referrers', referrers, '(direct / none recorded)')}
    ${rowsTable('Top countries', countries)}
    <p style="margin:26px 0 0;color:#999;font-size:12px">Source: Cloudflare Web Analytics (cookieless). Full dashboard in your Cloudflare account.</p>
  </body></html>`;

  const text =
    `${SITE_LABEL} - weekly report (${rangeLabel} UTC)\n\n` +
    `Page views: ${pageviews}\nVisits: ${visits}\n\n` +
    `Top pages:\n${pages.filter((p) => p.label).slice(0, 8).map((p) => `  ${p.count}  ${p.label}`).join('\n') || '  (none)'}\n\n` +
    `Top referrers:\n${referrers.filter((r) => r.label).slice(0, 8).map((r) => `  ${r.count}  ${r.label}`).join('\n') || '  (direct / none)'}\n\n` +
    `Top countries:\n${countries.filter((c) => c.label).slice(0, 8).map((c) => `  ${c.count}  ${c.label}`).join('\n') || '  (none)'}\n`;

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
await send(report);
console.log(`Sent weekly report to ${REPORT_TO}: ${report.pageviews} page views, ${report.visits} visits (${rangeLabel}).`);
