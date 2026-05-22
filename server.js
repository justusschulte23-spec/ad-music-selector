// ad-music-selector — Railway microservice
// POST /select-music  →  downloads Freesound previews, asks Gemini multimodal, returns best track
// No sandbox restrictions (unlike N8N Cloud task runner)

import express from "express";

const app  = express();
app.use(express.json({ limit: "1mb" }));

const GOOGLE_AI_KEY = process.env.GOOGLE_AI_KEY;

app.get("/health", (_req, res) => res.status(200).send("ok"));

// ── POST /select-music ──────────────────────────────────────────────────────
//
// Body:
//   {
//     "tracks":  [ { "name":"...", "duration":60, "previews": { "preview-lq-mp3":"...", "preview-hq-mp3":"..." } } ],
//     "adCtx":   { "stil":"...", "mood":"...", "hook_audio":"...", "zielgruppe":"..." }
//   }
//
// Response:
//   { "best_track_url":"...", "start_seconds":12, "track_name":"...", "reasoning":"..." }

app.post("/select-music", async (req, res) => {
  const { tracks = [], adCtx = {} } = req.body;
  const key = GOOGLE_AI_KEY;

  if (!key) {
    return res.status(500).json({ error: "GOOGLE_AI_KEY env var not set" });
  }
  if (!tracks.length) {
    return res.status(400).json({ error: "tracks array is empty" });
  }

  const top = tracks.slice(0, 8);
  console.log(`[select-music] ${top.length} tracks, ad-stil="${adCtx.stil || "?"}"`);

  // ── 1. Download previews concurrently ──────────────────────────────────────
  const dlResults = await Promise.all(
    top.map(async (t, i) => {
      const url =
        (t.previews || {})["preview-lq-mp3"] ||
        (t.previews || {})["preview-hq-mp3"] ||
        t.url ||
        "";
      const label = `Track ${i + 1}: ${t.name || "?"} (${Math.round(t.duration || 0)}s)`;
      if (!url) return { label, audio: null };
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        console.log(`  [dl] Track ${i + 1} OK — ${buf.length} bytes`);
        return { label, audio: buf.toString("base64") };
      } catch (e) {
        console.warn(`  [dl] Track ${i + 1} SKIP: ${e.message}`);
        return { label, audio: null };
      }
    })
  );

  const loaded = dlResults.filter((d) => d.audio).length;
  console.log(`[select-music] ${loaded}/${top.length} tracks downloaded`);

  // ── 2. Build Gemini multimodal parts ───────────────────────────────────────
  const parts = [];
  for (const { label, audio } of dlResults) {
    parts.push({ text: label });
    if (audio) {
      parts.push({ inlineData: { mimeType: "audio/mpeg", data: audio } });
    }
  }

  const prompt =
    "Du bist professioneller Music Supervisor fuer kommerzielle 20-30s Video-Ads.\n\n" +
    `Ad-Kontext:\n- Stil: ${adCtx.stil || ""}\n` +
    `- Mood: ${adCtx.mood || ""}\n` +
    `- Hook: ${adCtx.hook_audio || ""}\n` +
    `- Zielgruppe: ${adCtx.zielgruppe || ""}\n\n` +
    `Du hoerst ${loaded} Tracks. Finde den besten und den gehirn-stimulierendsten Einstiegspunkt.\n` +
    "Antworte NUR mit validem JSON:\n" +
    '{"best_track_url":"URL","start_seconds":0,"track_name":"Name","reasoning":"Begruendung"}';
  parts.push({ text: prompt });

  // ── 3. Call Google AI API ──────────────────────────────────────────────────
  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(90000),
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error("[select-music] Gemini API error:", JSON.stringify(data).slice(0, 400));
      return res.status(502).json({ error: "Gemini API error", details: data });
    }

    const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || "{}").trim();
    const result = JSON.parse(raw);
    console.log(`[select-music] winner: "${result.track_name}" @ ${result.start_seconds}s`);
    return res.json(result);

  } catch (e) {
    console.error("[select-music] error:", e.message);
    return res.status(500).json({
      error: e.message,
      best_track_url: null,
      start_seconds: 0,
      track_name: null,
      reasoning: "service error",
    });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ad-music-selector running on port ${port}`));
