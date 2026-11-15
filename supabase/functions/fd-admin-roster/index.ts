// ============================================================================
//  fd-admin-roster — account and course-staff administration.
//
//  Actions:
//    add_user        { email, role, full_name?, course_id? }
//    set_role        { email, role }
//    list_staff      { course_id }                       -> { staff: [...] }
//    add_staff       { course_id, email, full_name?, staff_role?, can_* }
//    set_staff_perms { course_id, user_id, can_* }
//    remove_staff    { course_id, user_id }
//
//  These use the service role to create auth accounts, so the permission check
//  at the top is the ONLY thing standing between a signed-in student and the
//  ability to make themselves a professor. Every branch re-checks; there is no
//  "already checked above" shortcut.
//
//  CAPABILITY MODEL. Staff are not a role, they are a set of capability flags on
//  fd_course_staff. A TA with can_grade but not can_view_grades can mark written
//  answers without seeing the class ranking. The flags are whitelisted below —
//  an unknown can_* key in the payload is dropped rather than written through.
//
//  Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
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

const CAP_KEYS = ["can_view_roster", "can_grade", "can_view_grades", "can_edit_exams"];
// deno-lint-ignore no-explicit-any
function capsFrom(p: any): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of CAP_KEYS) { if (k in p) { out[k] = !!p[k]; } }
  return out;
}

/* Find an auth user by email, paging through the whole list.
   listUsers defaults to 50 users PER PAGE. Auth is shared with Intro Micro,
   which alone has ~180 students, so an unpaged lookup silently fails to find
   almost everyone -- and the caller then reports "could not create that
   account" for a person who plainly exists. Page until found or exhausted. */
// deno-lint-ignore no-explicit-any
async function findAuthUserByEmail(admin: any, email: string): Promise<any | null> {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean) return null;
  const PER_PAGE = 200;
  for (let page = 1; page <= 50; page++) {          // hard stop at 10k users
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) return null;
    const users = data?.users ?? [];
    // deno-lint-ignore no-explicit-any
    const hit = users.find((u: any) => String(u.email ?? "").toLowerCase() === clean);
    if (hit) return hit;
    if (users.length < PER_PAGE) return null;       // last page
  }
  return null;
}

