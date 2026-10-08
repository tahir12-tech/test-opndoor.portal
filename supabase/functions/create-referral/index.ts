// =====================================================================
// create-referral (verify_jwt = true)
//
// The "send" is the whole flow: create the application (Sent) via the
// validated create_referral RPC (as the caller, so RLS + field validation
// apply), open a Stripe Checkout Session for the guarantee fee, store the
// payment refs, and email the tenant the branded payment email. Graceful
// degradation: if Resend is not configured the application and checkout still
// succeed and the response reports emailSent = false with a reason.
//
// M5: a JOINT TENANCY is N applicants on one tenancy. The fee is resolved once
// at the tenant count and split by share (create_joint_referral), and then each
// applicant runs the SAME per-applicant finish as a sole tenant: their own
// Stripe session for their own share, or their own invite on the agent rail.
// That is why the finish is a function rather than inline code — the single
// tenant path is not "similar to" the joint one, it IS the same function called
// once, which is the only way byte-identical stays true as this changes.
//
// Stripe key mode must match the project: sk_test_ on a non-production project,
// sk_live_ everywhere else. See _shared/stripeMode.ts.
// =====================================================================
import Stripe from "npm:stripe@^17";
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendMessage } from "../_shared/mailer.ts";
import { safeOrigin } from "../_shared/safeOrigin.ts";
import { feeBasisPhrase, feeBasisWeeksOf, paymentLinkEmail, tenantInviteEmail } from "../_shared/emailTemplates.ts";
import type { FeeCopy, TenantRail } from "../_shared/emailTemplates.ts";
import { titleCaseAddress } from "../_shared/text.ts";
import { stripeSecretFor } from "../_shared/livemodeCredentials.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

