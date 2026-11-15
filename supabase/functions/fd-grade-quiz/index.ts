

// ============================================================================
//  fd-grade-quiz  —  server-side grading for Financial Derivatives chapter
//  quizzes and exams.
//
//  Receives a list of answered questions, each identified by { generator_id,
//  seed, submitted }. For each, it REGENERATES the exact question the student
//  saw (same generator + same seed => same parameters => same correct answer)
//  and grades it. Correct answers never leave the server.
//
//  ---------------------------------------------------------------------------
//  HOW THIS DIFFERS FROM im-grade-quiz, AND WHY
//
//  im-grade-quiz keeps a hand-maintained MIRROR of the browser's generator file
//  inline in the function. That mirror drifted from the original in a way that
//  silently corrupted grading: its written items lost their prompts and rubrics
//  entirely, leaving stubs like
//        ch4_written_shortage: { kind:"short", points:3, prompt:"ch4_written_shortage" }
//  so the AI grader was asked to score an answer against the question text
//  "ch4_written_shortage" and an empty rubric — and then stamped graded_at and
//  points_earned, which also removed the item from the instructor's ungraded
//  queue. Nobody would notice from the outside.
//
//  This function instead IMPORTS the real generator files. There is exactly one
//  definition of every question, shared by the browser and the server, so the
//  two cannot disagree. Deploy the .js files alongside this index.ts.
//  ---------------------------------------------------------------------------
//
//  Deploy:
//    supabase/functions/fd-grade-quiz/
//      index.ts               <- this file
//      fd-generators.js       <- engine + chapters 7-12
//      fd-generators-b.js     <- chapters 13-18
//      fd-generators-c.js     <- chapters 1-6
//      fd-generators-d.js     <- depth pack
//    supabase functions deploy fd-grade-quiz
//
//  Env:
//    SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//    AI grading for written answers (optional — pick ONE provider, or none):
//      ANTHROPIC_API_KEY  -> grade with Claude
//      GEMINI_API_KEY     -> grade with Google Gemini
//      AI_PROVIDER        -> 'anthropic' | 'gemini' to force one when both set
//      ANTHROPIC_MODEL / GEMINI_MODEL -> override the default model id
//    With no key set, written answers are stored unGRADED for instructor review,
//    which is the correct fallback: a written item with no grader must land in
//    the queue, never be silently scored.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Side-effect imports: each file installs itself onto globalThis.FDGenerators.
// fd-generators.js must come first — it defines the engine and register().
import "./fd-generators.js";
type Built = {
  id: string;
  kind: "numeric" | "mc" | "short";
  render?: string;
  chapter?: number;
  difficulty?: string;
  concept?: string;
  points: number;
  prompt: string;
  rubric?: string;
  rationale?: string;
  options?: string[];
  answer: number | null;
  tolerance?: number;
  seed?: number | null;
};

type GenApi = {
  generate: (id: string, seed: number) => Built | null;
  grade: (id: string, seed: number, submitted: string) =>
    { correct?: boolean; points?: number; expected?: unknown; needsAI?: boolean; error?: string };
  list: () => Array<{ id: string; chapter: number; kind: string }>;
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

// ---------------------------------------------------------------------------
//  AI grading for written answers.
//
//  The prompt and rubric passed in come from the REAL generator definition, so
//  the model sees the question the student actually answered and the rubric the
//  instructor actually wrote.
// ---------------------------------------------------------------------------
function buildGradingPrompt(prompt: string, rubric: string, answer: string, maxPoints: number) {
  const sys =
    "You are grading a short written answer in an undergraduate or MBA financial derivatives course. " +
    "Grade STRICTLY against the rubric provided — do not invent additional criteria and do " +
    "not award credit for correct economics the rubric does not ask for. Award partial credit " +
    "element by element as the rubric directs. " +
    'Return strict JSON only: {"score": <number 0..' + maxPoints +
    '>, "feedback": "<one or two sentences naming which rubric elements were met and which were missing>"}. ' +
    "No prose outside the JSON.";
  const user =
    "QUESTION:\n" + prompt +
    "\n\nRUBRIC:\n" + rubric +
    "\n\nSTUDENT ANSWER:\n" + answer +
    "\n\nMaximum points: " + maxPoints + ".";
  return { sys, user };
}

function parseGrade(text: string, maxPoints: number): { score: number; feedback: string } | null {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    let sc = Number(parsed.score);
    if (isNaN(sc)) return null;
    sc = Math.max(0, Math.min(maxPoints, sc));
    return { score: sc, feedback: String(parsed.feedback || "") };
  } catch {
    return null;
  }
}

async function gradeWithAnthropic(key: string, sys: string, user: string, maxPoints: number) {
  const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      system: sys,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    try { console.error("anthropic grading HTTP " + res.status + ": " + (await res.text()).slice(0, 300)); } catch { /* ignore */ }
    return null;
  }
  const data = await res.json();
  // deno-lint-ignore no-explicit-any
  const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return parseGrade(text, maxPoints);
}

