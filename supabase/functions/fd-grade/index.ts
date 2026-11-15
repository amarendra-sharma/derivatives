// ============================================================================
//  fd-grade  —  server-side grading for Financial Derivatives ARENA cases and the Payoff Lab.
//
//  The arenas (fd-arena.js) draw their cases from the shared question bank and
//  post {arena_slug, case_index, generator_id, seed, submitted}. This function
//  regenerates the case from the seed, grades it, and writes one fd_attempt row.
//  The answer key never reaches the browser.
//
//  Relationship to fd-grade-quiz: same generator import, same determinism, but a
//  different destination table. Quizzes and exams write fd_exam_attempt (scored
//  in points); arenas write fd_attempt (scored as correct/incorrect per case,
//  rolled up by fd_arena_attempt_rollup). Keeping them separate is what lets an
//  arena be re-run for practice without disturbing a quiz grade.
//
//  Deploy:
//    supabase/functions/fd-grade/
//      index.ts  +  fd-generators.js, -b.js, -c.js, -d.js
//    supabase functions deploy fd-grade
//
//  Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import "./fd-generators.js";
import "./fd-payoff-model.js";   // Payoff Lab cases, rebuilt from the seed and re-graded here

type Built = {
  id: string;
  kind: "numeric" | "mc" | "short";
  points: number;
  prompt: string;
  rubric?: string;
  rationale?: string;
  options?: string[];
  answer: number | null;
  tolerance?: number;
};
type GenApi = {
  generate: (id: string, seed: number) => Built | null;
  grade: (id: string, seed: number, submitted: string) =>
    { correct?: boolean; points?: number; expected?: unknown; needsAI?: boolean };
};
// deno-lint-ignore no-explicit-any
const MA: GenApi = (globalThis as any).FDGenerators;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

