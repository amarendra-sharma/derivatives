// ============================================================================
//  fd-notify-prof-request — tell the admins that someone asked for instructor access.
//
//  The portal has ALREADY inserted the fd_access_request row before it calls
//  this. The row is the record; this function only sends the heads-up, and the
//  portal ignores whatever it returns. So the one rule here is: never let a
//  failure to send mail look like a failure to request access.
//
//  SPAM-RELAY HARDENING. This is the only function a brand-new, unprivileged
//  account can reach, and it sends mail. So:
//    * the recipient is NEVER taken from the request body -- it is the admin
//      list from fd_person, or NOTIFY_EMAIL. A caller cannot choose who gets mail.
//    * the sender's own address comes from the verified JWT, not the body.
//    * mail goes out only when a *pending* fd_access_request row actually
//      exists for that caller, so one signup produces at most one message.
//    * institution/note are truncated and HTML-escaped before they are put in
//      the body.
//
//  Action: (none -- any body) { email?, institution?, note? }
//  Returns: { ok, sent, reason? }   200 in every non-auth case, by design.
//
//  Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//       RESEND_API_KEY   (optional -- with no key, this is a no-op that logs)
//       NOTIFY_EMAIL     (optional -- overrides the fd_person admin list)
//       NOTIFY_FROM      (optional -- defaults to onboarding@resend.dev)
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function clip(s: unknown, n: number): string {
  const t = String(s ?? "").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "not authenticated" }, 401);
  const uid = userData.user.id;
  const requesterEmail = String(userData.user.email ?? "").toLowerCase();

  // deno-lint-ignore no-explicit-any
  let p: any = {};
  try { p = await req.json(); } catch { p = {}; }

  const admin = createClient(url, service);

  // ---- there must be a pending request row for this caller ------------------
  // Without this, any signed-in account could call this endpoint in a loop.
  const { data: reqRow } = await admin.from("fd_access_request")
    .select("id,status,institution,note,created_at")
    .eq("user_id", uid).eq("status", "pending")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!reqRow) {
    return json({ ok: true, sent: false, reason: "no pending request for this account" });
  }

  // Prefer what is on the row (already persisted and admin-visible) over the
  // body, which is unverified.
  const institution = clip(reqRow.institution ?? p.institution, 200);
  const note = clip(reqRow.note ?? p.note, 1500);

  // ---- recipients: config, else every admin in fd_person --------------------
  let to: string[] = [];
  const configured = String(Deno.env.get("NOTIFY_EMAIL") ?? "").trim();
  if (configured) {
    to = configured.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  } else {
    const { data: admins } = await admin.from("fd_person")
      .select("email").eq("role", "admin");
    to = (admins ?? []).map(function (a) { return String(a.email ?? ""); }).filter(Boolean);
  }
  if (!to.length) {
    console.log("prof-request: no recipient configured; request " + reqRow.id + " from " + requesterEmail);
    return json({ ok: true, sent: false, reason: "no admin recipient configured" });
  }

  const key = String(Deno.env.get("RESEND_API_KEY") ?? "").trim();
  if (!key) {
    // Deliberately not an error. The queue in Admin -> Requests is the system of
    // record; email is a convenience on top of it.
    console.log("prof-request: RESEND_API_KEY unset; request " + reqRow.id + " from " + requesterEmail);
    return json({ ok: true, sent: false, reason: "no mail provider configured" });
  }

  const from = String(Deno.env.get("NOTIFY_FROM") ?? "").trim() || "onboarding@resend.dev";
  const html =
    "<p><strong>" + esc(requesterEmail) + "</strong> has requested instructor access " +
    "to the Financial Derivatives console.</p>" +
    "<p><strong>Institution:</strong> " + (institution ? esc(institution) : "&mdash;") + "</p>" +
    "<p><strong>Note:</strong><br>" + (note ? esc(note).replace(/\n/g, "<br>") : "&mdash;") + "</p>" +
    "<p style=\"color:#666;font-size:13px\">Approve or deny in Admin &rarr; Requests. " +
    "Approving sets their role to <code>professor</code>.</p>";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to,
        subject: "Instructor access request — " + requesterEmail,
        html,
        reply_to: requesterEmail || undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.log("prof-request: resend " + res.status + " " + body.slice(0, 300));
      return json({ ok: true, sent: false, reason: "mail provider returned " + res.status });
    }
  } catch (e) {
    console.log("prof-request: send failed " + String(e));
    return json({ ok: true, sent: false, reason: "could not reach the mail provider" });
  }

  return json({ ok: true, sent: true, recipients: to.length });
});
