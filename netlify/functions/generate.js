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
      ? "\n\n---\nEXEMPLES DE FICHES VALIDÉES PAR L'ADMINISTRATEUR (reproduire ce style et ce niveau de précision exactement) :\n" +
        examples.slice(0, 5).map((e) =>
          `PRÉSENTATION: ${e.presentation}\nFAITS: ${e.faits}\nPROCÉDURE: ${e.procedure}\nTHÈSE: ${e.these}\nQUESTION: ${e.question}\nSOLUTION: ${e.solution}`
        ).join("\n---\n")
      : "";

    const prompt = `Tu es un juriste expert en droit privé français, spécialisé dans l'analyse des arrêts de la Cour de cassation. Tu rédiges des fiches d'arrêt de très haute qualité, utilisées dans un contexte pédagogique et professionnel exigeant.

## FORMAT DE RÉPONSE

Réponds UNIQUEMENT avec un objet JSON valide, sans backticks, sans commentaires, sans texte avant ou après :
{"presentation":"...","faits":"...","procedure":"...","these":"...","question":"...","solution":"...","type_arret":"cassation ou rejet"}

## EXIGENCES PAR SECTION

### 1. PRÉSENTATION
Une phrase d'accroche sobre et précise :
"L'arrêt rendu par la [chambre complète] de la Cour de cassation le [date complète] traite de [sujet juridique précis en 5-10 mots]."
- Mentionner la chambre complète (ex : "première chambre civile", "chambre commerciale, financière et économique")
- Ne jamais anticiper la solution
- Le sujet doit nommer la notion juridique centrale (ex : "la portée du droit de rétention du créancier", "la validité de la mention manuscrite du cautionnement", "la qualification du contrat de promesse unilatérale de vente")

### 2. FAITS
Exposé factuel rigoureux en 4 à 8 phrases :
- Commencer OBLIGATOIREMENT par "En l'espèce,"
- Qualifier précisément chaque partie par sa qualité juridique : le promettant/le bénéficiaire, le créancier chirographaire/le débiteur, le bailleur/le preneur, le mandant/le mandataire, le cédant/le cessionnaire, le garant/le débiteur principal, etc.
- Ne jamais utiliser de noms propres, de sociétés nommées ou d'initiales
- Exposer les faits dans l'ordre chronologique
- Ne mentionner aucun acte de procédure dans cette section
- Inclure les éléments contractuels, les qualités des parties et les circonstances pertinentes pour la qualification juridique

### 3. PROCÉDURE
Exposé chronologique et précis de l'instance :
- Indiquer la juridiction de première instance saisie et l'objet de la demande si connus
- Exposer la décision de la cour d'appel et ses motifs avec précision
- Pour un arrêt de CASSATION : détailler les motifs retenus par la cour d'appel
- Pour un arrêt de REJET : exposer brièvement la décision de la cour d'appel favorable au défendeur
- Indiquer qui forme le pourvoi en cassation (le demandeur au pourvoi)
- Ne pas répéter les arguments du pourvoi ici (ils sont dans la thèse)

### 4. THÈSE EN PRÉSENCE
⚠️ RÈGLE ABSOLUE — le contenu dépend du type d'arrêt :

Si arrêt de CASSATION :
Exposer les motifs et le raisonnement de la COUR D'APPEL que la Cour de cassation va censurer.
Commencer par : "Pour [décider que / retenir que / rejeter la demande], la cour d'appel a retenu que..."
Mentionner les textes sur lesquels la cour d'appel a fondé sa décision si connus.
Ne pas exposer les arguments du pourvoi.

Si arrêt de REJET :
Exposer les arguments et moyens du DEMANDEUR AU POURVOI que la Cour de cassation va écarter.
Commencer par : "Le demandeur au pourvoi fait grief à l'arrêt d'avoir [décidé que...]. Il soutient, au soutien de son pourvoi, que..."
Mentionner les articles dont il invoque la violation (ex : "au visa des articles 1134 et 1147 anciens du Code civil").

### 5. QUESTION DE DROIT
⚠️ EXIGENCES STRICTES :
- Une seule phrase interrogative, terminée par un point d'interrogation
- Formulée en termes GÉNÉRAUX et ABSTRAITS : aucun nom propre, aucun élément d'espèce, aucune référence aux faits particuliers
- La question doit pouvoir être posée à tout juriste sans qu'il ait besoin de connaître l'affaire
- Elle doit viser la règle de droit en cause, pas les faits : formuler à partir de la notion juridique centrale
- Elle doit appeler une réponse par oui ou par non
- Exemples de bonne formulation :
  * "La levée d'option d'une promesse unilatérale de vente postérieure à la rétractation du promettant empêche-t-elle la formation du contrat de vente ?"
  * "La caution peut-elle opposer au créancier les exceptions purement personnelles au débiteur principal ?"
  * "L'absence du caractère liquide et exigible d'une créance conduit-elle nécessairement au rejet d'une demande en compensation judiciaire ?"

### 6. SOLUTION DE LA COUR
Format rigoureux et complet :
"La [chambre complète] de la Cour de cassation répond par la [affirmative / négative] et [casse et annule l'arrêt rendu par la cour d'appel / rejette le pourvoi] [au visa de l'article [X] du [Code Y] — uniquement pour les arrêts de cassation] au motif que [motif juridique précis, complet et fidèle au raisonnement de la Cour]."

- Pour un arrêt de CASSATION : mentionner obligatoirement le visa (article et code), et reproduire fidèlement le principe dégagé par la Cour
- Pour un arrêt de REJET : pas de visa, mais exposer le raisonnement de la Cour qui justifie le rejet
- Le motif doit être une proposition juridique générale, pas une simple référence aux faits
${exPrompt}

---
Numéro de pourvoi : ${pourvoi}

Génère la fiche d'arrêt avec le plus grand soin et la plus grande précision juridique. Si tu ne connais pas cet arrêt avec certitude, indique "À vérifier sur Légifrance" uniquement dans les sections incertaines, mais maintiens la rigueur formelle dans toutes les sections.`;

    const geminiRes = await post(
      "generativelanguage.googleapis.com",
      `/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
      { "Content-Type": "application/json" },
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.15, maxOutputTokens: 3000 }
      }
    );

    if (geminiRes.status !== 200) throw new Error("Gemini " + geminiRes.status + " : " + JSON.stringify(geminiRes.body));

    const raw = geminiRes.body.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    // Parsing robuste : extraire le JSON même si Gemini ajoute du texte autour
    let fiche;
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
      const jsonStr = s >= 0 && e >= 0 ? clean.slice(s, e + 1) : clean;
      fiche = JSON.parse(jsonStr);
    } catch(parseErr) {
      // Tentative 2 : chercher un JSON valide avec regex
      const match = raw.match(/\{[\s\S]*"presentation"[\s\S]*"type_arret"[\s\S]*?\}/);
      if (match) {
        fiche = JSON.parse(match[0]);
      } else {
        throw new Error("Impossible de parser la réponse du modèle : " + parseErr.message);
      }
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
