

// ============================================================================
//  fd-ai-grade — instructor-triggered AI grading of written work.
//
//  This is the INSTRUCTOR path, distinct from the automatic grading inside
//  fd-grade-quiz. Here the instructor asks for a proposal, reads it, and
//  finalizes it. Nothing this function writes counts toward a grade until a
//  human calls finalize: propose writes only ai_score / ai_feedback and leaves
//  points_earned and graded_at untouched, so the item stays in the ungraded
//  queue until it is confirmed.
//
//  That separation is the point. The micro build's automatic path stamped
//  graded_at while grading against an empty rubric, which removed the item from
//  the instructor's queue — the score looked reviewed when nobody had seen it.
//
//  Actions:
//    propose            { course_id, attempt_id? }  -> next ungraded item, or that one
//    propose_quiz_item  { attempt_id, prompt, model_answer, points }
//    propose_assignment { submission_id }
//    finalize           { attempt_id, points, feedback }
//    finalize_all       { course_id }   -> accept every pending AI proposal
//
//  Uses the INSTRUCTOR'S OWN key from fd_grader_key (provider + api_key + model),
//  falling back to the function's env keys. A TA grading in a course they do not
//  own therefore uses the owner's key, which is why the owner is looked up
//  rather than the caller.
//
//  Env (fallback only): ANTHROPIC_API_KEY, GEMINI_API_KEY, AI_PROVIDER
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Side-effect imports: each installs itself onto globalThis.FDGenerators, and
// fd-generators.js must come first because it defines the engine and register().
// These exist so `propose` can regenerate an item's prompt and rubric from its
// generator_id + seed when the caller sends only an attempt id. Without them the
// fallback silently finds no generator, and every such call fails the rubric
// check below with "no usable rubric" — which reads as a broken item rather than
// a missing deploy file.
import "./fd-generators.js";
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

function parseGrade(text: string, maxPoints: number): { score: number; feedback: string } | null {
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    let sc = Number(parsed.score);
    if (isNaN(sc)) return null;
    sc = Math.max(0, Math.min(maxPoints, sc));
    return { score: sc, feedback: String(parsed.feedback || "") };
  } catch { return null; }
}

async function callLLM(
  provider: string, key: string, model: string | null,
  sys: string, user: string, maxPoints: number,
): Promise<{ score: number; feedback: string } | null> {
  try {
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: model || "claude-sonnet-4-6", max_tokens: 400,
          system: sys, messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) {
        try { console.error("anthropic HTTP " + res.status + ": " + (await res.text()).slice(0, 300)); } catch { /* ignore */ }
        return null;
      }
      const d = await res.json();
      // deno-lint-ignore no-explicit-any
      const t = (d.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      return parseGrade(t, maxPoints);
    }
    // Gemini. The micro function pinned a model id that has since been retired,
    // which failed silently and looked like "AI grading does nothing".
    const m = model || "gemini-3.6-flash";
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent?key=" + key,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sys }] },
          contents: [{ parts: [{ text: user }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 400, responseMimeType: "application/json" },
        }),
      });
    if (!res.ok) {
      try { console.error("gemini HTTP " + res.status + " (model " + m + "): " + (await res.text()).slice(0, 300)); } catch { /* ignore */ }
      return null;
    }
    const d = await res.json();
    const parts = d?.candidates?.[0]?.content?.parts || [];
    // deno-lint-ignore no-explicit-any
    return parseGrade(parts.map((x: any) => x.text || "").join(""), maxPoints);
  } catch (e) {
    try { console.error("callLLM threw:", e); } catch { /* ignore */ }
    return null;
  }
}

