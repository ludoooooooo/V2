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

function getHtml(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LegAsk/1.0)",
        "Accept": "application/json",
        "Accept-Language": "fr-FR,fr;q=0.9"
      }
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Recherche sur l'API publique Judilibre (sans auth, endpoint public)
async function fetchFromJudilibre(pourvoi) {
  const clean = pourvoi.trim().replace(/\s/g, "");
  
  // Endpoint public Judilibre sans authentification
  const path = `/cassation/judilibre/v1.0/search?query=${encodeURIComponent(clean)}&type=arret&page_size=1&page=0`;
  
  const res = await getHtml("api.judilibre.io", path);
  if (res.status !== 200) throw new Error("Judilibre public " + res.status);
  
  const data = JSON.parse(res.body);
  const results = data.results || [];
  if (!results.length) throw new Error("Décision introuvable");
  
  const d = results[0];
  return {
    text: d.text || d.summary || "",
    date: d.decision_date || d.date || "",
    chamber: d.chamber || d.formation || "",
    solution: d.solution || "",
    number: d.number || pourvoi
  };
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

    // 1. Récupérer le texte officiel
    let decisionData = null;
    let source = "model";
    try {
      decisionData = await fetchFromJudilibre(pourvoi);
      source = "judilibre";
      console.log("Judilibre OK:", pourvoi, "date:", decisionData.date);
    } catch(e) {
      console.log("Judilibre indisponible:", e.message);
    }

    // 2. Exemples Supabase
    const examples = await getExamples();
    const exPrompt = examples.length
      ? "\n\n---\nEXEMPLES DE FICHES VALIDÉES (reproduire ce style et ce niveau de précision) :\n" +
        examples.slice(0, 3).map(e =>
          `PRÉSENTATION: ${e.presentation}\nFAITS: ${e.faits}\nPROCÉDURE: ${e.procedure}\nTHÈSE: ${e.these}\nQUESTION: ${e.question}\nSOLUTION: ${e.solution}`
        ).join("\n---\n")
      : "";

    // 3. Contexte décision
    let decisionContext = "";
    if (decisionData && decisionData.text) {
      decisionContext = `\n\nTEXTE OFFICIEL DE LA DÉCISION (Judilibre) — utiliser ces informations en priorité absolue :\nDate exacte : ${decisionData.date}\nChambre : ${decisionData.chamber}\nSolution officielle : ${decisionData.solution}\nTexte intégral :\n${decisionData.text.slice(0, 8000)}`;
    } else {
      decisionContext = `\n\nATTENTION : texte officiel indisponible. Génère depuis tes connaissances en étant très prudent sur les dates et informations factuelles. Indique "À vérifier sur Légifrance" si incertain.`;
    }

    const prompt = `Tu es un juriste expert en droit privé français. Tu rédiges des fiches d'arrêt de la Cour de cassation de très haute qualité pédagogique et professionnelle.

Réponds UNIQUEMENT avec un JSON valide sans backticks ni texte autour :
{"presentation":"...","faits":"...","procedure":"...","these":"...","question":"...","solution":"...","type_arret":"cassation ou rejet"}

## RÈGLES MÉTHODOLOGIQUES STRICTES

### 1. PRÉSENTATION
Une seule phrase : "L'arrêt rendu par la [chambre complète] de la Cour de cassation le [date complète au format jour mois année] traite de [notion juridique centrale en 5-10 mots]."
- Utiliser la date EXACTE fournie dans le texte officiel
- Chambre complète : "première chambre civile", "chambre commerciale, financière et économique", "chambre sociale", etc.
- Sujet = notion juridique, pas les faits

### 2. FAITS
Exposé factuel rigoureux, chronologique, en 3 à 6 phrases :
- Commencer OBLIGATOIREMENT par "En l'espèce,"
- Qualifier chaque partie par sa qualité juridique PRÉCISE : vendeur/acquéreur, bailleur/preneur, prêteur/emprunteur, créancier/débiteur, promettant/bénéficiaire, cédant/cessionnaire, mandant/mandataire, employeur/salarié, caution/débiteur principal...
- JAMAIS de noms propres ni de noms de société
- EXCLURE tout acte de procédure

### 3. PROCÉDURE
- Juridiction de première instance si connue, par qui et pour quoi
- Les juges de première instance rendent des JUGEMENTS ; la cour d'appel et la Cour de cassation rendent des ARRÊTS
- La cour d'appel CONFIRME ou INFIRME le jugement
- Décision et motifs précis de la cour d'appel
- Qui forme le pourvoi en cassation

### 4. THÈSE EN PRÉSENCE
RÈGLE ABSOLUE selon le type d'arrêt :
- CASSATION → motifs de la COUR D'APPEL que la Cour va censurer. Commencer par "Pour [statuer ainsi], la cour d'appel a retenu que..."
- REJET → arguments du DEMANDEUR AU POURVOI. Commencer par "Le demandeur au pourvoi fait grief à l'arrêt d'avoir [décision contestée]. Il soutient que..."

### 5. QUESTION DE DROIT
- Une seule phrase interrogative abstraite, sans noms propres
- Appelle une réponse par oui ou non
- Formulée comme un principe général

### 6. SOLUTION
"La [chambre complète] de la Cour de cassation répond par la [affirmative/négative] et [casse et annule l'arrêt / rejette le pourvoi] [au visa de l'article X — si cassation] au motif que [motif précis et complet]."
- CASSATION : visa obligatoire
- REJET : pas de visa
${exPrompt}
${decisionContext}

Numéro de pourvoi : ${pourvoi}`;

    const geminiRes = await post(
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
