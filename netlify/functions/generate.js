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
  const res = await get(host, "/rest/v1/exemples?select=*&order=validated_at.desc&limit=10", {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json"
  });
  if (res.status !== 200) return [];
  return Array.isArray(res.body) ? res.body : [];
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
    if (!pourvoi) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Numéro de pourvoi manquant" }) };

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) throw new Error("Clé Gemini manquante");

    const examples = await getExamples();
    const exPrompt = examples.length
      ? "\n\n---\nEXEMPLES DE FICHES VALIDÉES (reproduire ce style exactement) :\n" +
        examples.slice(0, 5).map((e) =>
          `PRÉSENTATION: ${e.presentation}\nFAITS: ${e.faits}\nPROCÉDURE: ${e.procedure}\nTHÈSE: ${e.these}\nQUESTION: ${e.question}\nSOLUTION: ${e.solution}`
        ).join("\n---\n")
      : "";

    const prompt = `Tu es un assistant juridique expert en droit français, spécialisé dans la rédaction de fiches d'arrêt de la Cour de cassation.

## STRUCTURE OBLIGATOIRE

Réponds UNIQUEMENT avec un JSON valide sans backticks :
{"presentation":"...","faits":"...","procedure":"...","these":"...","question":"...","solution":"...","type_arret":"cassation ou rejet"}

## RÈGLES PAR SECTION

### 1. PRÉSENTATION
Une seule phrase : "L'arrêt rendu par la [chambre] de la Cour de cassation le [date] traite de [sujet]."
Ne pas révéler la solution. Rester concis.

### 2. FAITS
- Commencer par "En l'espèce,"
- Qualifier juridiquement les parties (le créancier/le débiteur, le salarié/l'employeur, le promettant/le bénéficiaire...) — jamais de noms propres
- Faits pertinents uniquement, conduisant au litige
- Ne jamais mentionner la procédure judiciaire dans cette section

### 3. PROCÉDURE
- Qui a saisi quelle juridiction et pour quoi
- Décision de première instance si connue
- Décision et motifs de la Cour d'appel
- Qui s'est pourvu en cassation

### 4. THÈSE
RÈGLE FONDAMENTALE selon le type d'arrêt :
- CASSATION → exposer les motifs de la Cour d'appel que la Cour de cassation va rejeter. Commencer par "La Cour d'appel a retenu que..."
- REJET → exposer les arguments du demandeur au pourvoi que la Cour va écarter. Commencer par "Le demandeur au pourvoi allègue que..." et mentionner les articles invoqués.

### 5. QUESTION DE DROIT
- Formulée en termes généraux et abstraits, sans aucun nom propre
- Une seule phrase interrogative appelant oui ou non
- Compréhensible sans avoir lu l'arrêt

### 6. SOLUTION
Format : "La [chambre] de la Cour de cassation répond par la [affirmative/négative] et [casse l'arrêt rendu par la Cour d'appel / rejette le pourvoi] [au visa de l'article X —si cassation—] au motif que [motif précis]."
- Cassation : toujours mentionner le visa
- Rejet : pas de visa obligatoire
${exPrompt}

---
Numéro de pourvoi : ${pourvoi}
Génère la fiche depuis tes connaissances. Si inconnue, indique "À vérifier sur Légifrance" mais respecte la structure.`;

    const geminiRes = await post(
      "generativelanguage.googleapis.com",
      `/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
      { "Content-Type": "application/json" },
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2000 }
      }
    );

    if (geminiRes.status !== 200) throw new Error("Gemini " + geminiRes.status + " : " + JSON.stringify(geminiRes.body));

    const raw = geminiRes.body.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
    const fiche = JSON.parse(s >= 0 && e >= 0 ? clean.slice(s, e + 1) : clean);

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
