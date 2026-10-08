// =====================================================================
// payment-page (verify_jwt = false)
//
// #1 Backend for the public tenant payment confirmation page (/pay?token=...).
// Security is the application-scoped token (payment_page_tokens), not a login; the
// tenant is never a portal user. Four actions:
//   view     - validate the token, log the first view, return public-safe data.
//   sign     - mint a PandaDoc signing link for a paid, unsigned deed. Matt,
//              2026-10-03: "Tenant payment link opened after payment: reflect
//              where they actually are ... If paid but not yet signed: show the
//              'Sign your deed now' button." The post-checkout page has had
//              that button for a while; an OLD link lands here instead and had
//              no way to offer it, because payment-confirmation mints from a
//              Stripe session id and a saved link has none.
//   checkout - create a fresh Stripe Checkout Session (robust to link expiry and
//              the #13 expired-reinstate case) and return its URL to redirect to.
//   decline  - #14 tenant self-decline: withdraw the application (tenant-flagged),
//              idempotent and token-scoped, returning the resulting status.
// No email/PII beyond what the tenant already received is returned.
//
// Stripe key mode must match the project: sk_test_ on a non-production project,
// sk_live_ everywhere else. See _shared/stripeMode.ts.
// =====================================================================
import { namedParty } from "../_shared/namedParty.ts";
import Stripe from "npm:stripe@^17";
import { createClient } from "npm:@supabase/supabase-js@2";
import { titleCaseAddress } from "../_shared/text.ts";
import { stripeSecretFor, stripePublishableFor } from "../_shared/livemodeCredentials.ts";
// The same two functions the tenant's emails price themselves with. Imported
// rather than reimplemented so the email, this page and the Stripe line item
// cannot describe one fee three different ways.
import { feeBasisPhrase, feeBasisWeeksOf, feeLineDescriptionFor } from "../_shared/emailTemplates.ts";
/* The same minting the post-checkout page uses, from the same place: two
   implementations of "issue a signing link" is two sets of PandaDoc
   behaviour to keep in step. */