interface Payload {
  arena_slug: string;
  case_index?: number;
  submitted?: string;
  attempt_no?: number;
  generator_id?: string;
  seed?: number;
  course_id?: string;
  prompt_text?: string;
  labels?: string[] | null;
  // performance-mode arenas (a simulation rather than a keyed case)
  achieved?: number;
  round_max?: number;
  // payoff mode: the server rebuilds the run from its seed and grades the answers
  mode?: string;
  // deno-lint-ignore no-explicit-any
  answers?: any[];
  // deno-lint-ignore no-explicit-any
  payoff_answers?: any[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!MA || typeof MA.generate !== "function") {
    return json({ error: "generator bank failed to load on the server" }, 500);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "not authenticated" }, 401);
  const userId = userData.user.id;

  let p: Payload;
  try { p = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!p || !p.arena_slug) return json({ error: "arena_slug required" }, 400);

  const admin = createClient(url, service);

  // ---- access gate ---------------------------------------------------------
  // Same shape as fd-grade-quiz: fetch the rows and choose, rather than
  // maybeSingle() which errors outright when a student is in two sections.
  // 'comped' is as good as 'active' -- fd_has_access() grants on both, so the
  // arena opens; the grade must then record too, not 403 on submit.
  const { data: enrollRows, error: enrollErr } = await admin
    .from("fd_enrollment")
    .select("course_id,status")
    .eq("student_id", userId)
    .in("status", ["active", "comped"]);
  if (enrollErr) return json({ error: "could not verify enrollment: " + enrollErr.message }, 500);

  const active: Array<{ course_id: string }> =
    (enrollRows ?? []) as Array<{ course_id: string }>;

  // Free-preview arenas are playable without an enrollment; their attempts are
  // still recorded so a student who later enrols keeps their history.
  const FREE_ARENAS = ["payoff-lab"];
  const isFree = FREE_ARENAS.indexOf(p.arena_slug) >= 0;
  // Staff (professor / admin, or course staff anywhere) can open every arena
  // through fd_has_access(), usually with no enrollment of their own. Without
  // this their test runs were refused here and the page said "NOT recorded".
  let isStaff = false;
  if (active.length === 0) {
    const { data: me } = await admin.from("fd_person").select("role").eq("user_id", userId).maybeSingle();
    isStaff = !!(me && (me.role === "professor" || me.role === "admin"));
    if (!isStaff) {
      const { data: cs } = await admin.from("fd_course_staff").select("course_id").eq("user_id", userId).limit(1);
      isStaff = !!(cs && cs.length);
    }
    if (!isStaff && !isFree) return json({ error: "no active enrollment", code: "ENROLL_REQUIRED" }, 403);
  }

  let courseId: string | null = null;
  if (p.course_id && active.some(function (r) { return r.course_id === p.course_id; })) {
    courseId = p.course_id;
  } else if (p.course_id && isStaff) {
    // Staff testing from a course they run: file the run under it, so it shows
    // on their own My Grades for that course instead of under no course at all.
    const { data: own } = await admin.from("fd_course").select("owner_id").eq("id", p.course_id).maybeSingle();
    const { data: me2 } = await admin.from("fd_person").select("role").eq("user_id", userId).maybeSingle();
    if ((own && own.owner_id === userId) || (me2 && me2.role === "admin")) courseId = p.course_id;
  } else if (active.length === 1) {
    courseId = active[0].course_id;
  } else if (active.length > 1) {
    // Ambiguous. fd_attempt.course_id is nullable, so unlike a quiz this does not
    // have to fail — but leave it null rather than guessing a section, and say so.
    courseId = null;
  }

  const attemptNo = (typeof p.attempt_no === "number" && p.attempt_no >= 1) ? p.attempt_no : 1;
  const nowIso = new Date().toISOString();

  // ---- PAYOFF LAB ---------------------------------------------------------
  // The page posts the seed of the run and the raw answers to each case. The
  // server rebuilds the same thirteen cases from that seed with the same file
  // the page used (fd-payoff-model.js), grades every answer itself, and assigns
  // the attempt number. A score typed into the browser console changes nothing.
  if (p.mode === "payoff") {
    // deno-lint-ignore no-explicit-any
    const PO = (globalThis as any).FDPayoff;
    if (!PO || typeof PO.gradeRun !== "function") return json({ error: "Payoff Lab model failed to load on the server" }, 500);
    if (p.arena_slug !== PO.SLUG) return json({ error: "mode payoff is only for " + PO.SLUG }, 400);
    if (typeof p.seed !== "number" || !Array.isArray(p.payoff_answers ?? p.answers)) {
      return json({ error: "seed and answers are required" }, 400);
    }
    // deno-lint-ignore no-explicit-any
    const answers = (p.payoff_answers ?? p.answers) as any[];
    if (answers.length > PO.CASES) return json({ error: "more answers than the run has cases" }, 400);

    const { data: prev, error: prevErr } = await admin.from("fd_attempt").select("attempt_no")
      .eq("user_id", userId).eq("arena_slug", p.arena_slug)
      .order("attempt_no", { ascending: false }).limit(1);
    if (prevErr) return json({ error: "could not read earlier attempts: " + prevErr.message }, 500);
    const last = prev && prev.length ? Number(prev[0].attempt_no) || 0 : 0;
    if (last >= PO.MAX_ATTEMPTS) {
      return json({ ok: false, code: "ATTEMPTS_USED", error: "both graded attempts are already recorded" }, 409);
    }

    const run = PO.gradeRun(p.seed | 0, answers);
    const attempt = last + 1;
    const pct = Math.max(0, Math.min(1, run.earned / run.max));
    // deno-lint-ignore no-explicit-any
    const rows = run.cases.map(function (c: any, i: number) {
      return {
        user_id: userId, course_id: courseId, arena_slug: p.arena_slug,
        attempt_no: attempt, case_index: i,
        submitted: JSON.stringify(answers[i] ?? null).slice(0, 2000),
        is_correct: c.earned === c.pts, score_pct: pct,
        prompt_text: "Stage " + c.stage + " · " + c.title + " · " + c.earned + " of " + c.pts + " points",
        chosen_label: String(c.your).slice(0, 500), correct_label: String(c.correct).slice(0, 500),
        created_at: nowIso,
      };
    });
    const { error: insErr } = await admin.from("fd_attempt").insert(rows);
    if (insErr) return json({ error: "could not save the attempt: " + insErr.message }, 500);
    return json({ ok: true, attempt_no: attempt, earned: run.earned, score: pct,
                  graded: true, max_graded: PO.MAX_ATTEMPTS, cases: run.cases });
  }

  // ---- keyed mode ----------------------------------------------------------
  if (!p.generator_id || typeof p.seed !== "number") {
    return json({
      error: "generator_id and seed are required to grade an arena case",
      code: "NO_KEY_SOURCE",
    }, 400);
  }

  const q = MA.generate(p.generator_id, p.seed);
  if (!q) return json({ error: "unknown generator id: " + p.generator_id }, 400);

  // A written arena case cannot be auto-graded. Record it unGRADED rather than
  // guessing — the same rule the quiz grader follows.
  if (q.kind === "short") {
    const { error } = await admin.from("fd_attempt").insert({
      user_id: userId, course_id: courseId, arena_slug: p.arena_slug,
      attempt_no: attemptNo, case_index: p.case_index ?? null,
      submitted: p.submitted ?? null, is_correct: null,
      prompt_text: q.prompt, created_at: nowIso,
    });
    if (error) return json({ error: "could not save attempt: " + error.message }, 500);
    return json({ ok: true, pending: true, correct: null });
  }

  const res = MA.grade(p.generator_id, p.seed, p.submitted ?? "");
  const correct = !!res.correct;

  const chosenLabel = (q.options && p.submitted != null &&
    q.options[Number(p.submitted)] !== undefined) ? q.options[Number(p.submitted)] : null;
  const correctLabel = (q.options && q.answer != null &&
    q.options[Number(q.answer)] !== undefined) ? q.options[Number(q.answer)] : null;

  const { error: insErr } = await admin.from("fd_attempt").insert({
    user_id: userId, course_id: courseId, arena_slug: p.arena_slug,
    attempt_no: attemptNo, case_index: p.case_index ?? null,
    submitted: p.submitted ?? null, is_correct: correct,
    prompt_text: q.prompt, chosen_label: chosenLabel, correct_label: correctLabel,
    created_at: nowIso,
  });
  if (insErr) return json({ error: "could not save attempt: " + insErr.message }, 500);

  // correctCode is what the client highlights. Returning it AFTER the answer has
  // been submitted and recorded is safe; it is never sent before.
  return json({
    ok: true,
    correct: correct,
    correctCode: q.answer,
    rationale: q.rationale ?? null,
    score: correct ? 1 : 0,
  });
});
