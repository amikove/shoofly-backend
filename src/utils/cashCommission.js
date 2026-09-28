const walletService = require('../services/walletService');
const { notify } = require('./notify');
const { getSetting } = require('./settings');

// ── Modèle de paiement cash (2026-08-13) — voir RAPPORT_DIAGNOSTIC_COHERENCE_CASH_VS_PAYZONE.md
// et schema.js (missions.payment_method, mission_commission_shortfalls). Ce module ne contient
// QUE la logique spécifique à payment_method='cash' — jamais exécuté ni importé par un chemin
// payzone, pour garantir que ce dernier reste identique au bit près (garde-fou explicite de la
// session).

// ── Vérification d'affectation — mission cash uniquement ──────────────────
// Même contrat que checkOeilAssignable (utils/oeilAssignment.js) — {error, code} si bloqué,
// {ok:true} sinon — mais délibérément gardée dans son propre module plutôt qu'ajoutée à LA
// famille checkOeilAssignable : zéro risque de régression sur ce chemin déjà exercé par ses 4
// appelants existants (prepareMissionInsert, POST /:id/accept, hireOeilCore, assign-admin) et par
// l'audit E2E qui le couvre. Appelée EN PLUS de checkOeilAssignable, jamais à sa place, uniquement
// quand mission.payment_method==='cash' — n'exécute donc jamais rien pour 'payzone'.
//
// Lecture seule, non verrouillée (SELECT simple, pas de FOR UPDATE) — comme les autres contrôles
// de la famille checkOeilAssignable, c'est un contrôle d'ÉLIGIBILITÉ au moment de l'affectation,
// pas une réservation de fonds : le montant réellement prélevé est décidé séparément à la
// validation (voir settleCashCommission ci-dessous), qui peut constater un solde différent — le
// solde peut se dégrader entre affectation et validation (décision produit : accepté, jamais
// bloquant à ce stade tardif, voir settleCashCommission).
//
// Chantier « première mission offerte » (2026-09-28) : `missionId` (null pour une réservation
// directe, la mission n'existant pas encore) et `stage` ('hire' | 'apply') permettent de tenir
// compte de la mission offerte (voir cashRequirementFor plus bas). Retour enrichi :
// { ok, freeOffer: null|'existing'|'start' } ou { error, code, blockCode, commission, balance } —
// blockCode/commission/balance ne sont renvoyés tels quels qu'à l'Œil lui-même (candidature) ;
// tout appelant qui répond à un TIERS doit continuer à mapper sur le message neutre.
async function checkCashCommissionBalance(db, oeilId, commission, { missionId = null, stage = 'hire' } = {}) {
  const mission = { id: missionId, payment_method: 'cash', commission };
  if (requiredCashBalance(mission) <= 0) return { ok: true, freeOffer: null }; // rien à couvrir (mission gratuite / promo)

  const state = await oeilCashState(db, oeilId);
  if (!state) return { error: 'Œil introuvable', code: 'not_found' };

  const req = cashRequirementFor(mission, state, { stage });
  if (state.balance < req.required) {
    return {
      error: `Solde wallet insuffisant pour couvrir la commission de cette mission cash (${req.required.toFixed(2)} MAD requis, ${state.balance.toFixed(2)} MAD disponibles).`,
      code: 'insufficient_cash_commission_balance',
      blockCode: req.blockCode,
      commission: req.commission,
      balance: state.balance,
    };
  }
  return { ok: true, freeOffer: req.freeOffer };
}

