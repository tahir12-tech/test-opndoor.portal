// =====================================================================
// invite-user (verify_jwt = true)
//
// Creates (or re-invites) a portal user and sends a BRANDED invite email via
// Resend, redirected to the review address in this test build. Same pattern as
// send-password-reset: the recovery/invite link is generated server-side (admin
// API, service role, so GoTrue's own mailer is NOT used) and delivered by our
// template. The link lands on /accept-invite, where the invitee sets a password
// and is handed into TOTP enrolment.
//
// Authorisation mirrors the Add-user UI: opndoor admins may invite any role
// (superadmins land under opndoor, everyone else under a named partner);
// management may invite referrers/managers into THEIR OWN partner only.
//
// AND IT CARRIES THE AGENCY LEVEL. Director, Manager and Negotiator are two roles
// and one boolean: Negotiator is 'referrer', Director and Manager are both
// 'management' and differ only by users.sees_commission. That boolean is written
// here, from the dialog's choice, and may only be granted by a caller who holds it
// themselves. It used to be ignored, so every management invite landed as a
// Manager whatever the dialog said.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendMessage } from "../_shared/mailer.ts";
import { staffInviteEmail } from "../_shared/emailTemplates.ts";
import { resolveInvitePosition } from "../_shared/invitePosition.ts";
import { namedParty } from "../_shared/namedParty.ts";
import { safeOrigin } from "../_shared/safeOrigin.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ ok: false, error: "Not authenticated." }, 401);

    const b = await req.json().catch(() => ({}));
    const email = String(b.email ?? "").trim().toLowerCase();
    const role = String(b.role ?? "");
    const firstName = String(b.firstName ?? "").trim();
    const lastName = String(b.lastName ?? "").trim();
    const partnerSlug = String(b.partner ?? "").trim();
    const branchId = String(b.branch ?? "").trim();
    // Optional org position to grant on creation, so a brand/group manager (or a
    // branch manager) is placed the moment they are invited rather than in a second
    // step on the Users screen. '' = none (e.g. a negotiator, placed by home branch).
    /* THE AGENCY LEVEL, which this function used to drop on the floor.
       The invite dialog offers three levels (Director, Manager, Negotiator) and
       usersService sends `seesCommission` with every invite. Nothing here read
       it, and users.sees_commission defaults to FALSE, so every management person
       ever invited landed as a MANAGER and a Director could not be created
       through the product at all: the only ones in existence were the ones the
       20261005170000 backfill made. The screen offered a choice the server threw
       away, which is the worst of the three possible bugs here because it looks
       like it worked. */
    const seesCommission = b.seesCommission === true;
    const scopeKind = String(b.scopeKind ?? "").trim();
    const scopeTarget = String(b.scopeTarget ?? "").trim();
    // Backlog B6, same as send-password-reset: APP_URL, or localhost when it
    // is unset, and otherwise no link at all.
    const base = safeOrigin(b.origin);
    if (!base) return json({ ok: false, error: "Invitations are not configured." }, 503);

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: "A valid email address is required." }, 400);
    // 'developer' was missing here while the User Management screen offered it
    // as a full option with a written description. The screen and the server
    // disagreed, so every agency wanting an API key needed opndoor to run SQL.
    if (!["superadmin", "management", "referrer", "developer", "opndoor_manager"].includes(role)) {
      return json({ ok: false, error: "Invalid role." }, 400);
    }

    // Caller-scoped client: identify + authorise the inviter.
    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await userClient.auth.getUser();
    const callerId = userData.user?.id;
    if (!callerId) return json({ ok: false, error: "Not authenticated." }, 401);
    // sees_commission on the CALLER, because granting it is a ladder like the
    // positions one: only somebody who holds the capability may hand it out.
    const { data: caller } = await userClient.from("users").select("role, partner_id, full_name, sees_commission").eq("id", callerId).maybeSingle();
    if (!caller) return json({ ok: false, error: "Not permitted." }, 403);

    const service = createClient(SUPABASE_URL, SERVICE);

    // Resolve the invitee's partner + enforce who may invite whom.
    let inviteePartnerId: string | null = null;
    let callerScoped = false;   // set for a management caller who holds a position
    if (caller.role === "superadmin") {
      // superadmin and opndoor_manager are Opndoor staff: no partner (the
      // users_partner_by_role CHECK requires their partner_id to be null). Only a
      // superadmin can create an opndoor_manager; a management caller's allowlist
      // below excludes it.
      if (role !== "superadmin" && role !== "opndoor_manager") {
        const { data: p } = await service.from("partners").select("id").eq("slug", partnerSlug).maybeSingle();
        if (!p?.id) return json({ ok: false, error: "Select a valid partner for this user." }, 400);
        inviteePartnerId = p.id;
      }
    } else if (caller.role === "management") {
      // ---- the agency's own ladder ------------------------------------------
      //
      // An agency manages its own people: a director invites a branch manager,
      // a branch manager invites a negotiator, without opndoor doing it. What
      // somebody may grant follows their POSITION, not just their role, because
      // "management" covers a head office and a single branch manager and those
      // are not the same authority.
      //
      // Read through the caller-scoped client on purpose: user_scopes' own
      // policy decides what they can see of their scope, so this cannot be used
      // to discover somebody else's.
      const { data: scopes } = await userClient
        .from("user_scopes").select("kind").eq("user_id", callerId);
      const kinds = new Set((scopes ?? []).map((r: { kind: string }) => r.kind));
      callerScoped = kinds.size > 0;

      // No position at all is the pre-existing case: a partner-wide manager,
      // which is what management has always meant. They keep exactly what they
      // had, plus developer, which the screen already claimed they could grant.
      const isBranchOnly = kinds.size > 0 && !kinds.has("group") && !kinds.has("agency");

      /* A DEVELOPER IS AN API ROLE, AND THE AGENCY RAIL HAS NO API.
         A developer is pinned to a partner and reaches dev-centre, which mints
         keys and registers webhook endpoints. On the supplier rail the partner
         is that supplier's own company and that is the product. On the house
         route the partner is shared by every agency Opndoor carries, so a
         developer created there would be a developer for all of them.
         20261006270000 refuses the endpoint and the key at the database, and
         this refuses the account, so the route is shut at both ends. */
      /* THE PARTNER'S KIND, NOT ITS REFERENCING MODE, since 20261007600000.
         This read `referencing_mode === "opndoor_referenced"`, so a supplier
         whose journey an admin changed lost the ability to create its own
         developer -- the account half of the same fault that took it off the
         Suppliers list. The question here is what the partner IS. */
      const { data: myPartner } = await userClient
        .from("partners").select("partner_kind").eq("id", caller.partner_id).maybeSingle();
      const onOurEstate = myPartner?.partner_kind === "agency";

      const allowed = isBranchOnly
        // A branch manager staffs their branches. They cannot create another
        // manager, and they certainly cannot create a key-minting developer:
        // both would be a way to climb out of the branch they were given.
        ? ["referrer"]
        : onOurEstate
          ? ["referrer", "management"]
          : ["referrer", "management", "developer"];

      if (!allowed.includes(role)) {
        return json({
          ok: false,
          error: isBranchOnly
            /* THE LEVELS, CAPITALISED AS THE PRODUCT CAPITALISES THEM. Matt,
               2026-10-03: "Sweep the portal, emails, exports and help for any
               remaining 'negotiator' used to mean a referrer generally (keep
               it only where it's the Negotiator level)." These three ARE
               about the level, so they stay -- but in lower case they read as
               a job title, which is the thing the sweep is about. Everywhere
               else in the product a level is a proper noun. */
            ? "Branch managers may invite Negotiators only."
            : onOurEstate
              ? "You can invite Negotiators and Managers. Developer accounts are for API integrations, which agencies do not use."
              : "Managers may invite Negotiators, Managers or Developers.",
        }, 403);
      }

      /* THE LEVEL LADDER, ASKED IN SQL AND AS THE CALLER.
         The allowlist above is about ROLE and is keyed on positions; it cannot
         tell Director from Manager, because both are 'management'. So a Manager
         asking for a Director passed it, and the only thing standing in the way
         was a silent coercion further down that quietly wrote sees_commission
         false, answered { ok: true } and sent the invitation. The person then
         arrived as a Manager holding an email that said Director, which is the
         worst of the three possible outcomes because it looks like it worked.

         assert_may_grant_level refuses instead. Called through the CALLER-scoped
         client, so auth.uid() inside it is the inviter and not service_role, the
         same shape create_invited_user uses for set_user_scope below.
         Agency levels only: a developer invite carries no level and is governed
         by the allowlist above. */
      /* OUR ESTATE ONLY, since 2026-10-03. `assert_may_grant_level` knows
         exactly three words -- Director, Manager, Negotiator -- and they are
         the AGENCY ladder. A supplier's rail has no such ladder: its levels
         are Management, Referrer and Developer, and which of them a caller
         may grant is the `allowed` list above, keyed on the partner's kind.

         Running the ladder on a supplier invite did two wrong things at
         once. It translated "Management" into an agency level through
         `seesCommission`, which is how supplier Management came to be
         invited as a "Manager"; and `level_rank_of` is null for a supplier's
         own people, who hold no position, so a supplier's Management
         inviting a colleague would have been refused outright with "You can
         only give someone a level at or below your own" -- a sentence about
         a ladder they are not on. */
      if (onOurEstate && (role === "management" || role === "referrer")) {
        const level = role === "referrer" ? "Negotiator" : (seesCommission ? "Director" : "Manager");
        const { error: levelErr } = await userClient.rpc("assert_may_grant_level", { p_level: level });
        if (levelErr) return json({ ok: false, error: levelErr.message }, 403);
      }
      inviteePartnerId = caller.partner_id ?? null;
    } else {
      return json({ ok: false, error: "Not permitted." }, 403);
    }

    /* NO NAME IS NO NAME, NOT THE EMAIL. Matt, 2026-10-01: "I invited
       barb@barb.com with the name 'barb barb' but she shows by email."

       This fell back to the address, so a person invited without a name
       was STORED as their own email and every people list then printed it
       as their name, twice: once in the name column and once under it.
       The product already knew this was wrong -- #69 patched the invite
       EMAIL to drop an inviter name containing an "@" -- and patched the
       symptom at the one place it had been noticed.

       Stored empty instead, which is what `personLabel` on the client
       reads to say "Name not set" once. full_name is NOT NULL, so the
       empty string is the honest value, not null. */
    const fullName = `${firstName} ${lastName}`.trim();

    /* IS THE PERSON BEING INVITED ONTO OUR OWN ESTATE? Asked of the INVITEE's
       partner, not the caller's, because an admin invites into partners that
       are not their own. It decides whether a position is optional. */
    const { data: inviteePartner } = await service
      .from("partners").select("partner_kind").eq("id", inviteePartnerId).maybeSingle();
    const inviteeOnOurEstate = inviteePartner?.partner_kind === "agency";

    /* WHO THIS IS, BEFORE ANY REQUIREMENT IS PUT ON THEM. Round 6, H1. The
       position requirement was moved below this lookup when round 5's H3 was
       fixed; the BRANCH requirement below was not, so "Resend invite" on a
       pending Negotiator still answered "Choose the branch this negotiator
       will work at" for every caller holding a position -- which is every
       agency Director and Manager. Same defect, one block higher up, and the
       test written for H3 missed it because it exercised the extracted
       decision rather than this path. */
    const { data: existing } = await service
      // .eq, not .ilike: `email` is request-body text and .ilike takes a LIKE
      // PATTERN, so `%` and `_` reach the database. 20261006710000 normalises
      // users.email to lowercase on write, so equality on the lowercased key
      // is exact. Backlog B4.
      .from("users").select("id, role, partner_id, home_branch_id").eq("email", email).maybeSingle();
    let alreadyPositioned = false;
    if (existing) {
      const { count } = await service
        .from("user_scopes").select("user_id", { count: "exact", head: true }).eq("user_id", existing.id);
      alreadyPositioned = (count ?? 0) > 0;
    }

    // Record the negotiator's home branch, so the scoped manager who invited them
    // sees them from day one (before any referral). branches_select is already
    // narrowed to the caller's position, so a row returned through the caller-scoped
    // client is proof the caller may place a negotiator at that branch. A scoped
    // manager MUST place them, or the new user would vanish from their Users screen
    // until they refer.
    let homeBranchId: string | null = null;
    if (role === "referrer") {
      if (branchId) {
        const { data: br } = await userClient.from("branches").select("id, partner_id").eq("id", branchId).maybeSingle();
        if (!br || br.partner_id !== inviteePartnerId) {
          return json({ ok: false, error: "Choose a branch within your remit for this negotiator." }, 400);
        }
        homeBranchId = br.id;
      } else if (callerScoped && !existing) {
        // A RE-INVITE GRANTS NO BRANCH, for the same reason it grants no
        // position: this path creates nobody, and where they sit was settled
        // when they were invited. Asking again is a question with no control
        // behind it, because resendInvite sends neither.
        return json({ ok: false, error: "Choose the branch this negotiator will work at." }, 400);
      }
    }

    /* EVERYBODY ON OUR ESTATE IS INVITED INTO A POSITION.

       This dialog sent no scopeKind for a Director or a Manager, and the grant
       below only ran `if (scopeKind)`, so every manager invited from Team was
       born unpositioned -- the exact state that made `not app_has_scope() or
       ...` hand somebody every agency on the route. The reviewer found the
       policy; the sweep found this screen creating the state it needed.

       A negotiator invited with a branch is positioned at that branch: their
       home branch used to be what located them, and it is no longer allowed
       to be. 20261006300000 refuses the row at the database either way; this
       is the sentence a person reads instead of a constraint violation.

       AND A RE-INVITE GRANTS NO POSITION, because the person already holds
       one. That was round 5's H3: this refusal sat above the `existing`
       lookup, `resendInvite` sends no scope, and so "Resend invite" answered
       "Choose the group, brand or branch" for everybody on the estate. The
       lookup now happens first and the question is whether the requirement is
       already SATISFIED -- not whether this is a create, because somebody
       from before 20261006300000 can exist and hold nothing. */
    const placed = resolveInvitePosition({
      inviteeOnOurEstate, scopeKind: scopeKind || null, scopeTarget: scopeTarget || null,
      role, homeBranchId, alreadyPositioned,
    });
    if (!placed.ok) return json({ ok: false, error: placed.error }, 400);
    const effectiveScopeKind = placed.scopeKind;
    const effectiveScopeTarget = placed.scopeTarget;

    // A position to grant on creation must sit within the invitee's own partner.
    // The grant itself is authorised by set_user_scope (the positions ladder),
    // called as the inviter after the account exists; here we only fail fast on a
    // malformed level or a cross-partner target before creating anything.
    if (scopeKind) {
      if (!["group", "agency", "branch"].includes(scopeKind)) return json({ ok: false, error: "Invalid position level." }, 400);
      if (!scopeTarget) return json({ ok: false, error: "Choose the group, brand or branch for this position." }, 400);
      const tbl = scopeKind === "group" ? "agency_groups" : scopeKind === "agency" ? "agencies" : "branches";
      /* READ THROUGH THE CALLER, NOT THE SERVICE ROLE. This used the service
         role and then compared partner_id, which on the house route admits
         every agency: the fail-fast was wider than the real guard behind it
         (set_user_scope, which refuses "You can only grant a position within
         your own scope"). Reading through the caller's own client means RLS
         answers, and the two agree. Admins are unaffected: their policies
         return everything. */
      const { data: node } = await userClient.from(tbl).select("partner_id").eq("id", scopeTarget).maybeSingle();
      if (!node || node.partner_id !== inviteePartnerId) {
        return json({ ok: false, error: "That group, brand or branch is not one you can place somebody at." }, 400);
      }
    }

    // New vs re-invite: an existing portal user gets a recovery (set-password)
    // link; a new one is created by the invite link. `existing` is read above,
    // because the position requirement has to know whether this is a re-invite.
    let link: string | undefined;
    let targetUserId: string | undefined = existing?.id;

    /* RE-INVITING IS REACHING A PERSON, SO ASK THE PERSON SURFACE.

       This test was `existing.partner_id !== inviteePartnerId`, read through
       the SERVICE role. On the supplier rail the partner is the company and
       that was a real boundary. On the house route it is every agency we have
       onboarded, so a manager at one agency could trigger a set-password link
       and a user_audit row against a manager at another -- reached by email
       address, which is guessable, with no position test anywhere in the path.

       The same correction the scope block above already had applied to it:
       read through the CALLER's client so RLS answers. users_select is now
       app_may_reach_user, so a row coming back IS the authorisation, and the
       fail-fast agrees with the real guard instead of being wider than it. */
    if (existing && caller.role !== "superadmin") {
      const { data: reachable } = await userClient
        .from("users").select("id, role").eq("id", existing.id).maybeSingle();
      /* 'developer' belongs here. Round 6, M2: a supplier management caller
         may CREATE a developer (the allowlist forty lines above says so) and
         could then never resend that developer's invitation, because this list
         did not name the role they had just handed out. */
      if (!reachable || !["referrer", "management", "developer"].includes(reachable.role)) {
        return json({ ok: false, error: "Not permitted." }, 403);
      }
      /* AND THE LADDER, which this branch never asked. Round 6, M7.
         Reach is not rank: users_select admits everybody a Director or Manager
         can SEE, which includes the Director above them. So a Manager sent
         {email: "director@...", role: "referrer"}, passed the reach test and
         the role allowlist, and triggered a GoTrue recovery link and a
         user_audit "invited" row against somebody senior to them. Re-inviting
         is something done TO a person, and may_act_on_user is the predicate
         for that: strictly below, opndoor staff exempt.

         Checked on dev before adding it, because a lock here would be worse
         than the hole: the ladder resolves on the SUPPLIER rail too (a
         supplier Manager is rank 2, their developer rank 3), so this does not
         re-close what the line above just opened. */
      const { data: mayAct } = await userClient
        .rpc("may_act_on_user", { p_user: existing.id });
      if (mayAct !== true) {
        return json({ ok: false, error: "You can only do this for someone below your own level." }, 403);
      }
    }

    /* THE TAB THIS PERSON SIGNS IN ON, carried in the link.

       Matt, 2026-10-01: "Password reset and invite links send each person
       to the sign-in tab for their own type: supplier users to the Supplier
       tab, agency users to the Agent tab, tenants to the Tenant tab."

       send-password-reset already does this and takes the audience from the
       tab the person was looking at. An invite has no such tab to read, and
       does not need one: the server knows which rail it is inviting on to.
       Our own estate is the Agent tab, a supplier is the Supplier tab, and
       Opndoor's own staff sign in beside the agents.

       THE FALLBACK IS THE POINT, and it is the reset's: GoTrue matches
       redirectTo against the project's Redirect URLs, and an entry without a
       wildcard stops matching once a query string is on the end. A cosmetic
       improvement to a tab must not be able to turn into no invite emails,
       so a rejected redirect degrades to the link we sent yesterday. */
    const tab = inviteeOnOurEstate || !inviteePartnerId ? "agent" : "supplier";
    const landing = `${base}/accept-invite?tab=${tab}`;

    if (existing) {
      let { data, error } = await service.auth.admin.generateLink({
        type: "recovery", email, options: { redirectTo: landing },
      });
      if (error) {
        const plain = await service.auth.admin.generateLink({
          type: "recovery", email, options: { redirectTo: `${base}/accept-invite` },
        });
        data = plain.data; error = plain.error;
      }
      if (error) return json({ ok: false, error: error.message }, 400);
      link = data?.properties?.action_link;
    } else {
      let { data, error } = await service.auth.admin.generateLink({
        type: "invite", email, options: { redirectTo: landing, data: { full_name: fullName } },
      });
      if (error) {
        const plain = await service.auth.admin.generateLink({
          type: "invite", email, options: { redirectTo: `${base}/accept-invite`, data: { full_name: fullName } },
        });
        data = plain.data; error = plain.error;
      }
      if (error) return json({ ok: false, error: error.message }, 400);
      link = data?.properties?.action_link;
      targetUserId = data?.user?.id;
      if (targetUserId) {
        /* THE PERSON AND THEIR POSITION, IN ONE TRANSACTION.

           This was `service.from("users").insert(...)` followed, forty lines
           below, by a separate set_user_scope call with a hand-written
           compensating delete if the grant was refused. Two transactions, and
           the only thing between a refused grant and an unpositioned account
           was that compensation running. 20261006300000 makes an unpositioned
           person on our estate a constraint violation, which a deferred
           constraint can only enforce if both rows are written together.

           Called through the CALLER's client, not the service role, so
           set_user_scope's ladder and containment tests inside it are the
           inviter's -- exactly as they were when it was a separate call.

           sees_commission is written by the function. A Director request from
           a Manager is refused by assert_may_grant_level above rather than
           silently downgraded, so the honest value is the right one. */
        const { error: insErr } = await userClient.rpc("create_invited_user", {
          p_id: targetUserId,
          p_email: email,
          p_full_name: fullName,
          p_role: role,
          p_partner: inviteePartnerId,
          p_home_branch: homeBranchId,
          p_sees_commission: role === "management" && seesCommission,
          p_scope_kind: effectiveScopeKind,
          p_scope_target: effectiveScopeTarget,
        });
        if (insErr) {
          // The auth account exists and the portal row does not, so nothing is
          // left half-made: the same rollback the separate grant used to do.
          await service.auth.admin.deleteUser(targetUserId).catch(() => {});
          return json({ ok: false, error: insErr.message }, 400);
        }
      }
    }
    if (!link) return json({ ok: false, error: "Could not generate the invitation link." }, 400);

    /* A RE-INVITE may also be given a position, and that is still a separate
       call because the person already exists and there is nothing to roll
       back. A NEW person was positioned inside create_invited_user above, in
       the same transaction as their row, so this no longer runs for them. */
    if (existing && effectiveScopeKind && targetUserId) {
      const { error: grantErr } = await userClient.rpc("set_user_scope",
        { p_user: targetUserId, p_kind: effectiveScopeKind, p_target: effectiveScopeTarget });
      if (grantErr) return json({ ok: false, error: `Could not grant the position: ${grantErr.message}` }, 400);
    }

    /* Branded invite email (redirected to the review address in test mode).

       WALK FIX 33. This read `partners.name` and passed it straight to the
       template, so every agency invite said "the portal for Opndoor
       Agents" -- the house partner every agency is carried on, which is
       plumbing and which channel.ts exists to keep off a screen. The party
       somebody is joining is their AGENCY on that rail, the SUPPLIER on
       theirs, and opndoor itself for our own staff. invitePartyName holds
       that decision; this resolves the two names it needs. */
    const partnerRow = inviteePartnerId
      ? (await service.from("partners").select("slug, name").eq("id", inviteePartnerId).maybeSingle()).data
      : null;
    /* THE AGENCY, from wherever the invite actually says it. An agency or
       group position names it directly; a branch position and a home branch
       each name it one join away. Read with the SERVICE client because this
       is a display name for an email and the invitee cannot read it yet. */
    let agencyName: string | null = null;
    /* A RESEND HAS NO SCOPE TO READ, which is why Matt named resends
       separately. Matt (ab): "Invite emails for agency users (including
       resends) should name the agency."

       `resendInvite` posts no scopeKind and no scopeTarget -- deliberately,
       because the person already holds a position and re-granting one is
       round 5's H3. So `effectiveScopeKind` is null on every resend, both
       branches below find nothing, and `namedParty` fell back to the
       partner: "Opndoor Agents" on the agency rail, which is the house
       plumbing this whole block exists to keep out of an email.

       SO THE POSITION THEY ALREADY HOLD IS THE ANSWER, read here rather
       than inferred. Their first invite named their agency correctly; a
       resend of it must say the same thing, and the only reason it did not
       is that the scope arrived in the request last time and not this. */
    if (!effectiveScopeKind && existing) {
      const { data: held } = await service
        .from("user_scopes")
        .select("kind, agency_id, branch_id")
        .eq("user_id", existing.id)
        .limit(1).maybeSingle();
      if (held?.agency_id) {
        agencyName = (await service.from("agencies").select("name").eq("id", held.agency_id).maybeSingle()).data?.name ?? null;
      } else if (held?.branch_id) {
        const { data: br } = await service.from("branches").select("agency:agencies(name)").eq("id", held.branch_id).maybeSingle();
        // deno-lint-ignore no-explicit-any
        const ag = (Array.isArray(br?.agency) ? (br?.agency as any)[0] : (br?.agency as any)) ?? null;
        agencyName = ag?.name ?? null;
      }
    }
    if (agencyName) {
      // Already answered from the position they hold.
    } else if (effectiveScopeKind === "agency" && effectiveScopeTarget) {
      agencyName = (await service.from("agencies").select("name").eq("id", effectiveScopeTarget).maybeSingle()).data?.name ?? null;
    } else {
      /* A branch position, or a home branch, names the agency one join
         away. PostgREST types an embedded to-one as an ARRAY here, so it
         is unwrapped the same way every other caller in this codebase
         unwraps one. */
      const branchId = effectiveScopeKind === "branch" ? effectiveScopeTarget : homeBranchId;
      if (branchId) {
        const { data: br } = await service.from("branches").select("agency:agencies(name)").eq("id", branchId).maybeSingle();
        // deno-lint-ignore no-explicit-any
        const ag = (Array.isArray(br?.agency) ? (br?.agency as any)[0] : (br?.agency as any)) ?? null;
        agencyName = ag?.name ?? null;
      }
    }
    const partnerName = namedParty({
      partnerSlug: partnerRow?.slug ?? null,
      partnerName: partnerRow?.name ?? null,
      agencyName,
    });
    /* #69: never expose a contact email as a display name. The fallback
       that created those rows is gone (see fullName above), but rows made
       before it went still carry an address in full_name, so the "@" test
       stays: it is reading history, not guarding a live behaviour. */
    const inviterName = caller.full_name && !caller.full_name.includes("@") ? caller.full_name : "";
    const emailRes = await sendMessage({ to: email, message: staffInviteEmail({ inviterName, partnerName, link }) });

    // const emailRes = await sendEmail({
    //     subject: tpl.subject,
    //     html: tpl.html,
    //     to: email,
    //     from: "opndoor <invites@opndoor.co>",  // yahi is email ka apna "from" hai
    //   });
    // Audit the invite (best-effort).
    if (targetUserId) {
      await service.from("user_audit").insert({
        target_user: targetUserId, partner_id: inviteePartnerId, action: "invited",
        old_value: null, new_value: role, actor: caller.full_name ?? "an administrator", actor_id: callerId,
      });
    }

    // A refused grant returned above, so if we are here the position (when one was
    // requested) is placed; positionError is retired.
    return json({ ok: true, emailSent: emailRes.ok, emailError: emailRes.ok ? null : emailRes.error, positioned: !!scopeKind });
  } catch (e) {
    return json({ ok: false, error: "Could not send the invitation." }, 500);
  }
});
