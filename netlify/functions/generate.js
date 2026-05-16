const https = require("https");

function get(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function getExamples() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const host = SUPABASE_URL.replace("https://", "");
  const res = await get(host, "/rest/v1/exemples?select=*&order=validated_at.desc&limit=5", {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json"
  });
  if (res.status !== 200) return [];
  return Array.isArray(res.body) ? res.body : [];
}

function callGeminiStreaming(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1200 }
    });

    const path = `/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse&key=${apiKey}`;

    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let fullText = "";
      res.on("data", (chunk) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const json = JSON.parse(line.slice(6));
              const part = json.candidates?.[0]?.content?.parts?.[0]?.text;
              if (part) fullText += part;
            } catch(e) {}
          }
        }
      });
      res.on("end", () => resolve({ status: res.statusCode, text: fullText }));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Méthode non autorisée" }) };

  try {
    const { pourvoi } = JSON.parse(event.body || "{}");
    if (!pourvoi) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Pourvoi manquant" }) };

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) throw new Error("Clé Gemini manquante");

    // Charger exemples en parallèle pendant qu'on prépare le prompt
    const examplesPromise = getExamples();

    const examples = await examplesPromise;
    const exPrompt = examples.length
      ? "\n\nEXEMPLES VALIDÉS :\n" + examples.slice(0, 3).map(e =>
          `PRÉSENTATION: ${e.presentation}\nFAITS: ${e.faits}\nPROCÉDURE: ${e.procedure}\nTHÈSE: ${e.these}\nQUESTION: ${e.question}\nSOLUTION: ${e.solution}`
        ).join("\n---\n")
      : "";

    const prompt = `Expert en droit français. Rédige une fiche d'arrêt de la Cour de cassation. JSON uniquement, sans backticks.

FORMAT: {"presentation":"...","faits":"...","procedure":"...","these":"...","question":"...","solution":"...","type_arret":"cassation ou rejet"}

RÈGLES:
- presentation: "L'arrêt rendu par la [chambre] de la Cour de cassation le [date] traite de [sujet]."
- faits: Commence par "En l'espèce,". Qualifier juridiquement les parties (créancier/débiteur, etc). Jamais de noms propres. Faits pertinents uniquement, pas la procédure.
- procedure: Juridiction saisie, décision CA avec motifs, qui se pourvoit.
- these: SI CASSATION → motifs de la CA rejetés, commencer par "La cour d'appel a retenu que...". SI REJET → arguments du demandeur au pourvoi, commencer par "Le demandeur au pourvoi fait grief...".
- question: Abstraite, sans noms propres, une phrase interrogative. Ex: "La levée d'option postérieure à la rétractation du promettant empêche-t-elle la formation du contrat de vente ?"
- solution: "La [chambre] répond par la [affirmative/négative] et [casse/rejette] [au visa de l'article X si cassation] au motif que [motif précis]."
${exPrompt}

Numéro de pourvoi : ${pourvoi}`;

    const result = await callGeminiStreaming(GEMINI_KEY, prompt);

    if (result.status !== 200) throw new Error("Gemini " + result.status);

    const raw = result.text || "{}";
    let fiche;
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
      fiche = JSON.parse(s >= 0 && e >= 0 ? clean.slice(s, e + 1) : clean);
    } catch(parseErr) {
      const match = raw.match(/\{[\s\S]*"presentation"[\s\S]*"type_arret"[\s\S]*?\}/);
      if (match) fiche = JSON.parse(match[0]);
      else throw new Error("Parsing impossible : " + parseErr.message);
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ fiche, source: "model", examplesUsed: examples.length })
    };

  } catch (e) {
    console.error(e.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
