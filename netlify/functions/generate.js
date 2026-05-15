const https = require("https");

function post(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch (e) { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
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
    const { pourvoi, examples = [] } = JSON.parse(event.body || "{}");
    if (!pourvoi) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Numéro de pourvoi manquant" }) };

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) throw new Error("Clé Gemini manquante");

    const exPrompt = examples.length
      ? "\n\nExemples de fiches validées (reproduire ce style) :\n" +
        examples.slice(-5).map((e) => JSON.stringify(e)).join("\n---\n")
      : "";

    const prompt = `Tu es un assistant juridique expert en droit français. Tu rédiges des fiches d'arrêt de la Cour de cassation en 6 sections.

Réponds UNIQUEMENT avec un objet JSON valide, sans backticks, sans commentaires :
{"presentation":"L'arrêt rendu par [chambre] de la Cour de cassation le [date] traite de [sujet].","faits":"En l'espèce, [faits pertinents, jamais la procédure].","procedure":"[Chronologie des instances, motifs, pourvoi].","these":"[Arguments du demandeur au pourvoi, articles violés allégués].","question":"[Question de droit abstraite, une phrase interrogative, sans noms propres]","solution":"La [chambre] répond par la [affirmative/négative] et [casse/rejette] au visa de [article] au motif que [motif exact].","type_arret":"cassation ou rejet"}

Numéro de pourvoi : ${pourvoi}
Génère la fiche depuis tes connaissances. Si inconnue, indique "À vérifier sur Légifrance".${exPrompt}`;

    const geminiRes = await post(
      "generativelanguage.googleapis.com",
      `/v1beta/models/gemini-2.5-flash-preview-0520:generateContent?key=${GEMINI_KEY}`,
      { "Content-Type": "application/json" },
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1500 } }
    );

    if (geminiRes.status !== 200) throw new Error("Gemini " + geminiRes.status + " : " + JSON.stringify(geminiRes.body));

    const raw = geminiRes.body.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
    const fiche = JSON.parse(s >= 0 && e >= 0 ? clean.slice(s, e + 1) : clean);

    return { statusCode: 200, headers: cors, body: JSON.stringify({ fiche, source: "model" }) };
  } catch (e) {
    console.error(e.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