function tempPassword(): string {
  // Readable enough to dictate over a desk, random enough not to be guessable.
  const n = Math.floor(1000 + Math.random() * 9000);
  const a = ["Hedge", "Option", "Forward", "Swap", "Delta"];
  return a[Math.floor(Math.random() * a.length)] + "-" + n;
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

  // deno-lint-ignore no-explicit-any
  let p: any;
  try { p = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = String(p?.action || "");
  const admin = createClient(url, service);

  const { data: me } = await admin.from("fd_person").select("role").eq("user_id", uid).maybeSingle();
  const isAdmin = !!(me && me.role === "admin");

  async function ownsCourse(courseId: string): Promise<boolean> {
    if (!courseId) return false;
    if (isAdmin) return true;
    const { data } = await admin.from("fd_course").select("owner_id").eq("id", courseId).maybeSingle();
    return !!(data && data.owner_id === uid);
  }

  /* ---- find or create an auth user by email ----------------------------- */
  async function ensureAccount(email: string, fullName?: string) {
    const clean = String(email || "").trim().toLowerCase();
    if (!clean || clean.indexOf("@") < 0) return { error: "a valid email is required" };

    // Is there already a person row with this email?
    const { data: existingPerson } = await admin.from("fd_person")
      .select("user_id,email").ilike("email", clean).maybeSingle();
    if (existingPerson) {
      return { user_id: existingPerson.user_id, created: false, temp_password: null };
    }

    // Create a CONFIRMED account. Email confirmation links have historically not
    // been delivered to some campus domains, which left students stuck in an
    // unconfirmed state they could not resolve themselves.
    const pw = tempPassword();
    const { data: created, error } = await admin.auth.admin.createUser({
      email: clean, password: pw, email_confirm: true,
      user_metadata: fullName ? { full_name: fullName } : undefined,
    });
    if (error || !created?.user) {
      // Most likely the auth user exists but has no fd_person row yet.
      const found = await findAuthUserByEmail(admin, clean);
      if (found) {
        await admin.from("fd_person").upsert(
          { user_id: found.id, email: clean, full_name: fullName ?? null },
          { onConflict: "user_id" });
        return { user_id: found.id, created: false, temp_password: null };
      }
      return { error: error ? error.message : "could not create that account" };
    }
    await admin.from("fd_person").upsert(
      { user_id: created.user.id, email: clean, full_name: fullName ?? null },
      { onConflict: "user_id" });
    return { user_id: created.user.id, created: true, temp_password: pw };
  }

  /* ============================== add_user ============================== */
  if (action === "add_user") {
    const role = String(p.role || "student");
    if (role === "admin" && !isAdmin) return json({ error: "only an admin can create an admin" }, 403);
    if (role === "professor" && !isAdmin) return json({ error: "only an admin can create an instructor" }, 403);
    if (!isAdmin && !(p.course_id && await ownsCourse(p.course_id))) {
      return json({ error: "not permitted" }, 403);
    }

    const acct = await ensureAccount(p.email, p.full_name);
    if ("error" in acct) return json({ error: acct.error }, 400);

    if (role !== "student") {
      await admin.from("fd_person").update({ role }).eq("user_id", acct.user_id);
    }
    if (p.course_id) {
      await admin.from("fd_enrollment").upsert({
        course_id: p.course_id, student_id: acct.user_id, user_id: acct.user_id,
        status: "active", source: "admin", set_by: uid, started_at: new Date().toISOString(),
      }, { onConflict: "student_id,course_id" });
    }
    return json({ ok: true, created: acct.created, temp_password: acct.temp_password,
                  user_id: acct.user_id });
  }

  /* ============================== set_role ==============================
     Auth is shared across the MacroNations courses, so someone can hold a
     MacroNations account and still have no fd_person row -- that row is created
     the first time they open THIS portal. Looking only in fd_person therefore
     404s for every existing MacroNations user who has not yet visited this course,
     which right now is all of them. Fall through to auth.users and create the
     profile, which is what the portal's own call site says this does.        */
  if (action === "set_role") {
    if (!isAdmin) return json({ error: "only an admin can change a role" }, 403);
    const clean = String(p.email || "").trim().toLowerCase();
    if (!clean || clean.indexOf("@") < 0) return json({ error: "a valid email is required" }, 400);
    const role = String(p.role || "student");

    let userId: string | null = null;
    const { data: person } = await admin.from("fd_person")
      .select("user_id").ilike("email", clean).maybeSingle();
    if (person) {
      userId = person.user_id;
    } else {
      const found = await findAuthUserByEmail(admin, clean);
      if (!found) {
        return json({ error: "No MacroNations account exists with that email. " +
                             "Use Add as student or Add as instructor to create one." }, 404);
      }
      userId = found.id;
      const { error: insErr } = await admin.from("fd_person").insert({
        user_id: found.id, email: clean,
        full_name: found.user_metadata?.full_name ?? null,
      });
      // A race with their first sign-in would collide on the primary key; that
      // is fine, the row we wanted now exists either way.
      if (insErr && !String(insErr.message).toLowerCase().includes("duplicate")) {
        return json({ error: "could not create the profile: " + insErr.message }, 500);
      }
    }

    const { error: updErr } = await admin.from("fd_person")
      .update({ role }).eq("user_id", userId);
    if (updErr) return json({ error: "could not set the role: " + updErr.message }, 500);
    return json({ ok: true, user_id: userId, created_profile: !person });
  }

  /* ============================= list_staff ============================= */
  if (action === "list_staff") {
    if (!(await ownsCourse(p.course_id))) return json({ error: "not permitted" }, 403);
    const { data: rows } = await admin.from("fd_course_staff")
      .select("user_id,staff_role,can_view_roster,can_grade,can_view_grades,can_edit_exams,created_at")
      .eq("course_id", p.course_id);
    const ids = (rows ?? []).map(function (r) { return r.user_id; });
    const { data: people } = ids.length
      ? await admin.from("fd_person").select("user_id,email,full_name").in("user_id", ids)
      : { data: [] };
    const byId: Record<string, { email?: string; full_name?: string }> = {};
    (people ?? []).forEach(function (x) { byId[x.user_id] = x; });
    const staff = (rows ?? []).map(function (r) {
      return Object.assign({}, r, {
        email: byId[r.user_id]?.email ?? null,
        full_name: byId[r.user_id]?.full_name ?? null,
      });
    });
    return json({ ok: true, staff });
  }

  /* ============================== add_staff ============================= */
  if (action === "add_staff") {
    if (!(await ownsCourse(p.course_id))) return json({ error: "not permitted" }, 403);
    const acct = await ensureAccount(p.email, p.full_name);
    if ("error" in acct) return json({ error: acct.error }, 400);

    const caps = capsFrom(p);
    const row = Object.assign({
      course_id: p.course_id, user_id: acct.user_id,
      staff_role: String(p.staff_role || "ta"),
    }, caps);
    const { error } = await admin.from("fd_course_staff")
      .upsert(row, { onConflict: "course_id,user_id" });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, created: acct.created, temp_password: acct.temp_password });
  }

  /* =========================== set_staff_perms ========================== */
  if (action === "set_staff_perms") {
    if (!(await ownsCourse(p.course_id))) return json({ error: "not permitted" }, 403);
    const caps = capsFrom(p);
    if (p.staff_role) { (caps as Record<string, unknown>).staff_role = String(p.staff_role); }
    if (!Object.keys(caps).length) return json({ error: "nothing to change" }, 400);
    const { error } = await admin.from("fd_course_staff").update(caps)
      .eq("course_id", p.course_id).eq("user_id", p.user_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  /* ============================ remove_staff ============================ */
  if (action === "remove_staff") {
    if (!(await ownsCourse(p.course_id))) return json({ error: "not permitted" }, 403);
    const { error } = await admin.from("fd_course_staff").delete()
      .eq("course_id", p.course_id).eq("user_id", p.user_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "unknown action: " + action }, 400);
});
