// Cloudflare Pages Function - POST /api/contact
// Sends the About-page contact form to David via Resend.
//
// Secrets/config live ONLY as Cloudflare Pages environment variables, never in
// this repo or the page source:
//   RESEND_API_KEY  (required)  - your Resend API key
//   CONTACT_TO      (required)  - the inbox that receives messages (kept out of source)
//   CONTACT_FROM    (optional)  - a verified Resend sender, e.g. "Your Name <hello@yourdomain.com>".
//                                 Defaults to Resend's shared onboarding sender until a domain is verified.
//
// The function accepts either a normal HTML form POST (no-JS fallback) or a
// fetch() POST with `Accept: application/json` (the progressive-enhancement path).

export async function onRequestPost({ request, env }) {
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');

  const reply = (status, ok, error) =>
    wantsJson
      ? Response.json(ok ? { ok: true } : { ok: false, error }, { status })
      : htmlResult(status, ok, error);

  // --- Read the body (JSON or form-encoded) ---
  let data;
  const ctype = request.headers.get('content-type') || '';
  try {
    if (ctype.includes('application/json')) {
      data = await request.json();
    } else {
      data = Object.fromEntries(await request.formData());
    }
  } catch {
    return reply(400, false, 'We could not read that submission.');
  }

  const name = String(data.name || '').trim();
  const email = String(data.email || '').trim();
  const message = String(data.message || '').trim();
  const honeypot = String(data.botcheck || '').trim();

  // Honeypot: a bot filled the hidden field. Pretend it worked, send nothing.
  if (honeypot) return reply(200, true);

  // --- Validate ---
  if (!name || !email || !message) return reply(400, false, 'Please fill in every field.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, false, 'That email address looks off.');
  if (message.length > 5000) return reply(400, false, 'That message is a little too long.');

  if (!env.RESEND_API_KEY || !env.CONTACT_TO) {
    return reply(500, false, 'The contact form is not configured yet.');
  }

  // --- Send via Resend ---
  const from = env.CONTACT_FROM || 'Website Contact <onboarding@resend.dev>';
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [env.CONTACT_TO],
        reply_to: email, // replies go straight to the visitor
        subject: `New message from ${name} via your website`,
        text: `From: ${name} <${email}>\n\n${message}`,
      }),
    });
  } catch {
    return reply(502, false, 'The message could not be sent. Please try again.');
  }

  if (!res.ok) return reply(502, false, 'The message could not be sent. Please try again.');
  return reply(200, true);
}

// Minimal HTML response for visitors without JavaScript. Wording here is a
// functional fallback - David can reword the two strings below.
function htmlResult(status, ok, error) {
  const heading = ok ? 'Message sent' : 'Something went wrong';
  const body = ok
    ? 'Thanks for reaching out - I\'ll get back to you soon.'
    : (error || 'Please go back and try again.');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 34rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.6; }
  a { color: #2660d4; }
</style></head>
<body>
  <h1>${heading}</h1>
  <p>${body}</p>
  <p><a href="/about">Back to the site</a></p>
</body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
