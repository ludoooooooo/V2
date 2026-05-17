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

    const examples = await getExamples();
    const exPrompt = examples.length
      ? "\n\n---\nEXEMPLES DE FICHES VALIDÉES (reproduire ce style et ce niveau de précision) :\n" +
        examples.slice(0, 3).map(e =>
          `PRÉSENTATION: ${e.presentation}\nFAITS: ${e.faits}\nPROCÉDURE: ${e.procedure}\nTHÈSE: ${e.these}\nQUESTION: ${e.question}\nSOLUTION: ${e.solution}`
        ).join("\n---\n")
      : "";

    const prompt = `Tu es un juriste expert en droit privé français. Tu rédiges des fiches d'arrêt de la Cour de cassation de très haute qualité pédagogique et professionnelle.

Réponds UNIQUEMENT avec un JSON valide sans backticks ni texte autour :
{"presentation":"...","faits":"...","procedure":"...","these":"...","question":"...","solution":"...","type_arret":"cassation ou rejet"}

## RÈGLES MÉTHODOLOGIQUES STRICTES

### 1. PRÉSENTATION
Une seule phrase d'accroche sobre :
"L'arrêt rendu par la [chambre complète] de la Cour de cassation le [date complète] traite de [notion juridique centrale en 5-10 mots]."
- Chambre complète : "première chambre civile", "chambre commerciale, financière et économique", "chambre sociale", etc.
- Sujet = la notion juridique en cause, pas les faits. Ex : "la validité de la mention manuscrite du cautionnement", "les conditions de la compensation judiciaire", "la portée de la promesse unilatérale de vente"
- Ne jamais anticiper la solution

### 2. FAITS
Exposé factuel rigoureux, chronologique, en 3 à 6 phrases :
- Commencer OBLIGATOIREMENT par "En l'espèce,"
- Qualifier chaque partie par sa qualité juridique PRÉCISE : vendeur/acquéreur, bailleur/preneur, prêteur/emprunteur, créancier/débiteur, promettant/bénéficiaire, cédant/cessionnaire, mandant/mandataire, commettant/préposé, employeur/salarié, caution/créancier/débiteur principal, victime/responsable...
- JAMAIS de noms propres, de noms de société, d'initiales
- Inclure : nature des liens juridiques entre parties, actes juridiques conclus, circonstances pertinentes pour la qualification
- EXCLURE : tout acte de procédure, toute décision de justice — la procédure va dans la section suivante

### 3. PROCÉDURE
Chronologie précise des instances judiciaires :
- Indiquer la juridiction de première instance saisie (si connue), par qui et pour quoi
- Qualifier correctement : les juges de première instance rendent des JUGEMENTS ; la cour d'appel et la Cour de cassation rendent des ARRÊTS
- La cour d'appel CONFIRME ou INFIRME le jugement
- Exposer la décision et les motifs de la cour d'appel avec précision
- Identifier qui forme le pourvoi en cassation (le demandeur au pourvoi) et contre qui (le défendeur au pourvoi)
- NE PAS mentionner les arguments du pourvoi ici — ils vont dans la thèse

### 4. THÈSE EN PRÉSENCE
⚠️ RÈGLE ABSOLUE — contenu différent selon le type d'arrêt :

ARRÊT DE CASSATION → La Cour de cassation n'est PAS d'accord avec les juges du fond. Exposer les motifs et le raisonnement de la COUR D'APPEL que la Cour va censurer :
"Pour [statuer ainsi], la cour d'appel a retenu que [motifs détaillés de la CA]. Elle a fondé sa décision sur [textes éventuels]."
Ne pas exposer les arguments du pourvoi (la Cour de cassation est d'accord avec eux, ils n'ont pas besoin d'être détaillés).

ARRÊT DE REJET → La Cour de cassation est d'accord avec les juges du fond. Exposer les arguments et moyens du DEMANDEUR AU POURVOI que la Cour va écarter :
"Le demandeur au pourvoi fait grief à l'arrêt d'avoir [décision contestée]. Il soutient, au soutien de son pourvoi, que [arguments]. Il invoque la violation des articles [X, Y, Z]."

### 5. QUESTION DE DROIT
Critères impératifs :
- Une seule phrase interrogative terminée par "?"
- Formulée en termes GÉNÉRAUX et ABSTRAITS — aucun nom propre, aucune référence aux faits particuliers de l'espèce
- Doit pouvoir être posée sans connaître l'affaire et appeler une réponse par oui ou non
- Vise la RÈGLE DE DROIT en cause, pas la situation factuelle
- Exemples de bonne formulation :
  "La levée d'option d'une promesse unilatérale de vente postérieure à la rétractation du promettant empêche-t-elle la formation du contrat de vente ?"
  "La caution peut-elle opposer au créancier les exceptions purement personnelles au débiteur principal ?"
  "Le juge peut-il écarter des débats une preuve obtenue sans violence ni fraude en matière de divorce ?"
  "L'illicéité du contrat de gestation pour autrui constitue-t-elle une fin de non-recevoir à l'action en établissement de filiation du père biologique ?"

### 6. SOLUTION
Format rigoureux :
"La [chambre complète] de la Cour de cassation répond par la [affirmative/négative] et [casse et annule l'arrêt rendu par la cour d'appel / rejette le pourvoi] [au visa des articles X et Y — UNIQUEMENT pour les arrêts de cassation] au motif que [motif juridique précis, complet, fidèle au raisonnement de la Cour, formulé comme un principe général]."

- CASSATION : mentionner obligatoirement le visa (articles et codes). Le motif doit être un principe de droit général, pas une description des faits.
- REJET : pas de visa obligatoire. Exposer le raisonnement de la Cour qui justifie le maintien de la décision attaquée.
- Si cassation avec renvoi : préciser "renvoie les parties devant [juridiction de renvoi]"
- Si cassation sans renvoi : le mentionner
${exPrompt}

---
Numéro de pourvoi : ${pourvoi}
Génère la fiche avec la plus grande rigueur juridique. Si tu ne connais pas cet arrêt avec certitude, indique "À vérifier sur Légifrance" uniquement dans les sections incertaines.`;

    const geminiRes = await post(
      "generativelanguage.googleapis.com",
      `/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
      { "Content-Type": "application/json" },
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.15, maxOutputTokens: 1800 }
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
      body: JSON.stringify({ fiche, source: "model", examplesUsed: examples.length })
    };

  } catch (e) {
    console.error(e.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