// ── Solde exigé pour être retenu sur une mission (chantier CashPlus, 2026-09-27) ──
// Montant que le wallet de l'Œil doit couvrir pour pouvoir être affecté : la commission d'une
// mission cash, 0 sinon (payzone, NULL historique, mission gratuite/promo). Règle UNIQUE du solde
// exigé : checkCashCommissionBalance, cashRequirementFor et le filtre SQL cashBalanceCoverFilter
// (cascade par lot, liste des candidats côté client) en dérivent tous.
// firstMissionFree (chantier « première mission offerte », 2026-09-28) : la mission est (ou va
// devenir) la mission offerte de cet Œil → rien à couvrir.
function requiredCashBalance(mission, { firstMissionFree = false } = {}) {
  if (!mission || mission.payment_method !== 'cash') return 0;
  if (firstMissionFree) return 0;
  const amount = parseFloat(mission.commission) || 0;
  return amount > 0 ? amount : 0;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Première mission offerte (chantier 2026-09-28, règles BOSS D1-D6) — UNE SEULE candidature ou
// mission « offerte » à la fois par Œil, table first_mission_free_offers (schema.js).
//
// Une ligne 'open' rattache la gratuité à UNE mission. Qu'elle soit encore en jeu (« vivante »)
// est DÉDUIT de l'état réel, jamais tenu à jour par chaque chemin d'annulation / d'embauche d'un
// autre Œil / d'expiration / de retrait (offerLiveSql) : un chemin oublié rend donc la gratuité
// (sens favorable à l'Œil) au lieu de la bloquer à vie. Seuls deux passages sont écrits
// explicitement : 'consumed' à la validation de CETTE mission (settleCashCommission, même si le
// réglage a été coupé entre-temps — promesse tenue) et 'lost' quand l'Œil abandonne la mission
// offerte après avoir été retenu (forfeitFirstMissionFreeOffer). 'returned' = ligne ouverte
// morte, refermée quand une nouvelle offre est ouverte (historique).
// ════════════════════════════════════════════════════════════════════════════════════════
const FIRST_MISSION_FREE_SETTING = 'first_mission_free_enabled';

async function isFirstMissionFreeEnabled(db) {
  return String(await getSetting(db, FIRST_MISSION_FREE_SETTING, 'true')) === 'true';
}

// Mission clôturée par un no-show client ou une déclaration d'assistance « mission » (client
// absent, mauvaise adresse, mission différente) : ne compte jamais comme « mission faite » (D2, D6).
function noShowClosedSql(m) {
  return `(${m}.status='completed' AND ${m}.validated_at IS NOT NULL AND (
      EXISTS (SELECT 1 FROM claims nsc WHERE nsc.mission_id=${m}.id AND nsc.status='resolved_oeil' AND nsc.dispute_reason='client_absent')
      OR EXISTS (SELECT 1 FROM mission_assistance_requests nsa WHERE nsa.mission_id=${m}.id AND nsa.category='mission' AND nsa.status IN ('validated','auto_validated'))))`;
}

// Offre ouverte (alias o) encore en jeu : candidature en lice sur une mission en attente (non
// retirée, l'Œil n'en est pas l'ancien titulaire), ou mission détenue par l'Œil et non close.
// Tout le reste (autre Œil retenu, annulée, expirée, retirée, no-show clôturé) = gratuité rendue.
function offerLiveSql(o) {
  return `(${o}.status='open' AND EXISTS (SELECT 1 FROM missions olm WHERE olm.id=${o}.mission_id AND (
      (olm.status='pending' AND olm.transferred_from IS DISTINCT FROM ${o}.oeil_id
        AND EXISTS (SELECT 1 FROM mission_interests oli WHERE oli.mission_id=olm.id AND oli.oeil_id=${o}.oeil_id AND oli.declined=false))
      OR (olm.oeil_id=${o}.oeil_id AND olm.status IN ('assigned','en_route','active','sous_reclamation'))
      OR (olm.oeil_id=${o}.oeil_id AND olm.status='completed' AND olm.validated_at IS NULL))))`;
}

// L'Œil (expression SQL) peut-il OUVRIR une offre ? Aucune offre consommée / perdue / en jeu, et
// aucune mission détenue ou déjà faite (hors no-show). Ne lit PAS le réglage (voir les appelants).
function canStartOfferSql(oeilExpr) {
  return `(NOT EXISTS (SELECT 1 FROM first_mission_free_offers cso WHERE cso.oeil_id=${oeilExpr}
        AND (cso.status IN ('consumed','lost') OR ${offerLiveSql('cso')}))
    AND NOT EXISTS (SELECT 1 FROM missions csm WHERE csm.oeil_id=${oeilExpr}
        AND csm.status IN ('assigned','en_route','active','completed','sous_reclamation') AND NOT ${noShowClosedSql('csm')}))`;
}

// Situation « argent » d'un Œil, en une requête : solde, droit d'ouvrir une offre (réglage
// compris), mission portant son offre en jeu. null si pas de profil Œil.
async function oeilCashState(db, oeilId) {
  const enabled = await isFirstMissionFreeEnabled(db);
  const { rows: [r] } = await db.query(
    `SELECT p.balance,
            ${enabled ? canStartOfferSql('p.user_id') : 'false'} AS can_start,
            (SELECT lo.mission_id FROM first_mission_free_offers lo WHERE lo.oeil_id=p.user_id AND ${offerLiveSql('lo')} LIMIT 1) AS live_offer_mission_id
     FROM oeil_profiles p WHERE p.user_id=$1`,
    [oeilId]
  );
  if (!r) return null;
  return { balance: parseFloat(r.balance) || 0, canStartOffer: r.can_start === true, liveOfferMissionId: r.live_offer_mission_id || null };
}

// Ce qu'un Œil (state = oeilCashState) doit couvrir pour UNE mission, et à quel titre :
//   freeOffer 'existing' — la mission porte déjà son offre en jeu → 0 ;
//   freeOffer 'start'    — il peut ouvrir son offre dessus → 0. À la candidature (stage 'apply')
//                          seulement si son solde ne couvre pas la commission (D3 a) ; à
//                          l'embauche (stage 'hire'), toujours : sa 1re mission retenue est offerte ;
//   sinon                — la commission ; blockCode dit pourquoi il ne peut pas postuler.
function cashRequirementFor(mission, state, { stage = 'hire' } = {}) {
  const commission = requiredCashBalance(mission);
  const base = { commission, blockCode: null };
  if (commission <= 0) return { ...base, required: 0, freeOffer: null };
  if (state.liveOfferMissionId && state.liveOfferMissionId === mission.id) {
    return { ...base, required: requiredCashBalance(mission, { firstMissionFree: true }), freeOffer: 'existing' };
  }
  if (state.canStartOffer && (stage === 'hire' || state.balance < commission)) {
    return { ...base, required: requiredCashBalance(mission, { firstMissionFree: true }), freeOffer: 'start' };
  }
  return {
    ...base,
    required: commission,
    freeOffer: null,
    blockCode: state.balance >= commission ? null : (state.liveOfferMissionId ? 'FREE_MISSION_ALREADY_USED' : 'INSUFFICIENT_BALANCE_TO_APPLY'),
  };
}

// Ouvre l'offre de l'Œil sur missionId. DOIT tourner dans une transaction, APRÈS le verrou de la
// ligne de l'Œil (FOR UPDATE) et après un contrôle freeOffer==='start' fait sous ce verrou : les
// lignes ouvertes restantes sont alors toutes mortes et sont refermées ('returned'). L'index
// unique partiel (une seule ligne 'open' par Œil) reste le dernier rempart.
async function openFirstMissionFreeOffer(client, oeilId, missionId) {
  await client.query(
    `UPDATE first_mission_free_offers SET status='returned', closed_at=NOW(), close_reason='remplacée par une nouvelle offre'
     WHERE oeil_id=$1 AND status='open'`,
    [oeilId]
  );
  await client.query(`INSERT INTO first_mission_free_offers (oeil_id, mission_id) VALUES ($1,$2)`, [oeilId, missionId]);
}

// Gratuité PERDUE (D3 c) : l'Œil abandonne, après avoir été retenu, la mission qui portait son
// offre (demande de remplacement, réattribution forcée, suspension, blocage, présence non
// confirmée, non-démarrage H+30). Sans effet si la mission ne portait pas d'offre ouverte.
async function forfeitFirstMissionFreeOffer(db, oeilId, missionId, reason) {
  await db.query(
    `UPDATE first_mission_free_offers SET status='lost', closed_at=NOW(), close_reason=$3
     WHERE oeil_id=$1 AND mission_id=$2 AND status='open'
       AND NOT EXISTS (SELECT 1 FROM first_mission_free_offers t WHERE t.oeil_id=$1 AND t.status IN ('consumed','lost'))`,
    [oeilId, missionId, reason]
  );
}

// Variante « jamais bloquante » pour les chemins d'abandon (hors transaction) : un échec ici ne
// doit jamais empêcher la libération de la mission — au pire la gratuité reste rendue.
async function forfeitFirstMissionFreeOfferSafe(db, oeilId, missionId, reason) {
  try { await forfeitFirstMissionFreeOffer(db, oeilId, missionId, reason); } catch (e) {
    console.error(`❌ forfeitFirstMissionFreeOffer (Œil ${oeilId}, mission ${missionId}) :`, e.message);
  }
}

// Filtre SQL « le wallet de l'Œil couvre ce que la mission lui demande » (cascade par lot :
// tirage et départage ; liste des candidats côté client). Même règle que cashRequirementFor en
// stage 'hire' : solde ≥ commission, OU offre en jeu sur CETTE mission, OU droit d'ouvrir une
// offre (réglage actif). params à étaler à partir de $paramIndex.
async function cashBalanceCoverFilter(db, mission, { balanceExpr, oeilExpr, paramIndex }) {
  const required = requiredCashBalance(mission);
  if (required <= 0) return { sql: `COALESCE(${balanceExpr}, 0) >= $${paramIndex}::numeric`, params: [required] };
  const enabled = await isFirstMissionFreeEnabled(db);
  const i = paramIndex;
  return {
    sql: `(COALESCE(${balanceExpr}, 0) >= $${i}::numeric
      OR EXISTS (SELECT 1 FROM first_mission_free_offers cfo WHERE cfo.oeil_id=${oeilExpr} AND cfo.mission_id=$${i + 1} AND ${offerLiveSql('cfo')})${enabled ? `
      OR ${canStartOfferSql(oeilExpr)}` : ''})`,
    params: [required, mission.id],
  };
}

// Parmi oeilIds, ceux qui NE couvrent PAS ce que la mission leur demande — en une requête.
// Set vide si la mission n'exige rien. Un Œil sans profil est compté comme non couvert.
async function cashBalanceShortSet(db, oeilIds, mission) {
  const required = requiredCashBalance(mission);
  if (required <= 0 || oeilIds.length === 0) return new Set();
  const cover = await cashBalanceCoverFilter(db, mission, { balanceExpr: 'p.balance', oeilExpr: 'p.user_id', paramIndex: 2 });
  const { rows } = await db.query(
    `SELECT p.user_id FROM oeil_profiles p WHERE p.user_id = ANY($1::text[]) AND ${cover.sql}`,
    [oeilIds, ...cover.params]
  );
  const covered = new Set(rows.map((r) => r.user_id));
  return new Set(oeilIds.filter((id) => !covered.has(id)));
}

// Message et code renvoyés à un TIERS (le client) quand un Œil ne peut pas être retenu faute de
// solde : aucune information financière sur l'Œil (ni solde, ni commission, ni motif). Le détail
// chiffré de checkCashCommissionBalance reste réservé à l'admin (POST /:id/assign-admin).
const OEIL_UNAVAILABLE_CODE = 'OEIL_UNAVAILABLE_FOR_MISSION';
const OEIL_UNAVAILABLE_MESSAGE = "Cet Œil n'est pas disponible pour cette mission, choisissez-en un autre.";

// ── Règlement à la validation — mission cash uniquement ────────────────────
// Contrepartie cash de walletService.credit(client, mission.oeil_id, 'oeil', mission.oeil_earning,
// ...) : au lieu de créditer l'Œil (le client l'a déjà payé directement en espèces), débite la
// commission Shoofly de son wallet. Décision produit (session 2026-08-13, en réponse à un conflit
// structurel constaté entre "autoriser un solde négatif" et la contrainte CHECK(balance>=0) sur
// oeil_profiles — voir historique de session) : ce débit n'est JAMAIS bloquant et ne rend JAMAIS
// le solde négatif — il est plafonné au solde réellement disponible au moment de la validation
// (Math.min), et tout manque à gagner (commission due non entièrement collectée) est journalisé
// dans mission_commission_shortfalls pour rester visible côté admin (voir routes/users.js, GET/PUT
// .../admin/commission-shortfalls) plutôt que de rester invisible dans les seuls logs serveur.
//
// `client` : DOIT être un client de transaction déjà ouvert (walletService.withTransaction) —
// jamais le pool brut. lockBalance() l'exige (verrouille la ligne via FOR UPDATE, voir
// walletService.js) et tous les appelants actuels sont déjà dans une transaction pour ce même
// bloc d'écritures interdépendantes (validated_at, chaîne de transfert, crédit/débit, historique).
// Appelée exclusivement depuis l'intérieur des transactions de validation existantes : POST
// /:id/validate, POST /:id/assistance/respond, checkAssistanceRequestExpiry (routes/missions.js),
// runAutoValidateMissions (jobs/autoValidateMissions.js), PUT /admin/claims/:missionId/resolve
// (routes/users.js).
//
// Retourne { collected, shortfall } — collected est le montant réellement débité (0 si le solde
// était déjà à 0 ou négatif), shortfall la part non collectée (0 si le solde suffisait). Ne
// débite rien du tout si commission<=0 (mission gratuite/promo) — même filet que
// checkCashCommissionBalance ci-dessus.
//
// Première mission offerte (2026-09-28) : si CETTE mission porte l'offre ouverte de l'Œil, elle
// est exonérée — rien n'est débité, l'offre passe 'consumed' avec le montant exonéré (trace), et
// ce même si le réglage a été coupé depuis l'embauche (D4, promesse tenue). Garde atomique :
// UPDATE … WHERE status='open' (une seule validation peut la consommer) + index unique partiel
// (au plus une offre consommée/perdue par Œil). firstMissionFreeAllowed:false = chemins no-show
// (« client absent », déclaration d'assistance « mission ») : la gratuité n'est PAS consommée
// (D2, D6) et la commission suit la décision de l'admin comme avant.
async function settleCashCommission(client, mission, reason, { firstMissionFreeAllowed = true } = {}) {
  const commission = parseFloat(mission.commission) || 0;
  if (commission <= 0) return { collected: 0, shortfall: 0 };

  if (firstMissionFreeAllowed) {
    const { rowCount } = await client.query(
      `UPDATE first_mission_free_offers SET status='consumed', commission_waived=$3, closed_at=NOW(), close_reason=$4
       WHERE oeil_id=$1 AND mission_id=$2 AND status='open'`,
      [mission.oeil_id, mission.id, commission, reason]
    );
    if (rowCount === 1) return { collected: 0, shortfall: 0, firstMissionFree: true, waived: commission };
  }

  const currentBalance = await walletService.lockBalance(client, mission.oeil_id, 'oeil');
  const collected = Math.round(Math.min(commission, currentBalance || 0) * 100) / 100;
  if (collected > 0) {
    await walletService.debit(client, mission.oeil_id, 'oeil', collected, reason, mission.id);
  }

  const shortfall = Math.round((commission - collected) * 100) / 100;
  if (shortfall > 0) {
    await client.query(
      `INSERT INTO mission_commission_shortfalls (mission_id, oeil_id, commission_due, commission_collected, shortfall)
       VALUES ($1,$2,$3,$4,$5)`,
      [mission.id, mission.oeil_id, commission, collected, shortfall]
    );
  }

  return { collected, shortfall };
}

// ── Chantier notifications (2026-09-14), Partie C/G3 : notifie les admins finance d'un manque à
// gagner commission — HORS transaction (règle projet : jamais de notify() dans une transaction,
// voir jobs/walletReconciliation.js). settleCashCommission tourne toujours À L'INTÉRIEUR d'une
// transaction (voir son propre commentaire ci-dessus) : cette fonction est donc appelée APRÈS
// coup par chacun des 6 sites qui l'utilisent, au même endroit que leur notify() existant vers
// l'Œil (règle « notifications toujours après le commit », déjà suivie partout dans ce projet).
// No-op silencieux si shortfall<=0 — chaque appelant peut donc appeler ceci inconditionnellement
// juste après avoir consommé cashSettlement, sans re-tester la condition lui-même.
// Notifier l'Œil lui-même d'un manque à gagner est une question produit distincte, non tranchée
// (voir rapport de chantier) — volontairement PAS fait ici.
async function notifyShortfallAdmins(db, mission, cashSettlement, emitToUser = null) {
  if (!cashSettlement || !(cashSettlement.shortfall > 0)) return;
  const { rows: admins } = await db.query(
    `SELECT id FROM users WHERE role='admin' AND is_active=true AND (is_super_admin=true OR permissions ? 'finance')`
  );
  for (const admin of admins) {
    await notify(
      db, admin.id,
      '⚠️ Manque à gagner commission cash',
      `${cashSettlement.shortfall} MAD de commission non collectés sur "${mission.title}" (solde Œil insuffisant).`,
      'warning', mission.id, emitToUser, null,
      'commissionShortfallAdminTitle', 'commissionShortfallAdminBody',
      { missionTitle: mission.title, shortfall: cashSettlement.shortfall, collected: cashSettlement.collected }
    );
  }
}

// Notification à l'Œil quand sa mission offerte est validée (à la place de « X MAD de commission
// débités ») — HORS transaction, comme notifyShortfallAdmins. No-op si la mission n'était pas offerte.
async function notifyFirstMissionFreeOeil(db, mission, cashSettlement, emitToUser = null) {
  if (!cashSettlement || !cashSettlement.firstMissionFree) return false;
  await notify(
    db, mission.oeil_id,
    '🎁 Première mission offerte',
    `"${mission.title}" est validée. C'était votre mission offerte : aucune commission n'a été prélevée.`,
    'info', mission.id, emitToUser, null,
    'firstMissionFreeOeilTitle', 'firstMissionFreeOeilBody', { missionTitle: mission.title }
  );
  return true;
}

module.exports = {
  checkCashCommissionBalance, settleCashCommission, notifyShortfallAdmins, notifyFirstMissionFreeOeil,
  requiredCashBalance, cashBalanceShortSet, cashBalanceCoverFilter, OEIL_UNAVAILABLE_CODE, OEIL_UNAVAILABLE_MESSAGE,
  isFirstMissionFreeEnabled, oeilCashState, cashRequirementFor, openFirstMissionFreeOffer,
  forfeitFirstMissionFreeOffer, forfeitFirstMissionFreeOfferSafe,
};
