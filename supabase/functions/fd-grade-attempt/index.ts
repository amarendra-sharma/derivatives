// ============================================================================
//  fd-grade-attempt — the EXAM engine.
//
//  Exams differ from chapter quizzes in one way that drives this whole design:
//  a quiz is submitted all at once, but an exam issues questions ONE AT A TIME
//  and grades each as it is answered, so a student who loses their connection or
//  is auto-submitted by the proctor keeps everything answered so far.
//
//  Actions (all POST, body.action):
//    issue        { item_id, course_id, exam_id? }   -> a question WITHOUT its answer
//    grade        { attempt_id, submitted_value }    -> grade one issued question
//    resume       { exam_id }                        -> items already issued this attempt
//    review       { exam_id, course_id }             -> student's post-exam review
//    preview      { item_id }                        -> instructor preview (WITH answer)
//    student_work { exam_id, student_id }            -> instructor: one student's exam
//    quiz_work    { course_id, student_id, chapter? }-> instructor: one student's quizzes
//    arena_work   { course_id, student_id, arena_slug }
//    quiz_review  { course_id, chapter }             -> ungraded written quiz answers
//
//  TWO KINDS OF ITEM. An exam can mix:
//    * BANK items — fd_assessment_item.generator_id is set. The question is
//      regenerated from (generator_id, seed) exactly like a quiz, so each student
//      gets different numbers and the answer never leaves the server.
//    * AUTHORED items — the instructor typed the prompt and options. The answer
//      lives in fd_assessment_item_key, a table with NO RLS policy at all, so it
//      is reachable only by the service role, i.e. only from here.
//
//  THE SEED IS PER STUDENT PER ITEM and is derived server-side. It is never
//  accepted from the client: a client-supplied seed would let a student reissue
//  the same question until they got numbers they liked.
//
//  Deploy: supabase/functions/fd-grade-attempt/ with the four fd-generators*.js
//  Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import "./fd-generators.js";
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
  diagramSpec?: unknown;
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
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/* Deterministic per-student, per-item seed. Same student + same item always
   regenerates the same question — which is what makes "resume after a dropped
   connection" and "regrade later" possible — while two students get different
   numbers. FNV-1a over the concatenation; cheap and stable across runtimes. */
function seedFor(studentId: string, itemId: string, examId: string | null): number {
  const s = studentId + "|" + itemId + "|" + (examId || "quiz");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) || 1;
}