async function gradeWithGemini(key: string, sys: string, user: string, maxPoints: number) {
  // NOTE: the micro function defaulted to gemini-1.5-flash, which is now well
  // behind the current line. A retired model id fails silently and every written
  // answer falls through to "pending review", which looks like nothing happening.
  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash";
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + key;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sys }] },
      contents: [{ parts: [{ text: user }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 400, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) {
    try { console.error("gemini grading HTTP " + res.status + " (model " + model + "): " + (await res.text()).slice(0, 300)); } catch { /* ignore */ }
    return null;
  }
  const data = await res.json();
  let text = "";
  try {
    // deno-lint-ignore no-explicit-any
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts) || [];
    // deno-lint-ignore no-explicit-any
    text = parts.map((p: any) => p.text || "").join("");
  } catch { text = ""; }
  return parseGrade(text, maxPoints);
}

async function gradeWritten(
  prompt: string, rubric: string, answer: string, maxPoints: number,
): Promise<{ score: number; feedback: string } | null> {
  if (!answer || !answer.trim()) return null;

  // A written item with no rubric cannot be graded fairly. Rather than asking a
  // model to invent criteria, send it to the instructor. This is the guard that
  // would have caught the micro function's stripped-rubric bug on day one.
  if (!rubric || rubric.trim().length < 40) {
    try { console.error("fd-grade-quiz: written item has no usable rubric; routing to instructor review. prompt=" + prompt.slice(0, 80)); } catch { /* ignore */ }
    return null;
  }
  // Same guard for the prompt: if it looks like a bare generator id rather than
  // a question, something has gone wrong upstream.
  if (!prompt || prompt.length < 25 || /^[a-z0-9_]+$/.test(prompt)) {
    try { console.error("fd-grade-quiz: written item prompt looks like an id, not a question: " + prompt); } catch { /* ignore */ }
    return null;
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  const override = (Deno.env.get("AI_PROVIDER") || "").toLowerCase();

  let provider: "anthropic" | "gemini" | null = null;
  if (override === "anthropic" && anthropicKey) provider = "anthropic";
  else if (override === "gemini" && geminiKey) provider = "gemini";
  else if (!override && anthropicKey) provider = "anthropic";
  else if (!override && geminiKey) provider = "gemini";
  if (!provider) return null; // no key configured -> pending instructor review

  const { sys, user } = buildGradingPrompt(prompt, rubric, answer, maxPoints);
  try {
    if (provider === "anthropic") return await gradeWithAnthropic(anthropicKey!, sys, user, maxPoints);
    return await gradeWithGemini(geminiKey!, sys, user, maxPoints);
  } catch (e) {
    try { console.error("fd-grade-quiz: AI grading threw, routing to instructor review:", e); } catch { /* ignore */ }
    return null;
  }
}

// ---------------------------------------------------------------------------
interface Item { generator_id: string; seed: number; submitted: string }
interface Payload {
  exam_id?: string;
  chapter?: number;
  course_id?: string;
  attempt_no?: number;
  items: Item[];
}

const QUIZ_PASS = 0.7;

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
  if (!p || !Array.isArray(p.items) || p.items.length === 0) {
    return json({ error: "items[] required" }, 400);
  }

  const admin = createClient(url, service);

  // -------------------------------------------------------------------------
  // ACCESS GATE + COURSE RESOLUTION
  //
  // The micro version did:
  //     .from("im_enrollment").select("status").eq("user_id", userId).maybeSingle()
  // which has two faults. It is not scoped to a course, and maybeSingle() ERRORS
  // when more than one row comes back — so any student enrolled in two sections,
  // or in a self-study course alongside a professor's course, was refused with
  // "no active enrollment" on every single submission. Fetch the rows and pick.
  // -------------------------------------------------------------------------
  const { data: enrollRows, error: enrollErr } = await admin
    .from("fd_enrollment")
    .select("course_id,status")
    .eq("student_id", userId)
    .eq("status", "active");

  if (enrollErr) {
    return json({ error: "could not verify enrollment: " + enrollErr.message }, 500);
  }
  const active: Array<{ course_id: string; status: string }> = (enrollRows ?? []) as Array<{ course_id: string; status: string }>;
  if (active.length === 0) {
    return json({ error: "no active enrollment", code: "ENROLL_REQUIRED" }, 403);
  }

  let courseId: string | null = null;
  if (p.course_id) {
    // Client named a course: it must be one the student is actually enrolled in.
    const match = active.filter(function (r) { return r.course_id === p.course_id; });
    if (match.length === 0) {
      return json({ error: "not enrolled in that course", code: "ENROLL_REQUIRED" }, 403);
    }
    courseId = p.course_id;
  } else if (active.length === 1) {
    courseId = active[0].course_id;
  } else {
    // Genuinely ambiguous. Refuse rather than guessing: attributing a quiz to the
    // wrong section silently corrupts that section's gradebook.
    return json({
      error: "multiple active enrollments — course_id required",
      code: "COURSE_REQUIRED",
      courses: active.map(function (r) { return r.course_id; }),
    }, 400);
  }

  // fd_exam_attempt.course_id is NOT NULL by design, so this must be resolved
  // before any row is written.
  if (!courseId) {
    return json({ error: "could not resolve a course for this attempt" }, 400);
  }

  // -------------------------------------------------------------------------
  // GRADE
  // -------------------------------------------------------------------------
  let score = 0;               // points earned on items that were graded
  let gradedPossible = 0;      // points available on items that were graded
  let totalPossible = 0;       // points available across every item
  let pending = 0;             // count of items awaiting instructor review
  let pendingPoints = 0;
  const rows: Record<string, unknown>[] = [];
  const nowIso = new Date().toISOString();
  const attemptNo = (typeof p.attempt_no === "number" && p.attempt_no >= 1) ? p.attempt_no : 1;
  const unknownIds: string[] = [];

  for (const it of p.items) {
    const q = MA.generate(it.generator_id, it.seed);
    if (!q) { unknownIds.push(it.generator_id); continue; }
    totalPossible += q.points;

    const base = {
      course_id: courseId,
      exam_id: p.exam_id ?? null,
      student_id: userId,
      attempt_no: attemptNo,
      generator_id: it.generator_id,
      seed: it.seed,
      submitted_value: it.submitted ?? null,
      points_possible: q.points,
      created_at: nowIso,
    };

    if (q.kind === "short") {
      const ai = await gradeWritten(q.prompt, q.rubric || "", it.submitted || "", q.points);
      if (ai) {
        score += ai.score;
        gradedPossible += q.points;
        rows.push({
          ...base,
          is_correct: null,
          points_earned: ai.score,
          ai_score: ai.score,
          ai_feedback: ai.feedback,
          ai_graded_at: nowIso,
          graded_at: nowIso,
        });
      } else {
        pending++;
        pendingPoints += q.points;
        // points_earned and graded_at stay NULL: that is what puts the item in
        // the instructor's ungraded queue.
        rows.push({ ...base, is_correct: null, points_earned: null });
      }
      continue;
    }

    // MC and numeric grade deterministically through the SAME grade() the
    // browser uses, so answer normalization ("$32,000" -> 32000) is identical.
    const res = MA.grade(it.generator_id, it.seed, it.submitted);
    const ok = !!res.correct;
    if (ok) score += q.points;
    gradedPossible += q.points;
    rows.push({
      ...base,
      is_correct: ok,
      points_earned: ok ? q.points : 0,
      graded_at: nowIso,
    });
  }

  if (unknownIds.length) {
    try { console.error("fd-grade-quiz: unknown generator id(s) skipped: " + unknownIds.join(", ")); } catch { /* ignore */ }
  }
  if (rows.length === 0) {
    return json({ error: "no gradable items in submission", unknown: unknownIds }, 400);
  }

  const { error: insErr } = await admin.from("fd_exam_attempt").insert(rows);
  if (insErr) return json({ error: "could not save attempt: " + insErr.message }, 500);

  // -------------------------------------------------------------------------
  // CHAPTER-QUIZ PROGRESS
  //
  // Score the graded portion only. The micro version divided by the FULL point
  // total including items still awaiting review, which recorded an artificially
  // low quiz_score the moment a quiz contained a written question — and then set
  // quiz_passed from that same depressed number. Here the fraction is computed
  // over what was actually graded, the pending count is stored, and
  // fd_recompute_quiz_score() (in fd_02_grading.sql) recomputes both once the
  // instructor grades the written items.
  //
  // An exam (exam_id present) does not touch chapter progress.
  // -------------------------------------------------------------------------
  if (!p.exam_id && p.chapter !== undefined && p.chapter !== null) {
    const frac = gradedPossible > 0 ? (score / gradedPossible) : 0;

    const { data: prior } = await admin
      .from("fd_chapter_progress")
      .select("quiz_score,quiz_attempts")
      .eq("student_id", userId).eq("course_id", courseId).eq("chapter", p.chapter)
      .maybeSingle();

    const priorScore = (prior && prior.quiz_score !== null && prior.quiz_score !== undefined)
      ? Number(prior.quiz_score) : -1;
    const priorAttempts = (prior && prior.quiz_attempts) ? Number(prior.quiz_attempts) : 0;
    const keepFrac = Math.max(priorScore, frac);   // best score across attempts

    const { error: progErr } = await admin
      .from("fd_chapter_progress")
      .upsert({
        student_id: userId,
        course_id: courseId,
        chapter: p.chapter,
        reading_done: true,
        quiz_score: keepFrac,
        quiz_passed: keepFrac >= QUIZ_PASS,
        quiz_attempts: priorAttempts + 1,
        quiz_pending: pending,
        updated_at: nowIso,
      }, { onConflict: "student_id,course_id,chapter" });

    if (progErr) {
      // The attempt itself saved, so report success with a warning rather than
      // failing the whole submission and inviting a duplicate re-submit.
      return json({
        ok: true, score, total: gradedPossible, total_all: totalPossible,
        pending, pending_points: pendingPoints,
        progress_warning: progErr.message,
      });
    }
  }

  return json({
    ok: true,
    score,
    total: gradedPossible,      // what the reported score is out of
    total_all: totalPossible,   // including items awaiting review
    pending,
    pending_points: pendingPoints,
  });
});