function buildPrompt(prompt: string, rubric: string, answer: string, maxPoints: number) {
  const sys =
    "You are assisting an instructor grading a written answer in an undergraduate " +
    "financial derivatives course. Grade STRICTLY against the rubric. Do not invent criteria and " +
    "do not award credit for correct economics the rubric does not ask for. Award partial " +
    "credit element by element. Your score is a PROPOSAL a human will review. " +
    'Return strict JSON only: {"score": <0..' + maxPoints + '>, "feedback": "<one or two ' +
    'sentences naming the rubric elements met and missing>"}.';
  const user = "QUESTION:\n" + prompt + "\n\nRUBRIC:\n" + rubric +
    "\n\nSTUDENT ANSWER:\n" + answer + "\n\nMaximum points: " + maxPoints + ".";
  return { sys, user };
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

  async function canGrade(courseId: string | null): Promise<boolean> {
    if (!courseId) return false;
    const { data: c } = await admin.from("fd_course").select("owner_id").eq("id", courseId).maybeSingle();
    if (c && c.owner_id === uid) return true;
    const { data: me } = await admin.from("fd_person").select("role").eq("user_id", uid).maybeSingle();
    if (me && me.role === "admin") return true;
    const { data: s } = await admin.from("fd_course_staff")
      .select("can_grade").eq("course_id", courseId).eq("user_id", uid).maybeSingle();
    return !!(s && s.can_grade);
  }

  /* The key belongs to the course OWNER, not the caller: a TA has grading rights
     but no reason to hold an API key. */
  async function keyFor(courseId: string | null) {
    let ownerId = uid;
    if (courseId) {
      const { data: c } = await admin.from("fd_course").select("owner_id").eq("id", courseId).maybeSingle();
      if (c && c.owner_id) ownerId = c.owner_id;
    }
    const { data: k } = await admin.from("fd_grader_key")
      .select("provider,api_key,model").eq("owner_id", ownerId).maybeSingle();
    if (k && k.api_key) {
      return { provider: (k.provider || "google") === "anthropic" ? "anthropic" : "gemini",
               key: k.api_key, model: k.model || null };
    }
    const ak = Deno.env.get("ANTHROPIC_API_KEY"), gk = Deno.env.get("GEMINI_API_KEY");
    const override = (Deno.env.get("AI_PROVIDER") || "").toLowerCase();
    if ((override === "anthropic" || !override) && ak) return { provider: "anthropic", key: ak, model: null };
    if (gk) return { provider: "gemini", key: gk, model: null };
    return null;
  }

  /* ======================= propose on a quiz/exam item ================== */
  if (action === "propose" || action === "propose_quiz_item") {
    let attemptId = p.attempt_id ?? null;
    let courseId = p.course_id ?? null;

    if (!attemptId) {
      // Pick the next ungraded written answer in the course.
      if (!(await canGrade(courseId))) return json({ error: "not permitted" }, 403);
      const { data: rows } = await admin.from("fd_exam_attempt")
        .select("id").eq("course_id", courseId).is("graded_at", null)
        .not("submitted_value", "is", null).order("created_at").limit(1);
      if (!rows || !rows.length) {
        return json({ ok: true, message: "Nothing left to review.", remaining: 0 });
      }
      attemptId = rows[0].id;
    }

    const { data: att } = await admin.from("fd_exam_attempt")
      .select("id,course_id,student_id,generator_id,seed,submitted_value,points_possible")
      .eq("id", attemptId).maybeSingle();
    if (!att) return json({ error: "attempt not found" }, 404);
    courseId = courseId || att.course_id;
    if (!(await canGrade(courseId))) return json({ error: "not permitted" }, 403);

    // Prefer what the client sent (it already has the regenerated item); fall
    // back to regenerating here so this works when called with only an id.
    let prompt = p.prompt ?? "", rubric = p.model_answer ?? "";
    let maxPoints = Number(p.points ?? att.points_possible ?? 3);
    if ((!prompt || !rubric) && att.generator_id && att.seed != null) {
      // deno-lint-ignore no-explicit-any
      const G = (globalThis as any).FDGenerators;
      if (G) {
        const q = G.generate(att.generator_id, Number(att.seed));
        if (q) {
          prompt = prompt || q.prompt;
          rubric = rubric || q.rubric || q.rationale || "";
          maxPoints = Number(p.points ?? q.points ?? maxPoints);
        }
      }
    }
    if (!rubric || String(rubric).trim().length < 40) {
      return json({ error: "This item has no usable rubric, so an AI score would be invented " +
                           "rather than applied. Grade it by hand." }, 400);
    }

    const cfg = await keyFor(courseId);
    if (!cfg) return json({ error: "No AI key is configured. Add one under Platform settings." }, 400);

    const { sys, user } = buildPrompt(prompt, rubric, att.submitted_value || "", maxPoints);
    const res = await callLLM(cfg.provider, cfg.key, cfg.model, sys, user, maxPoints);
    if (!res) return json({ error: "The AI grader did not return a usable score. Try again, or grade by hand." }, 502);

    // ai_* only. points_earned and graded_at stay untouched, so the item remains
    // in the ungraded queue until a human finalizes it.
    await admin.from("fd_exam_attempt").update({
      ai_score: res.score, ai_feedback: res.feedback, ai_graded_at: new Date().toISOString(),
    }).eq("id", attemptId);

    const { count } = await admin.from("fd_exam_attempt")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId).is("graded_at", null).not("submitted_value", "is", null);

    return json({ ok: true, attempt_id: attemptId, proposal: res,
                  message: "Proposed " + res.score + " / " + maxPoints + " — review and finalize.",
                  remaining: count ?? null });
  }

  /* ========================= propose on an assignment =================== */
  if (action === "propose_assignment") {
    const subId = p.submission_id;
    const { data: sub } = await admin.from("fd_submission")
      .select("id,course_id,assignment_id,text_response,link_url").eq("id", subId).maybeSingle();
    if (!sub) return json({ error: "submission not found" }, 404);
    if (!(await canGrade(sub.course_id))) return json({ error: "not permitted" }, 403);

    const { data: asg } = await admin.from("fd_assignment")
      .select("title,instructions,points").eq("id", sub.assignment_id).maybeSingle();
    const maxPoints = Number(asg?.points ?? 100);
    const rubric = String(asg?.instructions || "");
    if (rubric.trim().length < 40) {
      return json({ error: "This assignment has no instructions detailed enough to grade " +
                           "against. Add a rubric to the assignment first." }, 400);
    }
    if (!sub.text_response) {
      return json({ error: "This submission is a file or link only. AI grading here reads the " +
                           "typed response; grade it by hand." }, 400);
    }

    const cfg = await keyFor(sub.course_id);
    if (!cfg) return json({ error: "No AI key is configured." }, 400);

    const { sys, user } = buildPrompt(
      (asg?.title || "Assignment") + "\n\n" + rubric, rubric, sub.text_response, maxPoints);
    const res = await callLLM(cfg.provider, cfg.key, cfg.model, sys, user, maxPoints);
    if (!res) return json({ error: "The AI grader did not return a usable score." }, 502);

    await admin.from("fd_submission").update({
      ai_score: res.score, ai_feedback: res.feedback, ai_graded_at: new Date().toISOString(),
    }).eq("id", subId);
    return json({ ok: true, proposal: res,
                  message: "Proposed " + res.score + " / " + maxPoints + " — review and finalize." });
  }

  /* ================================ finalize =========================== */
  if (action === "finalize") {
    const attemptId = p.attempt_id;
    const { data: att } = await admin.from("fd_exam_attempt")
      .select("course_id").eq("id", attemptId).maybeSingle();
    if (!att) return json({ error: "attempt not found" }, 404);
    if (!(await canGrade(att.course_id))) return json({ error: "not permitted" }, 403);

    const pts = Number(p.points);
    if (isNaN(pts)) return json({ error: "points must be a number" }, 400);
    await admin.from("fd_exam_attempt").update({
      points_earned: pts, ai_feedback: p.feedback ?? null,
      graded_at: new Date().toISOString(), graded_by: uid,
    }).eq("id", attemptId);
    return json({ ok: true });
  }

  /* ============================== finalize_all ========================= */
  if (action === "finalize_all") {
    const courseId = p.course_id;
    if (!(await canGrade(courseId))) return json({ error: "not permitted" }, 403);

    const { data: rows } = await admin.from("fd_exam_attempt")
      .select("id,ai_score,ai_feedback")
      .eq("course_id", courseId).is("graded_at", null).not("ai_score", "is", null);

    let graded = 0, failed = 0;
    let first: string | null = null;
    for (const r of rows ?? []) {
      const { error } = await admin.from("fd_exam_attempt").update({
        points_earned: r.ai_score, graded_at: new Date().toISOString(), graded_by: uid,
      }).eq("id", r.id);
      if (error) { failed++; } else { graded++; if (!first) first = r.id; }
    }
    const { count } = await admin.from("fd_exam_attempt")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId).is("graded_at", null).not("submitted_value", "is", null);

    return json({ ok: true, graded, failed, first, remaining: count ?? 0,
                  message: "Accepted " + graded + " AI proposal" + (graded === 1 ? "" : "s") +
                           (failed ? ", " + failed + " failed" : "") + "." });
  }

  return json({ error: "unknown action: " + action }, 400);
});
