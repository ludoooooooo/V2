const https = require("https");
const http = require("http");

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/json,*/*",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Cache-Control": "no-cache",
        ...(options.headers || {})
      }
    }, (res) => {
      // Suivre les redirections
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpRequest(res.headers.location, options).then(resolve).catch(reject);
      }
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode, body: raw, headers: res.headers }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function postJson(hostname, path, headers, body) {
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

function getJson(hostname, path, headers) {
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

// ── Scraping Légifrance ───────────────────────────────────────────────────────
async function scrapeDecision(pourvoi) {
  const clean = pourvoi.trim();

  // 1. Recherche sur Légifrance
  const searchUrl = `https://www.legifrance.gouv.fr/search/juri?query=${encodeURIComponent(clean)}&searchField=ALL&tab_selection=juri&page=1`;
  const searchRes = await httpRequest(searchUrl);
  if (searchRes.status !== 200) throw new Error("Légifrance search HTTP " + searchRes.status);

  // Extraire l'URL du premier résultat (JURITEXT)
  const html = searchRes.body;
  const juriMatch = html.match(/href="([^"]*JURITEXT[0-9]+[^"]*)"/);
  const juri2Match = html.match(/href="(\/juri\/id\/JURITEXT[^"]+)"/);
  const linkMatch = juriMatch || juri2Match;
  if (!linkMatch) throw new Error("Aucun résultat trouvé sur Légifrance pour " + clean);

  let decisionUrl = linkMatch[1];
  if (!decisionUrl.startsWith("http")) decisionUrl = "https://www.legifrance.gouv.fr" + decisionUrl;
  // Nettoyer l'URL
  decisionUrl = decisionUrl.split("?")[0];

  // 2. Récupérer la page de la décision
  const decisionRes = await httpRequest(decisionUrl);
  if (decisionRes.status !== 200) throw new Error("Légifrance decision HTTP " + decisionRes.status);
  const decisionHtml = decisionRes.body;

  // 3. Extraire le texte brut (retirer les balises HTML)
  let text = decisionHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text.length < 200) throw new Error("Texte trop court");

  // 4. Extraire la date depuis "Audience publique du X mois AAAA"
  // C'est la formulation officielle en tête de chaque arrêt
  const audienceMatch = text.match(/[Aa]udience publique du\s+(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+(\d{4})/i);
  const date = audienceMatch
    ? `${audienceMatch[1]} ${audienceMatch[2].toLowerCase()} ${audienceMatch[3]}`
    : "";

  // 5. Chambre — chercher le titre officiel
  const chambrePatterns = [
    /chambre commerciale,\s*financière et économique/i,
    /première chambre civile/i,
    /deuxième chambre civile/i,
    /troisième chambre civile/i,
    /chambre sociale/i,
    /chambre criminelle/i,
    /assemblée plénière/i,
    /chambre mixte/i,
    /chambre commerciale/i,
  ];
  let chamber = "";
  for (const p of chambrePatterns) {
    const m = text.match(p);
    if (m) { chamber = m[0]; break; }
  }

  // 6. Solution officielle
  const solutionPatterns = [
    /REJETTE le pourvoi/i,
    /CASSE ET ANNULE/i,
    /cassation partielle/i,
    /Rejet/i,
    /Cassation/i,
  ];
  let solution = "";
  for (const p of solutionPatterns) {
    const m = text.match(p);
    if (m) { solution = m[0]; break; }
  }

  return { text: text.slice(0, 10000), date, chamber, solution, url: decisionUrl };
}

// ── Supabase exemples ─────────────────────────────────────────────────────────
async function getExamples() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const host = SUPABASE_URL.replace("https://", "");
  const res = await getJson(host, "/rest/v1/exemples?select=*&order=validated_at.desc&limit=5", {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json"
  });
  if (res.status !== 200) return [];
  return Array.isArray(res.body) ? res.body : [];
}

// ── Handler ───────────────────────────────────────────────────────────────────
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

    // 1. Scraper Légifrance
    let decisionData = null;
    let source = "model";
    try {
      decisionData = await scrapeDecision(pourvoi);
      source = "legifrance";
      console.log("Scraping OK:", pourvoi, "date:", decisionData.date, "chamber:", decisionData.chamber);
    } catch(e) {
      console.log("Scraping échoué:", e.message);
    }

    // 2. Exemples Supabase
    const examples = await getExamples();
    const exPrompt = examples.length
      ? "\n\n---\nEXEMPLES DE FICHES VALIDÉES (reproduire ce style exactement) :\n" +
        examples.slice(0, 3).map(e =>
          `PRÉSENTATION: ${e.presentation}\nFAITS: ${e.faits}\nPROCÉDURE: ${e.procedure}\nTHÈSE: ${e.these}\nQUESTION: ${e.question}\nSOLUTION: ${e.solution}`
        ).join("\n---\n")
      : "";

    // 3. Contexte décision
    let decisionContext = "";
    if (decisionData && decisionData.text) {
      decisionContext = `

TEXTE INTÉGRAL OFFICIEL DE LA DÉCISION (source : Légifrance) :
Date EXACTE : ${decisionData.date}
Chambre : ${decisionData.chamber}
Solution : ${decisionData.solution}
URL source : ${decisionData.url}

TEXTE :
${decisionData.text.slice(0, 9000)}

INSTRUCTION ABSOLUE : utilise UNIQUEMENT les informations du texte ci-dessus. Ne jamais inventer ni compléter avec ta mémoire. La date dans la présentation DOIT être "${decisionData.date}".`;
    } else {
      decisionContext = `

ATTENTION : le texte officiel est indisponible. Génère depuis tes connaissances en étant TRÈS prudent. Indique "À vérifier sur Légifrance" pour chaque information incertaine, notamment la date.`;
    }

    const prompt = `Tu es un juriste expert en droit privé français. Tu rédiges des fiches d'arrêt de la Cour de cassation de très haute qualité.

Réponds UNIQUEMENT avec un JSON valide sans backticks ni texte autour :
{"presentation":"...","faits":"...","procedure":"...","these":"...","question":"...","solution":"...","type_arret":"cassation ou rejet"}

RÈGLES MÉTHODOLOGIQUES :

1. PRÉSENTATION : "L'arrêt rendu par la [chambre complète] de la Cour de cassation le [date exacte du texte officiel] traite de [notion juridique]."

2. FAITS : Commencer par "En l'espèce,". Qualifier les parties juridiquement. Jamais de noms propres. Pas de procédure.

3. PROCÉDURE : Chronologie des instances. Jugements en 1ère instance, arrêts en appel et cassation. Motifs de la CA. Qui se pourvoit.

4. THÈSE :
   - CASSATION → motifs de la CA : "La cour d'appel a retenu que..."
   - REJET → arguments du demandeur : "Le demandeur au pourvoi fait grief..."

5. QUESTION DE DROIT : Une phrase abstraite, sans noms propres, appelant oui/non.

6. SOLUTION : "La [chambre] répond par la [affirmative/négative] et [casse/rejette] [au visa de l'article X si cassation] au motif que [motif]."
${exPrompt}
${decisionContext}

Numéro de pourvoi : ${pourvoi}`;

    const geminiRes = await postJson(
      "generativelanguage.googleapis.com",
      `/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
      { "Content-Type": "application/json" },
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1800 }
      }
    );

    if (geminiRes.status !== 200) throw new Error("Gemini " + geminiRes.status + " : " + JSON.stringify(geminiRes.body));

    const raw = geminiRes.body.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
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
      body: JSON.stringify({ fiche, source, examplesUsed: examples.length })
    };

  } catch (e) {
    console.error(e.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