interface FinishResult {
  id: string;
  ref: string;
  paymentUrl: string | null;
  emailSent: boolean;
  emailError: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // The portal only ever creates live applications (create_referral hardcodes
    // livemode true), so this asks for the live key explicitly rather than
    // reading the project. On a dev project that still resolves to sk_test_,
    // because stripeSecretFor composes the project rule for live applications.
    const stripeSecret = stripeSecretFor(true);
    if (!stripeSecret.ok) {
      return json({ ok: false, error: stripeSecret.error }, 400);
    }
    const STRIPE_SECRET = stripeSecret.value;
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ ok: false, error: "Not authenticated." }, 401);

    const b = await req.json();
    /* THE SERVER'S OWN URL FIRST. Round 7 backlog M1. This was the only
       function in the repo that preferred the CALLER-supplied origin over
       APP_URL, and what hangs off it is a genuine Opndoor-branded payment
       email and a 30-day tenant-invite link. An authenticated referrer could
       point both at a host they control.

       Its siblings all do it the other way round -- invite-user:66,
       send-password-reset:52 -- and tenant-auth goes further with safeOrigin,
       which refuses anything but APP_URL or localhost. This is the sibling
       form; the safeOrigin form is the backlog item that remains. */
    const origin = safeOrigin(b.origin);
    if (!origin) return json({ ok: false, error: "Referrals are not configured." }, 503);

    // Caller-scoped client: RLS + create_referral field validation + AAL2 all apply.
    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });

    const { data: userData } = await userClient.auth.getUser();
    const actorId = userData.user?.id;
    let actor = "A user";
    if (actorId) {
      const { data: prof } = await userClient.from("users").select("full_name").eq("id", actorId).maybeSingle();
      if (prof?.full_name) actor = prof.full_name;
    }

    // Resolve the partner (by slug) the picker chose, so a same-named agency
    // under two partners resolves to the intended one (#66) rather than an
    // arbitrary name match. Partner users are RLS-scoped to their own partner
    // anyway; the extra filter is harmless for them.
    let partnerId: string | null = null;
    /* The chosen route, as a uuid. The form sends whatever it holds -- a slug
       from the picker -- and the RPC takes a uuid, so it is resolved here
       through the CALLER's client: an admin who cannot see a partner cannot
       route to it either. A miss leaves it null and the RPC resolves the
       route the ordinary way rather than failing. */
    let routeId: string | null = null;
    if (b.route) {
      /* TWO EXACT MATCHES, NOT ONE .or() STRING.
         The obvious spelling is `.or(`slug.eq.${b.route},id.eq.${b.route}`)`,
         and it interpolates a value the caller chose into a PostgREST FILTER
         EXPRESSION -- where a comma or a parenthesis is syntax, not data. A
         route of `x,id.gt.0` becomes a third clause and the filter stops
         meaning what it says. Same family as the ILIKE finding in backlog B4:
         a caller's text used as something it is not.
         `.eq()` sends the value as a parameter, so nothing in it can be
         syntax. A uuid is tried first because that is what the form sends;
         the slug lookup is the fallback for a hand-made call. */
      const asUuid = /^[0-9a-f-]{36}$/i.test(b.route)
        ? await userClient.from("partners").select("id").eq("id", b.route).maybeSingle()
        : null;
      routeId = (asUuid?.data?.id as string) ?? null;
      if (!routeId) {
        const { data: bySlug } = await userClient.from("partners").select("id")
          .eq("slug", b.route).maybeSingle();
        routeId = (bySlug?.id as string) ?? null;
      }
    }

    if (b.partner) {
      const { data: p } = await userClient.from("partners").select("id").eq("slug", b.partner).maybeSingle();
      partnerId = p?.id ?? null;
    }
    let branchQuery = userClient
      .from("branches").select("id, partner_id, agencies!inner(name)").eq("name", b.branch).eq("agencies.name", b.agency);
    if (partnerId) branchQuery = branchQuery.eq("partner_id", partnerId);
    const { data: branch, error: brErr } = await branchQuery.limit(1).maybeSingle();
    if (brErr) {
      return json({ ok: false, error: "Could not find the selected branch." }, 400);
    }

    // Resolve the target branch; if it does not exist yet, create the agency/branch
    // on the fly and capture the agency-default contact. A partner user's records
    // land pending_review under their own partner; an opndoor admin's land
    // confirmed (the admin creation IS the review) under p_partner_slug - the
    // admin's selected partner scope. The RPC is idempotent (case-insensitive).
    let branchId = branch?.id as string | undefined;
    if (!branchId) {
      const { data: targetId, error: tErr } = await userClient.rpc("create_referral_target", {
        p_agency: b.agency,
        p_branch: b.branch,
        p_agency_email: b.agencyContactEmail ?? null,
        p_agency_contact_name: b.agencyContactName ?? null,
        p_agency_phone: b.agencyContactPhone ?? null,
        p_branch_email: b.branchContactEmail ?? null,
        p_partner_slug: b.partner ?? null,
      });
      if (tErr) {
        return json({ ok: false, error: "Could not save the agency and branch details." }, 400);
      }
      branchId = targetId as string;
    }

    // agencies.name, the name the tenant dealt with, never the group above it: a
    // tenant who has only ever heard of "Regent's Lettings" reads the holding
    // company's name as a different company asking them for money. Falls back to
    // the name the picker sent, which is the name create_referral_target creates
    // the agency row with, so a branch created a moment ago still has one.
    const agencyName = (branch as { agencies?: { name?: string } } | null)?.agencies?.name ?? b.agency ?? null;

    // ------------------------------------------------------------------
    // WHICH RAIL, AND THEREFORE WHOSE DECISION THE TENANT IS BEING TOLD ABOUT.
    //
    // The opening line of the payment email follows the ROUTE and the REFERENCING
    // MODE, from one template with variables, never from per-agency copy. Both
    // facts are read off the row the RPC has just frozen rather than off the
    // request body, because that row is what the money and the mode were resolved
    // from and is what every later surface will read.
    //
    //   partner_id is the ROUTE partner, which on this path is the referrer's own
    //     partner. refers_own_stock true means the partner refers its own stock,
    //     so the tenant dealt with the agency: rail "agency". False, with an
    //     agency under it, is a supplier rail (Rightmove), whose wording is
    //     approved and must stay byte-identical: rail "supplier".
    //     applications.agency_id is NOT NULL, the direct rail included (it carries
    //     the house "Unattached" agency, whose partner does not refer its own
    //     stock), so a row with no agency is not a state this schema produces and
    //     the "direct" arm is a guard, not a path. It is copy-identical anyway:
    //     the direct rail's mode is always opndoor_referenced, and every rail's
    //     opndoor-referenced arm is the approved wording.
    //
    // THE MODE IS THE APPLICATION'S, never the partner's. Regent is
    // pre_referenced_open under a partner that is opndoor_referenced, so reading
    // the partner's mode gets exactly the reported referral wrong.
    //
    // One read per route rather than one per applicant: every applicant on a
    // joint tenancy arrived by the same one.
    const refersOwnStock = new Map<string, boolean>();
    // deno-lint-ignore no-explicit-any
    async function tenantCopy(app: any): Promise<FeeCopy> {
      const agencyId = app.agency_id ? String(app.agency_id) : null;
      const routeId = app.partner_id ? String(app.partner_id) : null;
      let rail: TenantRail = "direct";
      if (agencyId) {
        if (routeId && !refersOwnStock.has(routeId)) {
          const { data: p } = await userClient.from("partners").select("refers_own_stock").eq("id", routeId).maybeSingle();
          refersOwnStock.set(routeId, Boolean(p?.refers_own_stock));
        }
        // A read that comes back empty degrades to "supplier", which is the
        // approved wording that names nobody. Saying less is the safe failure;
        // naming the wrong company is not.
        rail = routeId && refersOwnStock.get(routeId) ? "agency" : "supplier";
      }
      return { rail, referencingMode: (app.referencing_mode as string | null) ?? null, agencyName };
    }

    // ------------------------------------------------------------------
    // THE PER-APPLICANT FINISH. Identical for a sole tenant and for each
    // member of a joint tenancy: their own money, their own email, their own
    // journey. The only thing a joint tenancy changes is how much each one owes,
    // and that was settled by create_joint_referral before this runs.
    // ------------------------------------------------------------------
    // deno-lint-ignore no-explicit-any
    /* tenantCount: how many applicants share this tenancy's fee. Passed in rather
       than counted here because the caller already knows it (apps.length on the
       joint path, 1 on the sole path), and a count query per applicant would ask
       the same question N times for one answer. A joint tenant's email and pay page
       must say the figure is a SHARE and how many ways the fee splits, or they are
       handed a number that does not divide into the basis beside it. */
    async function finishApplication(app: any, tenantCount = 1): Promise<FinishResult> {
      const appId = app.id as string;
      const ref = app.guarantee_ref as string;
      const rent = Number(app.monthly_rent);
      const sharePct = app.share_percent === null || app.share_percent === undefined ? 100 : Number(app.share_percent);
      // M1: the CHARGE is the snapshotted fee, not the rent. They are equal on every
      // single-tenant application at standard terms, so this changes no amount; it
      // changes where the amount comes from, which is what lets a 3- or 5-week fee,
      // or one applicant's share of a joint fee, arrive without touching Stripe code.
      const feeAmount = Number(app.fee_amount ?? app.monthly_rent);
      const tenantEmail = app.tenant_email as string;
      // #8 Title-case the address line for display in the email; postcode left raw.
      const propertyAddr = [titleCaseAddress(app.prop_addr1), app.prop_postcode].filter(Boolean).join(", ");
      // The email must name what Stripe is about to charge. It said the RENT,
      // which is the same number at standard terms and the wrong number the
      // moment a negotiated basis or a joint share is in play: a tenant would
      // have been told £2,000 and shown £1,153.85 at checkout.
      const amountGBP = `£${feeAmount.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
      /* AND WHAT THAT FIGURE IS MEASURED AGAINST. The amount above has been
         fee_amount since M1, but nothing told this email what the fee was a
         proportion OF, so GR-20837's tenant was asked for £692.31 under a
         sentence that flatly called the fee one month's rent. It was three
         weeks, under Regent's agreement. The basis is a fact passed in now.

         MEASURED AGAINST THE RENT THIS FEE WAS A PROPORTION OF, which for a
         joint applicant is their own share: share_amount is their slice of the
         rent (monthly_rent stays the whole tenancy's, because that is what the
         guarantee covers). Dividing a share of the fee by the whole rent would
         report every joint tenant as being on a discount. Where a share percent
         arrived without an amount, apportion rather than fall back to the whole
         rent, for the same reason. sharePct is 100 on a sole referral, so this
         is the whole rent there and nothing about it moves.

         Derived from the two numbers the tenant is shown rather than read from
         applications.fee_basis_weeks, so the words and the figure beside them
         cannot contradict each other. */
      const rentBase = app.share_amount != null ? Number(app.share_amount) : rent * (sharePct / 100);
      const feeBasisWeeks = feeBasisWeeksOf(feeAmount, rentBase);
      const basis = feeBasisPhrase(feeBasisWeeks);

      // ---- THE FORK, and it happens before Stripe is touched ---------------
      //
      // On a rail where OPNDOOR arranges the reference, there is nothing to pay
      // for yet: the tenant has a form to fill first, and a payment link is
      // simply the wrong link. They get an invite into the application journey
      // instead, and no Checkout session is created at all.
      //
      // GATED ON referencing_mode, which is snapshotted onto the row at creation.
      // The referral path is pre_referenced_open and does not enter this branch,
      // so its Stripe session, its payment email, its reminders and its 15-day
      // lapse are all untouched. That is the whole reason the fork is on mode
      // rather than on anything about who created the application.
      if (app.referencing_mode === "opndoor_referenced") {
        const service = createClient(SUPABASE_URL, SERVICE);

        // draft, NOT sent. 'sent' means a payment link is out, and it is what
        // expire_stale_applications selects on: leaving it there would lapse the
        // application on day 15 while the tenant was still filling the form.
        await service.from("applications").update({ status: "draft" }).eq("id", appId);

        const { data: inviteToken, error: invErr } = await service.rpc("mint_tenant_invite", {
          p_application: appId, p_days: 30,
        });
        if (invErr || !inviteToken) {
          console.log(JSON.stringify({ event: "invite_mint_failed", appId, message: invErr?.message }));
          throw new Error("Could not create the tenant's link.");
        }

        const inviteUrl = `${origin}/apply/invite?token=${inviteToken}`;
        const inviteRes = await sendMessage({
          to: tenantEmail,
          message: tenantInviteEmail({
            // The agency the referral was filed against, not "your letting
            // agent": the referrer may be a supplier.
            referrerName: agencyName,
            // NO FEE IS STATED HERE, deliberately, and that is why this call takes
            // no basis: nothing has been decided yet, so there is nothing to price.
            // monthlyRent is the tenancy's rent under a row that says "Monthly
            // rent", which is the one figure a tenant can check against their own
            // tenancy agreement. It is not, and must never become, the fee.
            propertyAddr, monthlyRent: b.rent ?? null, guaranteeRef: ref, inviteUrl,
          }),
        });

        await service.from("activity_log").insert({ application_id: appId, kind: "referral_created", message: "Referral created. The tenant has been invited to complete their application.", actor });
        await service.from("activity_log").insert({
          application_id: appId,
          kind: inviteRes.ok ? "tenant_invited" : "tenant_invite_failed",
          message: inviteRes.ok ? "Application link sent to the tenant." : `Application link not sent: ${inviteRes.error}`,
          actor: "System",
          visibility: inviteRes.ok ? "business" : "internal",
        });

        // emailSent/emailError, the same fields the Stripe branch returns and the
        // client reads: the toast reported "Tenant email not sent" on every invite
        // because this branch used `invited`/`email_error` instead. NOT a hardcoded
        // true: the application and invite token both exist by now, so refusing the
        // request would strand them; what must not happen is claiming the tenant was
        // contacted when nothing was sent. The caller gets the truth and the reason.
        return {
          id: appId, ref, paymentUrl: null,
          emailSent: inviteRes.ok,
          emailError: inviteRes.ok ? null : (inviteRes.error ?? "The invitation was not sent."),
        };
      }

      /* WHAT STRIPE CALLS THE FEE, in the same words as the email and the pay
         page. This branched on `feeAmount === rent`, a hand-rolled month test
         that is true only on standard terms: Regent's £692.31 against a £1,000
         rent failed it and was described as "the agreed guarantee fee" with no
         basis at all, while the email called the same fee a month's rent. The
         phrase now comes from feeBasisPhrase, the one place a basis is put into
         words, which is also what payment-page's line item reads, so the two
         checkouts and the email cannot describe one fee three ways. A basis that
         cannot be worked out still claims nothing: "agreed" is always true. */
      const feeLineDescription = sharePct < 100
        // A joint applicant is charged a share, and their basis is their share of
        // the fee against their share of the rent, so both facts belong here.
        ? `Your ${sharePct}% share of the guarantee fee for this tenancy${basis ? ` (${basis})` : ""}, for the opndoor Deed of Guarantee.`
        : basis
          ? `${basis.charAt(0).toUpperCase()}${basis.slice(1)}, for the opndoor Deed of Guarantee.`
          : "The agreed guarantee fee for this tenancy, for the opndoor Deed of Guarantee.";

      // Stripe test-mode Checkout Session for the guarantee fee.
     
      const stripe = new Stripe(STRIPE_SECRET, { httpClient: Stripe.createFetchHttpClient(), apiVersion: "2024-06-20" });
      const session = await stripe.checkout.sessions.create({
        // Bounds the window in DEFECTS.md 8. Without it a session stays payable
        // for Stripe's 24 hour default, so an application withdrawn after the
        // tenant opened checkout can still be paid from the open tab. 30 minutes
        // is long enough for a tenant to find their card and short enough that a
        // same-day withdrawal is not racing a live session.
        //
        // Stripe requires between 30 minutes and 24 hours, so this is the floor.
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "gbp",
            unit_amount: Math.round(feeAmount * 100),
            product_data: {
              name: `Guarantee fee - ${ref}`,
              description: feeLineDescription,
            },
          },
          quantity: 1,
        }],
        metadata: { application_id: appId, guarantee_ref: ref },
        client_reference_id: appId,
        // Public, unauthenticated tenant pages (the tenant is not a portal user).
        // {CHECKOUT_SESSION_ID} is substituted by Stripe and keys the confirmation.
        success_url: `${origin}/pay/confirmed?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/pay/retry?session_id={CHECKOUT_SESSION_ID}`,
      });

      const service = createClient(SUPABASE_URL, SERVICE);
      await service.from("applications").update({
        stripe_checkout_session_id: session.id, payment_url: session.url, payment_state: "awaiting",
      }).eq("id", appId);
      await service.from("activity_log").insert({ application_id: appId, kind: "referral_created", message: "Referral created and sent to the tenant.", actor });

      // #1 The payment email now points at the opndoor-hosted confirmation page
      // (/pay?token=...), not the raw Stripe URL. The page's Pay button mints a fresh
      // checkout session. utm_source tags the touch (initial send).
      const { data: pageToken } = await service.rpc("mint_payment_page_token", { p_ref: ref });

      /* THE REPORTED EMAIL. The amount was already fee_amount; what was missing
         was everything that explains it. With no feeBasisWeeks the small print
         fell back to "The fee is payable once.", which told a tenant looking at
         £692.31 against a £1,000 rent only that they would not be charged again,
         and with no copy the opening said opndoor was acting as guarantor when
         Regent had made the decision and opndoor had taken no view of this
         person at all.
         A supplier referral passes rail "supplier" here and gets, by the
         template's own rule, the approved email character for character. */
      const copy = await tenantCopy(app);

      // Never email a stale Stripe URL. Without a durable /pay?token link the send
      // is recorded as failed rather than carrying the 30-minute eager session URL;
      // the referral exists and an admin can resend, which mints a fresh link.
      const emailRes = pageToken
        ? await sendMessage({
            to: tenantEmail,
            message: paymentLinkEmail({
              propertyAddr, guaranteeRef: ref, amount: amountGBP,
              feeBasisWeeks, copy, tenantCount,
              payUrl: `${origin}/pay?token=${pageToken}&utm_source=initial`,
            }),
          })
        : { ok: false as const, error: "Could not mint a payment link." };
      // Partner-safe business message; the test-mode redirect target stays admin-only
      // (a separate internal entry), so no partner-facing surface exposes the review
      // address regardless of how it renders the log.
      await service.from("activity_log").insert({
        application_id: appId,
        kind: emailRes.ok ? "payment_email_sent" : "payment_email_failed",
        message: emailRes.ok ? "Payment email sent to the tenant." : `Payment email not sent: ${emailRes.error}`,
        actor: "System",
        visibility: emailRes.ok ? "business" : "internal",
      });
      // GATED ON THE REDIRECT ACTUALLY HAVING HAPPENED. This row used to be written
      // whenever the send succeeded, saying "Redirected to <address> (test mode)".
      // Once the redirect was removed, emailRes.to was the REAL TENANT, so every
      // application carried an audit entry asserting a safety property that was not
      // in force and naming the person who actually received the mail as the
      // redirect target. See DEFECTS.md 7.
      //
      // refundEmail.ts already had this guard, which is why the same row was
      // harmless there. Now they match.
      if (emailRes.ok && emailRes.redirected && emailRes.to) {
        await service.from("activity_log").insert({
          application_id: appId,
          kind: "payment_email_sent",
          message: `Redirected to ${emailRes.to} (EMAIL_REVIEW_ADDRESS is set on this environment). Intended recipient: ${emailRes.intended ?? "unknown"}.`,
          actor: "System",
          visibility: "internal",
        });
      }

      /* `?? null` on emailError, and only there. FinishResult declares
         `emailError: string | null`, but the sender returns `string |
         undefined` on failure, so an undefined was being returned as though
         it were null. Absent and null mean the same thing to every caller --
         no error -- but the two are not interchangeable across JSON: this is
         serialised to the browser, and an `undefined` property DISAPPEARS
         from the payload rather than arriving as null. A caller checking
         `'emailError' in result` would have read a failed send as a
         successful one. Found by `deno check`. */
      return { id: appId, ref, paymentUrl: session.url, emailSent: emailRes.ok, emailError: emailRes.ok ? null : (emailRes.error ?? null) };
    }

    // ------------------------------------------------------------------
    // A JOINT TENANCY. Two or more applicants, one tenancy, one fee.
    // ------------------------------------------------------------------
    const tenants = Array.isArray(b.tenants) ? b.tenants : null;
    if (tenants && tenants.length > 1) {
      const { data: rows, error: jErr } = await userClient.rpc("create_joint_referral", {
        p_branch: branchId,
        // share_percent is what the RPC enforces to 100; every other field is the
        // same set a sole tenant gives.
        p_tenants: tenants.map((t: Record<string, unknown>) => ({
          title: t.title, first: t.firstName, middle: t.middleName ?? null, last: t.lastName,
          dob: t.dob, email: t.email, phone: t.phone, share_percent: t.sharePercent,
        })),
        p_addr1: b.addr1, p_addr2: b.addr2 ?? null, p_city: b.city,
        p_county: b.county ?? null, p_postcode: b.postcode,
        p_rent: b.rent, p_tenancy_start: b.tenancyStart,
      });
      if (jErr) return json({ ok: false, error: jErr.message }, 400);
      const apps = (rows ?? []) as Array<Record<string, unknown>>;
      if (!apps.length) return json({ ok: false, error: "The tenancy was not created." }, 400);

      const results: FinishResult[] = [];
      for (const app of apps) results.push(await finishApplication(app, apps.length));

      // The tenancy answers as one thing. ref is the lead applicant's, which is
      // the reference the deed will carry; each tenant's own reference and link
      // are in `tenants` for the confirmation screen.
      const lead = results[0];
      return json({
        ok: true,
        ref: lead.ref,
        paymentUrl: lead.paymentUrl,
        emailSent: results.every((r) => r.emailSent),
        emailError: results.find((r) => r.emailError)?.emailError ?? null,
        tenancy: results.map((r, i) => ({
          ref: r.ref,
          name: `${apps[i].tenant_first_name} ${apps[i].tenant_last_name}`,
          email: apps[i].tenant_email,
          share: Number(apps[i].share_percent),
          amount: Number(apps[i].fee_amount),
          emailSent: r.emailSent,
        })),
      });
    }

    // ------------------------------------------------------------------
    // ONE TENANT. Untouched: the same RPC, the same extras write, and the same
    // finish, which is the function above called exactly once.
    // ------------------------------------------------------------------
    const solo = tenants?.[0] ?? b;
    const { data: appRes, error: rpcErr } = await userClient.rpc("create_referral", {
      p_branch: branchId, p_tenant_title: solo.title, p_first: solo.firstName, p_last: solo.lastName, p_dob: solo.dob,
      p_email: solo.email, p_phone: solo.phone, p_addr1: b.addr1, p_addr2: b.addr2 ?? null, p_city: b.city,
      p_county: b.county ?? null, p_postcode: b.postcode, p_rent: b.rent, p_tenancy_start: b.tenancyStart,
      // THE ROUTE, when the admin form stated one. The RPC refuses it from
      // anybody but an opndoor admin, and refuses a supplier the branch does
      // not sit under, so nothing here is trusted: this only carries it.
      p_route: routeId,
    });
    if (rpcErr) {
      return json({ ok: false, error: "Could not create the referral. Please check the details and try again." }, 400);
    }
    const app = Array.isArray(appRes) ? appRes[0] : appRes;

    // Fields the create RPC does not take as arguments, written straight after
    // the insert. They are optional and additive: the RPC's signature is shared
    // with the API path and widening it would be a drop-and-recreate on the one
    // function the referral path calls on every referral.
    {
      const extra: Record<string, unknown> = {};
      const middle = solo.middleName ?? b.middleName;
      const pct = solo.sharePercent ?? b.sharePercent;
      const amt = solo.shareAmount ?? b.shareAmount;
      if (typeof middle === "string" && middle.trim()) extra.tenant_middle_name = middle.trim();
      /* A SHARE IS BOUNDED, BECAUSE IT IS THE FEE BASIS. Round 5's lows. Both
         of these came straight off the request body and were written with the
         SERVICE key, so no policy and no check stood between a caller and the
         number the guarantee fee is calculated from: `rentBase` is
         `app.share_amount` when it is set. share_amount = 1 is a fee of
         approximately nothing.

         The bounds are the only ones the model allows: a share is a slice of
         one tenancy, so a percentage is 1..100 and an amount cannot exceed the
         rent it is a share of. Out of range is refused rather than clamped --
         silently charging a different number from the one asked for is how a
         reconciliation argument starts. */
      const rentCap = Number(app.monthly_rent ?? 0);
      if (pct !== null && pct !== undefined) {
        const n = Number(pct);
        if (!Number.isFinite(n) || n <= 0 || n > 100) {
          return json({ ok: false, error: "A share is between 1 and 100 per cent." }, 400);
        }
        extra.share_percent = n;
      }
      if (amt !== null && amt !== undefined) {
        const n = Number(amt);
        if (!Number.isFinite(n) || n <= 0 || (rentCap > 0 && n > rentCap)) {
          return json({ ok: false, error: "A share cannot be more than the rent it is a share of." }, 400);
        }
        extra.share_amount = n;
      }
      if (Object.keys(extra).length) {
        const svc = createClient(SUPABASE_URL, SERVICE);
        await svc.from("applications").update(extra).eq("id", app.id);
        Object.assign(app, extra);
      }
    }

    const res = await finishApplication(app);
    // The agent-rail invite branch has never returned a paymentUrl and the
    // client has never read one from it; this keeps the two responses exactly
    // as they were rather than adding a null field to one of them.
    return app.referencing_mode === "opndoor_referenced"
      ? json({ ok: true, id: res.id, ref: res.ref, emailSent: res.emailSent, emailError: res.emailError })
      : json({ ok: true, ref: res.ref, paymentUrl: res.paymentUrl, emailSent: res.emailSent, emailError: res.emailError });
  } catch (e) {
    return json({ ok: false, error: "Could not create the referral. Please try again." }, 500);
  }
});
