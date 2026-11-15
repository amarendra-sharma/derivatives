// ============================================================================
//  fd-enroll-student — instructor adds a student to a course directly.
//
//  WHY THIS EXISTS RATHER THAN "ASK THEM TO SIGN UP FIRST"
//  In the micro course, Supabase's email-confirmation link was not reaching
//  binghamton.edu addresses. Students signed up, never got the mail, and were
//  left in an unconfirmed state they could not fix themselves — with no signal
//  to the instructor that anything had gone wrong. This function sidesteps the
//  mail entirely: it creates a CONFIRMED account with a temporary password that
//  the instructor reads out, and it repairs an account already stuck unconfirmed.
//
//  Action:  enroll { course_id, email, full_name? }
//  Returns: { ok, created, temp_password, repaired }
//           temp_password is null when the account already existed and was fine.
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
  if (String(p?.action || "enroll") !== "enroll") {
    return json({ error: "unknown action" }, 400);
  }
  const courseId = p.course_id;
  const email = String(p.email || "").trim().toLowerCase();
  if (!courseId) return json({ error: "course_id required" }, 400);
  if (!email || email.indexOf("@") < 0) return json({ error: "a valid email is required" }, 400);

  const admin = createClient(url, service);

  // ---- permission: course owner, admin, or staff with roster rights --------
  // The micro version allowed ANY course staff member through here, which meant
  // a TA with only grading rights could add students. Capability is checked.
  const { data: course } = await admin.from("fd_course")
    .select("owner_id,requires_payment").eq("id", courseId).maybeSingle();
  if (!course) return json({ error: "course not found" }, 404);

  let permitted = course.owner_id === uid;
  if (!permitted) {
    const { data: me } = await admin.from("fd_person").select("role").eq("user_id", uid).maybeSingle();
    permitted = !!(me && me.role === "admin");
  }
  if (!permitted) {
    const { data: staff } = await admin.from("fd_course_staff")
      .select("can_view_roster").eq("course_id", courseId).eq("user_id", uid).maybeSingle();
    permitted = !!(staff && staff.can_view_roster);
  }
  if (!permitted) return json({ error: "not permitted for this course" }, 403);

  // ---- find, repair, or create the account --------------------------------
  let userId: string | null = null;
  let created = false, repaired = false;
  let tempPw: string | null = null;

  const { data: person } = await admin.from("fd_person")
    .select("user_id").ilike("email", email).maybeSingle();
  if (person) { userId = person.user_id; }

  if (!userId) {
    const found = await findAuthUserByEmail(admin, email);
    if (found) {
      userId = found.id;
      // Stuck unconfirmed: confirm them and reset to a password we can hand over.
      if (!found.email_confirmed_at) {
        tempPw = tempPassword();
        await admin.auth.admin.updateUserById(found.id, {
          email_confirm: true, password: tempPw,
        });
        repaired = true;
      }
      await admin.from("fd_person").upsert(
        { user_id: found.id, email: email, full_name: p.full_name ?? null },
        { onConflict: "user_id" });
    }
  }

  if (!userId) {
    tempPw = tempPassword();
    const { data: made, error } = await admin.auth.admin.createUser({
      email, password: tempPw, email_confirm: true,
      user_metadata: p.full_name ? { full_name: p.full_name } : undefined,
    });
    if (error || !made?.user) {
      return json({ error: error ? error.message : "could not create that account" }, 400);
    }
    userId = made.user.id;
    created = true;
    await admin.from("fd_person").upsert(
      { user_id: userId, email, full_name: p.full_name ?? null }, { onConflict: "user_id" });
  } else if (p.full_name) {
    // Fill in a name only if we do not already have one — never overwrite what
    // the student set for themselves.
    const { data: cur } = await admin.from("fd_person")
      .select("full_name").eq("user_id", userId).maybeSingle();
    if (!cur || !cur.full_name) {
      await admin.from("fd_person").update({ full_name: p.full_name }).eq("user_id", userId);
    }
  }

  // ---- enroll, active regardless of payment: adding by hand IS the override --
  const { error: enrollErr } = await admin.from("fd_enrollment").upsert({
    course_id: courseId, student_id: userId, user_id: userId,
    status: "active", source: "instructor", set_by: uid,
    started_at: new Date().toISOString(),
  }, { onConflict: "student_id,course_id" });
  if (enrollErr) return json({ error: "could not enroll: " + enrollErr.message }, 500);

  return json({
    ok: true, created, repaired, user_id: userId, temp_password: tempPw,
    message: created
      ? "Account created and enrolled. Give them the temporary password; they can change it after signing in."
      : (repaired
        ? "This account existed but was stuck unconfirmed. It has been confirmed and given a new temporary password."
        : "Existing account enrolled. They sign in with the password they already have."),
  });
});