import { getSigningLink } from "../_shared/pandadoc.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/* THE DATE THE REST OF THE PRODUCT SHOWS. Matt, 2026-10-01: the tenant
   payment page shows "dates as '20 Nov 2026'".

   This said 20/11/2026, which is the one format in the product that can be
   read two ways: an American tenant reads 03/09/2026 as the third of
   September and a British one as the ninth of March, and this is the page
   where somebody is being told when a guarantee starts before paying for
   it. The month is spelled, so there is nothing to misread.

   The month table is written out rather than taken from toLocaleString,
   for the same reason `src/lib/format.ts` carries one: Node's en-GB gives
   "Sept" for September, which is four characters where every other month
   is three and is not what the portal prints. */
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ddmmyyyy(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTH_SHORT[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}
// Guarantee expiry = tenancy start + 12 months - 1 day.
function guaranteeExpiryLabel(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1] + 1, +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() - 1);
  return ddmmyyyy(d.toISOString());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");
    const service = createClient(SUPABASE_URL, SERVICE);

    const body = await req.json().catch(() => ({}));
    const token = String(body.token ?? "");
    const action = String(body.action ?? "view");
    if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ ok: false, error: "Missing or invalid token." }, 400);

    // Resolve the token -> application (service role; the token is the authorisation).
    const { data: tok } = await service.from("payment_page_tokens")
      .select("application_id, guarantee_ref, expires_at, first_viewed_at")
      .eq("token", token).maybeSingle();
    if (!tok) return json({ ok: false, error: "This link is not valid." }, 404);
    if (new Date(tok.expires_at).getTime() < Date.now()) return json({ ok: false, error: "This link has expired." }, 410);

    const { data: app } = await service.from("applications")
      // share_amount is this tenant's share of the RENT on a joint tenancy (null
      // when they are the only tenant), and it is what the fee's basis has to be
      // measured against. referencing_mode, agency_id, the agency's own name and
      // the partner's refers_own_stock are the four facts that decide whose
      // decision this page is describing: see the rail block below.
      .select("id, guarantee_ref, tenant_title, tenant_first_name, tenant_last_name, tenant_email, prop_addr1, prop_addr2, prop_city, prop_postcode, monthly_rent, fee_amount, share_amount, tenancy_start, status, payment_state, livemode, referencing_mode, agency_id, agency:agencies(name), partner:partners(slug, name, refers_own_stock), tenancy_id, deed_state, pandadoc_document_id")
      .eq("id", tok.application_id).maybeSingle();
    if (!app) return json({ ok: false, error: "This link is not valid." }, 404);

    // The Stripe key is chosen by the APPLICATION, not by the project. A sandbox
    // application is charged with sk_test_ even on production, so a developer
    // rehearsing the tenant's payment journey uses a test card and no real money
    // moves. Resolved after the application is known, which is why the old
    // module-scope read of STRIPE_SECRET_KEY had to go.
    const stripeSecret = stripeSecretFor(app.livemode === true);
    if (!stripeSecret.ok) return json({ ok: false, error: stripeSecret.error }, 400);
    const STRIPE_SECRET = stripeSecret.value;

    // deno-lint-ignore no-explicit-any
    const partnerRow = (Array.isArray(app.partner) ? (app.partner as any)[0] : (app.partner as any)) ?? null;
    /* WALK FIX 33, found by its last sentence: "Check every other email for
       the house account name." This read `partnerRow.name`, which on the
       agency rail is the house partner "Opndoor Agents" -- shown to a
       tenant on the screen where they hand over a card, naming a company
       they have never dealt with. PayLanding's agency-arranged branch
       already names the agency, which is why this survived: it is the
       other branch.

       Same rule as the invite, same helper. The fallback differs because
       the reader does: a tenant reads "your letting agent", which is true
       and names no plumbing. */
    // The agency row is read again further down; this is the same shape.
    // deno-lint-ignore no-explicit-any
    const agencyForName = (Array.isArray(app.agency) ? (app.agency as any)[0] : (app.agency as any)) ?? null;
    const partnerName = namedParty({
      partnerSlug: partnerRow?.slug ?? null,
      partnerName: partnerRow?.name ?? null,
      agencyName: agencyForName?.name ?? null,
    }) || "your letting agent";
    const rent = Number(app.monthly_rent ?? 0);
    // M1: charge the snapshotted fee. Identical to rent on every current row.
    const feeAmount = Number(app.fee_amount ?? app.monthly_rent ?? 0);
    // WHAT THEY ARE ABOUT TO BE CHARGED, not the rent. These were the same
    // number for as long as the fee was always one month's rent; they are not
    // the same number for an agency on a weeks-of-rent basis, and showing the
    // rent while charging the fee is a consumer-facing misstatement of price.
    const feeGBP = `£${feeAmount.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
    /* AND WHAT THAT FIGURE IS MEASURED AGAINST. The amount above was already
       right; nothing on this page said what it was, so GR-20837 showed a tenant
       £692.31 under "Guarantee fee" with a £1,000 rent above it and left them to
       guess, while their email called the same fee one month's rent. The basis
       is a fact now, stated in the same words everywhere.

       Measured against the rent THIS fee was a proportion of: a joint tenant's
       own share, not the tenancy's whole rent. Dividing a share of the fee by the
       whole rent would report every joint tenant as being on a discount.

       FROM app.fee_amount ALONE, with no fall back to monthly_rent, and this is
       the subtle half. feeAmount above falls back to the rent because the page
       has to show a figure; the BASIS must not, because rent divided by rent is
       exactly 52/12 weeks, so the fallback would manufacture "one month's rent"
       out of a row that never recorded a fee and state it as a verified fact. An
       unknown fee has an unknown basis, and every surface here says nothing
       rather than the commonest answer. */
    const feeBasisWeeks = feeBasisWeeksOf(app.fee_amount, app.share_amount ?? app.monthly_rent);
    const feeBasis = feeBasisPhrase(feeBasisWeeks);
    /* HOW MANY WAYS THIS FEE SPLITS. A joint tenancy is priced once and charged by
       share, so every figure on this page is a share and the basis beside it is a
       fact about the whole tenancy. Without the count the page can state the share
       and the basis and leave the tenant to reconcile £1,061.54 against "5 weeks of
       rent", which does not reconcile and reads as our arithmetic error.
       One count per tenancy, and a sole referral has no tenancy_id at all. */
    let tenantCount = 1;
    if (app.tenancy_id) {
      const { count } = await service.from("applications")
        .select("id", { count: "exact", head: true })
        .eq("tenancy_id", app.tenancy_id);
      if (count && count > 1) tenantCount = count;
    }
    /* WHICH RAIL, AND THEREFORE WHOSE DECISION THIS PAGE IS DESCRIBING. The same
       ruling the payment emails now follow, because a Regent tenant who reads
       "the agency arranged this" in the email and then "opndoor stands as your
       guarantor" on the page linked from it has been told two different things
       about who decided they needed a guarantee.

       referencing_mode is read off the APPLICATION, never off the partner: Regent
       is pre_referenced_open under a partner that is opndoor_referenced, so the
       partner's mode is the wrong answer. The name is agencies.name, the one the
       tenant dealt with, never the group above it. */
    // deno-lint-ignore no-explicit-any
    const agencyRow = (Array.isArray(app.agency) ? (app.agency as any)[0] : (app.agency as any)) ?? null;
    const agencyName = ((agencyRow?.name ?? "") as string).trim() || null;
    const referencingMode = (app.referencing_mode ?? null) as string | null;
    const rail: "agency" | "supplier" | "direct" = !app.agency_id
      ? "direct"
      : partnerRow?.refers_own_stock === true ? "agency" : "supplier";
    /* Mirrors isAgencyArranged in _shared/emailTemplates.ts, which is internal to
       that file: an agency referral opndoor did not reference, and only when we
       actually know the agency's name, because copy naming nobody is worse than
       the approved wording. The supplier rail never qualifies, which is what keeps
       Rightmove's page byte-identical. */
    const agencyArranged = rail === "agency" && !!agencyName
      && referencingMode != null && referencingMode !== "opndoor_referenced";
    /* WHAT THE CHECKOUT PAGE AND THE CARD STATEMENT CALL THE FEE. Both line items
       branched on feeAmount === rent and hand-rolled their own two sentences, so a
       Regent tenant paying £692.31 saw "the agreed guarantee fee for this tenancy"
       on Stripe while their email called it a month's rent. One phrase, from the
       same helper the email uses. A fee whose basis cannot be worked out still
       claims nothing: it is described as agreed, which is always true. */
    /* AND ON A JOINT TENANCY IT SAYS WHOSE SHARE IT IS. Matt, 2026-10-03:
       "Stripe checkout description on joint tenancies: 'Your 10% share of the
       guarantee fee (5 weeks of rent for the whole tenancy)'."

       THE SENTENCE IS IN _shared/emailTemplates.ts, with feeBasisPhrase and
       the ruling that this wording is the same on every surface. This line
       item was the one place still composing its own, and it was the one
       surface that still had the joint-tenancy defect: "5 weeks of rent"
       above £1,061.54, at the card screen. */
    const feeLineDescription = feeLineDescriptionFor(feeBasisWeeks, tenantCount);
    /* Trimmed and only when it looks like an address: Stripe rejects the
       whole session on a malformed customer_email, and a referral with a
       typo in it must still be payable. */
    const rawEmail = ((app.tenant_email ?? "") as string).trim();
    const tenantEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail) ? rawEmail : null;
    const tenantName = [app.tenant_title, app.tenant_first_name, app.tenant_last_name].filter((x) => (x ?? "").toString().trim()).join(" ").trim();
    // #8 Display-layer title-casing of the property address (postcode left raw).
    const propFull = [titleCaseAddress(app.prop_addr1), titleCaseAddress(app.prop_addr2), titleCaseAddress(app.prop_city), app.prop_postcode].filter(Boolean).join(", ");
    const isRefunded = app.payment_state === "refunded";
    const isPaid = !isRefunded && (app.status === "paid" || app.status === "deed" || app.payment_state === "paid");
    const isExpired = app.status === "expired";
    const isClosed = app.status === "withdrawn" || isRefunded;
    const payable = !isRefunded && (app.status === "sent" || app.status === "expired");

    const publicData = {
      ref: app.guarantee_ref,
      partnerName,
      tenantName,
      tenantTitle: app.tenant_title ?? "",
      addr1: titleCaseAddress(app.prop_addr1 ?? ""),
      postcode: app.prop_postcode ?? "",
      propFull,
      tenancyStart: ddmmyyyy(app.tenancy_start),
      guaranteeExpiry: guaranteeExpiryLabel(app.tenancy_start),
      monthlyRent: rent,
      // The tenancy's rent, then this tenant's share of it where there is one.
      // A joint tenant pays a share of the fee, so a page that prints the whole
      // tenancy's rent beside "3 weeks of rent" contradicts its own arithmetic.
      rentShare: app.share_amount == null ? null : Number(app.share_amount),
      // How many tenants share this tenancy's fee. 1 for a sole referral, which is
      // every referral on the supplier and direct rails.
      tenantCount,
      feeGBP,
      // The words for the figure in feeGBP: "one month's rent", "3 weeks of
      // rent", or null when the basis cannot be worked out, in which case the
      // page must say nothing about a basis rather than assume the common one.
      feeBasis,
      // Whose decision this is. agencyArranged is the one flag the copy turns on;
      // rail, referencingMode and agencyName are carried so the page can say it
      // in the tenant's own terms and so an unexpected combination is diagnosable
      // from the response rather than only from the row.
      rail,
      referencingMode,
      agencyName,
      agencyArranged,
      status: app.status,
      isPaid,
      isExpired,
      isClosed,
      payable,
      /* WHERE THE DEED HAS GOT TO. Matt, 2026-10-03: "If the deed is signed:
         'Your guarantee fee is paid and your Deed of Guarantee is signed.
         Nothing more is needed. A copy was emailed to you.' If paid but not
         yet signed: show the 'Sign your deed now' button."

         THREE BOOLEANS RATHER THAN THE RAW STATE, which is what
         payment-confirmation already returns and for its reason: the page has
         to answer "can this tenant act", and `deed_state` has values that are
         none of its business. `pandadoc_document_id` is required for ready,
         because a state of awaiting_tenant with no document is a deed being
         prepared, not one waiting on them.

         NO DOCUMENT ID IS RETURNED. The id is ours; what the tenant gets is a
         signing link, minted on demand by the `sign` action below. */
      deedReady: app.deed_state === "awaiting_tenant" && !!app.pandadoc_document_id,
      deedSigned: app.deed_state === "executed",
      deedError: app.deed_state === "error",
    };

    if (action === "view") {
      // #106 Log the first view ONCE, atomically. Two concurrent view requests (a
      // double-mount, a retry, two tabs) both read first_viewed_at as null and both
      // logged, so the tenant view showed up twice. Claim it with a single-winner
      // conditional update (WHERE first_viewed_at IS NULL): only the row that was
      // actually null returns, and only that winner writes the activity entry.
      const { data: claimed } = await service.from("payment_page_tokens")
        .update({ first_viewed_at: new Date().toISOString() })
        .eq("token", token).is("first_viewed_at", null)
        .select("token");
      if (claimed && claimed.length > 0) {
        await service.from("activity_log").insert({
          application_id: app.id, kind: "tenant_viewed_payment_page",
          message: "Tenant viewed the payment page.", actor: "Tenant", visibility: "business",
        });
      }
      return json({ ok: true, ...publicData });
    }

    /* "SIGN YOUR DEED NOW", FROM A SAVED LINK.

       MIRRORS payment-confirmation's OWN sign action, including its rate
       limit and its reasoning, because it is the same act reached from the
       other door: minting is an external PandaDoc call that issues a live
       7-day link, so it is capped per token on top of the limits above, and a
       leaked token cannot mint unlimited signing links. The link itself is
       scoped to the recipient by PandaDoc; possession of the token is the
       bearer capability by design, exactly as it is for paying.

       ONLY WHEN THERE IS SOMETHING TO SIGN. A deed still being prepared, or
       already signed, returns deedReady false and the page says where they
       are rather than opening an empty session. */
    if (action === "sign") {
      const ready = app.deed_state === "awaiting_tenant" && !!app.pandadoc_document_id;
      if (!ready) return json({ ok: true, deedReady: false, deedSigned: app.deed_state === "executed" });
      const { data: mintOk } = await service.rpc("bump_rate_limit", { p_key: `paysign_token:${token}`, p_limit: 10, p_window_secs: 3600 });
      if (mintOk === false) return json({ ok: false, error: "Too many attempts, please try again later." }, 429);
      const { link, detail } = await getSigningLink(
        app.pandadoc_document_id as string, app.tenant_email as string, app.livemode === true);
      if (!link) console.log(JSON.stringify({ event: "paysign_token_failed", ref: app.guarantee_ref, detail: detail ?? null }));
      return json({ ok: true, deedReady: true, signingUrl: link });
    }

    if (action === "decline") {
      const reason = body.reason ? String(body.reason) : "other";
      const { data: result, error } = await service.rpc("decline_application_by_token", { p_token: token, p_reason: reason });
      if (error) return json({ ok: false, error: "Could not record that. Please contact support@opndoor.co." }, 500);
      return json({ ok: true, status: result });
    }

    if (action === "checkout") {
      // Eligible to pay: Sent or Expired (paying reinstates), or a tenant-declined
      // withdrawal (money wins). Never a staff withdrawal, an already-paid app or a deed.
      if (!payable) {
        // Re-check the tenant-declined case which item 14 allows to reinstate.
        const { data: full } = await service.from("applications").select("withdrawn_by_tenant, status").eq("id", app.id).maybeSingle();
        const canReinstate = full?.status === "withdrawn" && full?.withdrawn_by_tenant === true;
        if (!canReinstate) return json({ ok: false, error: isPaid ? "This fee has already been paid." : "This application is closed.", status: app.status }, 409);
      }
      // The mode check used to live here, inside the checkout branch only, so
      // view and decline ran with no check at all. stripeSecretFor now resolves
      // and validates once at the top of the handler, against the APPLICATION
      // rather than the project, which covers all three actions.
      const utm = typeof body.utm_source === "string" ? body.utm_source.slice(0, 40) : "confirmation_page";
      // The Stripe API version is pinned at 2024-06-20 across every function; the
      // SDK types only admit their latest literal, so this asserts the pin rather
      // than bumping the version (which would change API behaviour).
   
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
              name: `Guarantee fee - ${app.guarantee_ref}`,
              description: feeLineDescription,
            },
          },
          quantity: 1,
        }],
        metadata: { application_id: app.id, guarantee_ref: app.guarantee_ref, utm_source: utm },
        client_reference_id: app.id,
        /* THE TENANT'S OWN ADDRESS, PREFILLED. Matt, 2026-10-03: "prefill the
           tenant's own email from the application (it currently shows
           email@example.com for GR-25236)."

           Nothing was passed, so Stripe showed its own placeholder and the
           tenant had to retype an address we already hold -- and whatever
           they typed is where Stripe's receipt went, which is how a receipt
           ends up somewhere the application has never heard of. GR-25236
           holds kelly@test.com.

           `customer_email` PREFILLS AND STAYS EDITABLE, which is the right
           one of the two: a tenant paying from a shared mailbox can still
           correct it, where `customer` would lock it. */
        ...(tenantEmail ? { customer_email: tenantEmail } : {}),
        // A signed-in tenant paying from the portal asks for a portal return, so
        // Stripe lands them back on their own status screen rather than the
        // referral confirmation page. One checkout, two return destinations.
        success_url: body.return === "portal"
          ? `${APP_URL}/apply?paid=guarantee`
          : `${APP_URL}/pay/confirmed?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: body.return === "portal"
          ? `${APP_URL}/apply?paid=cancelled`
          : `${APP_URL}/pay?token=${token}`,
      });
      await service.from("applications").update({
        stripe_checkout_session_id: session.id, payment_url: session.url, payment_state: "awaiting",
      }).eq("id", app.id);
      return json({ ok: true, url: session.url });
    }

    if (action === "checkout_embedded") {
      // Same session as `checkout`, but Stripe hosts the card fields inline in
      // the tenant's own page (ui_mode:embedded, redirect_on_completion:never)
      // instead of redirecting to Stripe. It still emits checkout.session.completed
      // with the same metadata, so the webhook -> sent->paid -> deed -> receipt
      // path is untouched. Returns the client_secret and the mode-matched
      // publishable key for the mount.
      if (!payable) {
        const { data: full } = await service.from("applications").select("withdrawn_by_tenant, status").eq("id", app.id).maybeSingle();
        const canReinstate = full?.status === "withdrawn" && full?.withdrawn_by_tenant === true;
        if (!canReinstate) return json({ ok: false, error: isPaid ? "This fee has already been paid." : "This application is closed.", status: app.status }, 409);
      }
     
      const stripe = new Stripe(STRIPE_SECRET, { httpClient: Stripe.createFetchHttpClient(), apiVersion: "2024-06-20" });
      const session = await stripe.checkout.sessions.create({
        ui_mode: "embedded",
        redirect_on_completion: "never",
        // The inline card form is the same purchase as the hosted one above
        // and prefills the same address; see the note there.
        ...(tenantEmail ? { customer_email: tenantEmail } : {}),
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "gbp",
            unit_amount: Math.round(feeAmount * 100),
            product_data: {
              name: `Guarantee fee - ${app.guarantee_ref}`,
              // Same sentence as the redirect checkout above, from the same
              // const: the inline card form and the hosted one are the same
              // purchase and used to be able to describe it differently.
              description: feeLineDescription,
            },
          },
          quantity: 1,
        }],
        metadata: { application_id: app.id, guarantee_ref: app.guarantee_ref, utm_source: "embedded" },
        client_reference_id: app.id,
      });
      await service.from("applications").update({
        stripe_checkout_session_id: session.id, payment_state: "awaiting",
      }).eq("id", app.id);
      const pk = stripePublishableFor(app.livemode === true);
      return json({ ok: true, clientSecret: session.client_secret, publishableKey: pk.ok ? pk.value : null });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (e) {
    return json({ ok: false, error: "The payment page could not complete that request." }, 500);
  }
});