/* Build the question for an item row, from the bank or from authored content. */
// deno-lint-ignore no-explicit-any
function buildItem(item: any, studentId: string, examId: string | null) {
  if (item.generator_id) {
    const seed = item.seed ? Number(item.seed) : seedFor(studentId, item.id, examId);
    const q = MA.generate(item.generator_id, seed);
    if (!q) return null;
    return {
      source: "bank" as const, seed,
      generator_id: item.generator_id,
      prompt: q.prompt,
      options: q.options ?? null,
      item_type: q.kind,
      points: q.points ?? item.points ?? 1,
      figure: q.diagramSpec ?? null,
      rationale: q.rationale ?? null,
      rubric: q.rubric ?? null,
    };
  }
  return {
    source: "authored" as const, seed: null, generator_id: null,
    prompt: item.prompt,
    options: item.options ?? null,
    item_type: item.item_type ?? "mc",
    points: Number(item.points ?? 1),
    figure: null, rationale: null, rubric: null,
  };
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
  const uid = userData.user.id;

  // deno-lint-ignore no-explicit-any
  let p: any;
  try { p = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = String(p?.action || "");
  if (!action) return json({ error: "action required" }, 400);

  const admin = createClient(url, service);

  /* ---- helpers ---------------------------------------------------------- */
  async function isStaff(courseId: string | null): Promise<boolean> {
    if (!courseId) return false;
    const { data: c } = await admin.from("fd_course").select("owner_id").eq("id", courseId).maybeSingle();
    if (c && c.owner_id === uid) return true;
    const { data: p2 } = await admin.from("fd_person").select("role").eq("user_id", uid).maybeSingle();
    if (p2 && p2.role === "admin") return true;
    const { data: s } = await admin.from("fd_course_staff")
      .select("can_grade,can_view_grades,can_edit_exams")
      .eq("course_id", courseId).eq("user_id", uid).maybeSingle();
    return !!(s && (s.can_grade || s.can_view_grades || s.can_edit_exams));
  }
  async function enrolledIn(courseId: string): Promise<boolean> {
    const { data } = await admin.from("fd_enrollment").select("status")
      .eq("course_id", courseId).eq("student_id", uid).eq("status", "active");
    return !!(data && data.length);
  }

  /* ============ STUDENT: ISSUE A WHOLE EXAM IN ONE CALL (2026-11-02) =========
     Same per-item rules as "issue" below (enrollment check, deterministic seed,
     reuse an existing attempt row for the same item), with one bank lookup, one
     existing-row lookup and ONE insert. All-or-nothing: on any problem the
     client falls back to issuing one question at a time. */
  if (action === "issue_batch") {
    const raw = Array.isArray(p.item_ids) ? p.item_ids : [];
    // deno-lint-ignore no-explicit-any
    const ids: string[] = raw.map(function (x: any) { return String(x || ""); }).filter(function (x: string) { return !!x; });
    const courseId = p.course_id ?? null, examId = p.exam_id ?? null;
    if (ids.length === 0 || ids.length > 150) return json({ error: "item_ids must hold 1-150 ids" }, 400);
    if (!courseId || !(await enrolledIn(courseId))) {
      return json({ error: "no active enrollment", code: "ENROLL_REQUIRED" }, 403);
    }
    const { data: rows } = await admin.from("fd_assessment_item")
      .select("id,chapter,item_type,points,prompt,options,generator_id,seed")
      .in("id", ids);
    // deno-lint-ignore no-explicit-any
    const byId: Record<string, any> = {};
    for (const r of (rows ?? [])) byId[r.id] = r;

    const { data: existingRows } = await admin.from("fd_exam_attempt")
      .select("id,item_id,submitted_value")
      .eq("student_id", uid).eq("exam_id", examId).in("item_id", ids);
    // deno-lint-ignore no-explicit-any
    const existing: Record<string, any> = {};
    for (const e of (existingRows ?? [])) { if (!existing[e.item_id]) existing[e.item_id] = e; }

    // deno-lint-ignore no-explicit-any
    const built: Record<string, any> = {};
    // deno-lint-ignore no-explicit-any
    const inserts: any[] = [];
    for (const itemId of ids) {
      const item = byId[itemId];
      if (!item) return json({ error: "item not found: " + itemId }, 404);
      const b = buildItem(item, uid, examId);
      if (!b) return json({ error: "could not build that item: " + itemId }, 500);
      built[itemId] = b;
      if (!existing[itemId] && !inserts.some(function (x) { return x.item_id === itemId; })) {
        inserts.push({
          course_id: courseId, exam_id: examId, item_id: itemId, student_id: uid,
          chapter: item.chapter ?? null,
          generator_id: b.generator_id, seed: b.seed,
          points_possible: b.points, created_at: new Date().toISOString(),
        });
      }
    }
    if (inserts.length) {
      const { data: ins, error } = await admin.from("fd_exam_attempt").insert(inserts).select("id,item_id");
      if (error) return json({ error: "could not issue items: " + error.message }, 500);
      for (const r of (ins ?? [])) existing[r.item_id] = { id: r.id, item_id: r.item_id, submitted_value: null, _new: true };
    }
    // deno-lint-ignore no-explicit-any
    const items: any[] = [];
    for (const itemId of ids) {
      const e = existing[itemId];
      if (!e) return json({ error: "could not issue item: " + itemId }, 500);
      const b = built[itemId];
      items.push({
        item_id: itemId, attempt_id: e.id, prompt: b.prompt, options: b.options,
        item_type: b.item_type, points: b.points, figure: b.figure,
        previously_submitted: e._new ? null : e.submitted_value,
      });
    }
    return json({ items });
  }

  /* ============ STUDENT: GRADE A WHOLE EXAM IN ONE CALL (2026-11-02) =========
     Same per-item rules as "grade" below, one attempt lookup and ONE write
     (fd_apply_exam_grades). Per-entry problems come back as {attempt_id,error}
     so the client regrades just those through the single-item path. */
  if (action === "grade_batch") {
    const answers = Array.isArray(p.answers) ? p.answers : [];
    if (answers.length === 0 || answers.length > 150) return json({ error: "answers must hold 1-150 entries" }, 400);
    // deno-lint-ignore no-explicit-any
    const reqs = answers.map(function (a: any) {
      return { attempt_id: String((a && a.attempt_id) || ""), submitted: (a && a.submitted_value != null) ? String(a.submitted_value) : "" };
    });
    const ids = reqs.map(function (r: { attempt_id: string }) { return r.attempt_id; }).filter(function (x: string) { return !!x; });
    const { data: attRows } = await admin.from("fd_exam_attempt")
      .select("id,student_id,course_id,exam_id,item_id,generator_id,seed,points_possible,graded_at")
      .in("id", ids);
    // deno-lint-ignore no-explicit-any
    const attById: Record<string, any> = {};
    for (const a of (attRows ?? [])) attById[a.id] = a;
    const authoredIds: string[] = [];
    for (const a of (attRows ?? [])) {
      if (!(a.generator_id && a.seed != null) && a.item_id && authoredIds.indexOf(a.item_id) < 0) authoredIds.push(a.item_id);
    }
    // deno-lint-ignore no-explicit-any
    const keyById: Record<string, any> = {};
    // deno-lint-ignore no-explicit-any
    const itemById: Record<string, any> = {};
    if (authoredIds.length) {
      const { data: ks } = await admin.from("fd_assessment_item_key").select("item_id,correct_value").in("item_id", authoredIds);
      for (const k of (ks ?? [])) keyById[k.item_id] = k;
      const { data: its } = await admin.from("fd_assessment_item").select("id,item_type,points").in("id", authoredIds);
      for (const it of (its ?? [])) itemById[it.id] = it;
    }
    // deno-lint-ignore no-explicit-any
    const results: any[] = [];
    // deno-lint-ignore no-explicit-any
    const writes: any[] = [];
    for (const r of reqs) {
      const att = attById[r.attempt_id];
      if (!r.attempt_id || !att) { results.push({ attempt_id: r.attempt_id, error: "attempt not found" }); continue; }
      if (att.student_id !== uid) { results.push({ attempt_id: r.attempt_id, error: "not your attempt" }); continue; }
      const submitted = r.submitted;
      if (att.generator_id && att.seed != null) {
        const q = MA.generate(att.generator_id, Number(att.seed));
        if (!q) { results.push({ attempt_id: r.attempt_id, error: "could not regenerate item" }); continue; }
        if (q.kind === "short") {
          writes.push({ id: att.id, student_id: uid, submitted_value: submitted, is_correct: null, points_earned: null, graded: false });
          results.push({ attempt_id: r.attempt_id, ok: true, pending: true });
          continue;
        }
        const g = MA.grade(att.generator_id, Number(att.seed), submitted);
        const ok = !!g.correct;
        writes.push({ id: att.id, student_id: uid, submitted_value: submitted, is_correct: ok, points_earned: ok ? (q.points ?? 1) : 0, graded: true });
        results.push({ attempt_id: r.attempt_id, ok: true, correct: ok });
        continue;
      }
      const key = keyById[att.item_id];
      const item = itemById[att.item_id];
      if (!key || key.correct_value == null || (item && item.item_type === "short")) {
        writes.push({ id: att.id, student_id: uid, submitted_value: submitted, is_correct: null, points_earned: null, graded: false });
        results.push({ attempt_id: r.attempt_id, ok: true, pending: true });
        continue;
      }
      let ok = false;
      if (item && item.item_type === "numeric") {
        const cleaned = submitted.replace(/[,\s$%]/g, "");
        const v = parseFloat(cleaned);
        const expect = parseFloat(String(key.correct_value));
        ok = !isNaN(v) && !isNaN(expect) && Math.abs(v - expect) <= 0.01;
      } else {
        ok = String(submitted).trim() === String(key.correct_value).trim();
      }
      writes.push({ id: att.id, student_id: uid, submitted_value: submitted, is_correct: ok,
                    points_earned: ok ? Number(att.points_possible ?? item?.points ?? 1) : 0, graded: true });
      results.push({ attempt_id: r.attempt_id, ok: true, correct: ok });
    }
    if (writes.length) {
      const { error } = await admin.rpc("fd_apply_exam_grades", { p_rows: writes });
      if (error) return json({ error: "could not save grades: " + error.message }, 500);
    }
    return json({ results });
  }

  /* ====================== STUDENT: ISSUE ONE QUESTION ===================== */
  if (action === "issue") {
    const itemId = p.item_id, courseId = p.course_id ?? null, examId = p.exam_id ?? null;
    if (!itemId) return json({ error: "item_id required" }, 400);
    if (!courseId || !(await enrolledIn(courseId))) {
      return json({ error: "no active enrollment", code: "ENROLL_REQUIRED" }, 403);
    }

    const { data: item } = await admin.from("fd_assessment_item")
      .select("id,chapter,item_type,points,prompt,options,generator_id,seed")
      .eq("id", itemId).maybeSingle();
    if (!item) return json({ error: "item not found" }, 404);

    const built = buildItem(item, uid, examId);
    if (!built) return json({ error: "could not build that item" }, 500);

    // Reissuing the same item must return the SAME attempt row, not a new one.
    // Otherwise a student who refreshes mid-exam silently accumulates duplicate
    // rows and the exam total inflates.
    const { data: existing } = await admin.from("fd_exam_attempt")
      .select("id,submitted_value")
      .eq("student_id", uid).eq("item_id", itemId)
      .eq("exam_id", examId).limit(1);

    let attemptId: string;
    if (existing && existing.length) {
      attemptId = existing[0].id;
    } else {
      const { data: ins, error } = await admin.from("fd_exam_attempt").insert({
        course_id: courseId, exam_id: examId, item_id: itemId, student_id: uid,
        chapter: item.chapter ?? null,
        generator_id: built.generator_id, seed: built.seed,
        points_possible: built.points, created_at: new Date().toISOString(),
      }).select("id").single();
      if (error) return json({ error: "could not issue item: " + error.message }, 500);
      attemptId = ins.id;
    }

    // Note what is NOT in this response: answer, rubric, rationale.
    return json({
      attempt_id: attemptId,
      prompt: built.prompt,
      options: built.options,
      item_type: built.item_type,
      points: built.points,
      figure: built.figure,
      previously_submitted: existing && existing.length ? existing[0].submitted_value : null,
    });
  }

  /* ====================== STUDENT: GRADE ONE ANSWER ====================== */
  if (action === "grade") {
    const attemptId = p.attempt_id;
    if (!attemptId) return json({ error: "attempt_id required" }, 400);

    const { data: att } = await admin.from("fd_exam_attempt")
      .select("id,student_id,course_id,exam_id,item_id,generator_id,seed,points_possible,graded_at")
      .eq("id", attemptId).maybeSingle();
    if (!att) return json({ error: "attempt not found" }, 404);
    if (att.student_id !== uid) return json({ error: "not your attempt" }, 403);

    const submitted = p.submitted_value == null ? "" : String(p.submitted_value);
    const nowIso = new Date().toISOString();

    // Bank item: regenerate and grade deterministically.
    if (att.generator_id && att.seed != null) {
      const q = MA.generate(att.generator_id, Number(att.seed));
      if (!q) return json({ error: "could not regenerate item" }, 500);

      if (q.kind === "short") {
        await admin.from("fd_exam_attempt").update({
          submitted_value: submitted, is_correct: null, points_earned: null,
        }).eq("id", attemptId);
        return json({ ok: true, pending: true });
      }
      const r = MA.grade(att.generator_id, Number(att.seed), submitted);
      const ok = !!r.correct;
      await admin.from("fd_exam_attempt").update({
        submitted_value: submitted, is_correct: ok,
        points_earned: ok ? (q.points ?? 1) : 0, graded_at: nowIso,
      }).eq("id", attemptId);
      return json({ ok: true, correct: ok });
    }

    // Authored item: the key lives in fd_assessment_item_key, which has no RLS
    // policy, so only this service-role path can read it.
    const { data: key } = await admin.from("fd_assessment_item_key")
      .select("correct_value").eq("item_id", att.item_id).maybeSingle();
    const { data: item } = await admin.from("fd_assessment_item")
      .select("item_type,points").eq("id", att.item_id).maybeSingle();

    if (!key || key.correct_value == null || (item && item.item_type === "short")) {
      await admin.from("fd_exam_attempt").update({
        submitted_value: submitted, is_correct: null, points_earned: null,
      }).eq("id", attemptId);
      return json({ ok: true, pending: true });
    }

    let ok = false;
    if (item && item.item_type === "numeric") {
      const cleaned = submitted.replace(/[,\s$%]/g, "");
      const v = parseFloat(cleaned);
      const expect = parseFloat(String(key.correct_value));
      ok = !isNaN(v) && !isNaN(expect) && Math.abs(v - expect) <= 0.01;
    } else {
      ok = String(submitted).trim() === String(key.correct_value).trim();
    }
    await admin.from("fd_exam_attempt").update({
      submitted_value: submitted, is_correct: ok,
      points_earned: ok ? Number(att.points_possible ?? item?.points ?? 1) : 0,
      graded_at: nowIso,
    }).eq("id", attemptId);
    return json({ ok: true, correct: ok });
  }

  /* ====================== STUDENT: RESUME AN EXAM ======================== */
  if (action === "resume") {
    const examId = p.exam_id;
    if (!examId) return json({ error: "exam_id required" }, 400);
    const { data } = await admin.from("fd_exam_attempt")
      .select("id,item_id,generator_id,seed,submitted_value,graded_at")
      .eq("student_id", uid).eq("exam_id", examId).order("created_at");
    return json({ ok: true, items: data ?? [] });
  }

  /* ====================== STUDENT: POST-EXAM REVIEW ====================== */
  if (action === "review") {
    const examId = p.exam_id, courseId = p.course_id;
    if (!examId) return json({ error: "exam_id required" }, 400);

    const { data: course } = await admin.from("fd_course")
      .select("review_exams,owner_id").eq("id", courseId).maybeSingle();
    const staff = await isStaff(courseId);
    if (!staff && !(course && course.review_exams)) {
      return json({ error: "Review for this exam is not open yet." }, 403);
    }

    const { data: rows } = await admin.from("fd_exam_attempt")
      .select("id,item_id,generator_id,seed,submitted_value,is_correct,points_earned,ai_feedback,graded_at")
      .eq("student_id", uid).eq("exam_id", examId).order("created_at");

    // deno-lint-ignore no-explicit-any
    const out = (rows ?? []).map(function (r: any) {
      let prompt = "", correctOption: string | null = null, notes: string | null = null, kind = "auto";
      if (r.generator_id && r.seed != null) {
        const q = MA.generate(r.generator_id, Number(r.seed));
        if (q) {
          prompt = q.prompt;
          kind = q.kind === "short" ? "written" : "auto";
          if (q.kind === "mc" && q.options && q.answer != null) {
            correctOption = q.options[Number(q.answer)] ?? null;
          } else if (q.kind === "numeric") {
            correctOption = q.answer == null ? null : String(q.answer);
          }
          notes = r.ai_feedback ?? q.rationale ?? null;
        }
      }
      return {
        id: r.id, item_id: r.item_id, item_type: kind, prompt,
        your_answer: r.submitted_value, correct_option: correctOption,
        answer_notes: notes,
        message: r.graded_at ? null : "Awaiting instructor review",
      };
      // Only items the student did NOT get right are worth reviewing.
      // deno-lint-ignore no-explicit-any
    }).filter(function (_x: any, i: number) { return (rows ?? [])[i].is_correct !== true; });

    return json(out);
  }

  /* ====================== INSTRUCTOR: PREVIEW AN ITEM ==================== */
  if (action === "preview") {
    const itemId = p.item_id;
    const { data: item } = await admin.from("fd_assessment_item")
      .select("id,course_id,chapter,item_type,points,prompt,options,generator_id,seed")
      .eq("id", itemId).maybeSingle();
    if (!item) return json({ error: "item not found" }, 404);
    if (!(await isStaff(item.course_id))) return json({ error: "not permitted" }, 403);

    const built = buildItem(item, "preview", null);
    if (!built) return json({ error: "could not build that item" }, 500);
    const { data: key } = await admin.from("fd_assessment_item_key")
      .select("correct_value,model_answer,rubric,rationale").eq("item_id", itemId).maybeSingle();

    let answer: unknown = key?.correct_value ?? null;
    if (item.generator_id) {
      const q = MA.generate(item.generator_id, built.seed as number);
      answer = q ? q.answer : null;
    }
    // Staff-only path, so the answer IS included here.
    return json({
      prompt: built.prompt, options: built.options, item_type: built.item_type,
      points: built.points, figure: built.figure,
      answer, rubric: built.rubric ?? key?.rubric ?? null,
      rationale: built.rationale ?? key?.rationale ?? null,
    });
  }

  /* ====================== INSTRUCTOR: A STUDENT'S WORK =================== */
  if (action === "student_work" || action === "quiz_work" || action === "arena_work") {
    const studentId = String(p.student_id || "");
    let courseId = p.course_id ?? null;

    if (action === "student_work") {
      const { data: ex } = await admin.from("fd_exam").select("course_id").eq("id", p.exam_id).maybeSingle();
      courseId = ex ? ex.course_id : courseId;
    }
    if (!(await isStaff(courseId))) return json({ error: "not permitted" }, 403);

    if (action === "arena_work") {
      // The regrade screen needs the row id (it had none, so Save wrote to
      // "wa_undefined" and updated nothing) and names the fields it renders.
      // Simulation runs carry score_pct and are regraded as a percentage.
      const { data, error } = await admin.from("fd_attempt")
        .select("id,case_index,is_correct,score_pct,prompt_text,chosen_label,correct_label,submitted," +
                "created_at,attempt_no,regrade_note,regraded_at,regraded_by")
        .eq("user_id", studentId).eq("arena_slug", p.arena_slug)
        .order("attempt_no").order("case_index");
      if (error) return json({ error: "could not load arena work: " + error.message }, 500);
      // deno-lint-ignore no-explicit-any
      const items = (data ?? []).map(function (r: any) {
        return {
          attempt_id: r.id, attempt_no: r.attempt_no, case_index: r.case_index,
          is_correct: r.is_correct, score_pct: r.score_pct,
          sim: r.score_pct !== null && r.score_pct !== undefined,
          prompt_text: r.prompt_text,
          your_answer: r.chosen_label ?? r.submitted ?? null,
          correct_answer: r.correct_label ?? null,
          attempted_at: r.created_at,
          regrade_note: r.regrade_note, regraded_at: r.regraded_at, regraded_by: r.regraded_by,
        };
      });
      return json({ items });
    }

    let q = admin.from("fd_exam_attempt")
      .select("id,item_id,exam_id,chapter,generator_id,seed,submitted_value,is_correct," +
              "points_earned,points_possible,ai_score,ai_feedback,ai_graded_at,graded_at,created_at")
      .eq("student_id", studentId);
    if (action === "student_work") { q = q.eq("exam_id", p.exam_id); }
    else {
      q = q.is("exam_id", null).eq("course_id", courseId);
      if (p.chapter != null) { q = q.eq("chapter", Number(p.chapter)); }
    }
    const { data: rows, error } = await q.order("created_at");
    if (error) return json({ error: error.message }, 500);

    // Regenerate each prompt so the instructor sees the question the STUDENT saw,
    // with their own seed — not a fresh random instance.
    // deno-lint-ignore no-explicit-any
    const items = (rows ?? []).map(function (r: any) {
      let prompt = "", model: string | null = null, kind = "auto", answer: unknown = null;
      if (r.generator_id && r.seed != null) {
        const built = MA.generate(r.generator_id, Number(r.seed));
        if (built) {
          prompt = built.prompt;
          kind = built.kind === "short" ? "written" : built.kind;
          model = built.rubric ?? built.rationale ?? null;
          answer = built.answer;
        }
      }
      return {
        attempt_id: r.id, item_id: r.item_id, chapter: r.chapter,
        prompt, model, item_type: kind, answer,
        submitted: r.submitted_value, is_correct: r.is_correct,
        points: r.points_earned, points_possible: r.points_possible,
        ai_score: r.ai_score, ai_feedback: r.ai_feedback,
        graded: r.graded_at != null, created_at: r.created_at,
      };
    });
    return json({ items });
  }

  /* ============ INSTRUCTOR: UNGRADED WRITTEN QUIZ ANSWERS =============== */
  if (action === "quiz_review") {
    const courseId = p.course_id;
    if (!(await isStaff(courseId))) return json({ error: "not permitted" }, 403);

    let q = admin.from("fd_exam_attempt")
      .select("id,student_id,chapter,generator_id,seed,submitted_value,points_possible,created_at")
      .eq("course_id", courseId).is("exam_id", null).is("graded_at", null);
    if (p.chapter != null) { q = q.eq("chapter", Number(p.chapter)); }
    const { data: rows } = await q.order("created_at").limit(500);

    // deno-lint-ignore no-explicit-any
    const items = (rows ?? []).map(function (r: any) {
      const built = (r.generator_id && r.seed != null) ? MA.generate(r.generator_id, Number(r.seed)) : null;
      return {
        attempt_id: r.id, student_id: r.student_id, chapter: r.chapter,
        prompt: built ? built.prompt : r.generator_id,
        model: built ? (built.rubric ?? built.rationale ?? null) : null,
        points: r.points_possible ?? (built ? built.points : 1),
        submitted: r.submitted_value, created_at: r.created_at,
        // Only truly written items belong in this queue.
        is_written: built ? built.kind === "short" : true,
      };
      // deno-lint-ignore no-explicit-any
    }).filter(function (x: any) { return x.is_written; });

    return json({ items });
  }

  return json({ error: "unknown action: " + action }, 400);
});
