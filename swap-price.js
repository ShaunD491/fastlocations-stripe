// Railway cron job: on/after SWAP_DATE, make each plan's new 2027 price its product's default price.
//   Ai+Plus:           $2,395 -> $2,995
//   Basic Map Listing: $995   -> $1,295
// server.js charges each product's default price, so new checkouts pick up the increase within
// ~5 minutes. Existing subscriptions are untouched (Stripe never re-prices them automatically).
//
// Idempotent: safe to run daily. Before SWAP_DATE, or once a swap is done, it logs and moves on.
// Each plan is handled independently; exits 1 if any plan fails so the run shows as failed in Railway.
//
// Variables:
//   STRIPE_SECRET_KEY   - same key as the web service
//   AIPLUS_NEW_PRICE    - optional override of the $2,995 Ai+Plus price (default below)
//   BASIC_NEW_PRICE     - optional override of the $1,295 Basic Map Listing price (default below)
//   SWAP_DATE           - optional, ISO timestamp; default 2027-01-01T00:00:00-05:00 (midnight Eastern)
//   ARCHIVE_OLD_PRICE   - optional, "true" to archive each old default price after swapping
//                         (archiving only blocks new use; existing subscribers keep renewing on it)
//   DRY_RUN             - optional, "true" to validate and report without changing anything

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const SWAP_DATE = new Date(process.env.SWAP_DATE || '2027-01-01T00:00:00-05:00');
const ARCHIVE_OLD = process.env.ARCHIVE_OLD_PRICE === 'true';
const DRY_RUN = process.env.DRY_RUN === 'true';

// Each new price must belong to the same product the web service charges for that plan
// (see PLAN_SOURCES in server.js) - this catches a price created on the wrong product.
const SWAPS = [
    { plan: 'Ai+Plus', newPrice: process.env.AIPLUS_NEW_PRICE || 'price_1ULqVR7kCFBD2fZassSYtXJt', expectedAmount: 299500,
      product: process.env.STRIPE_PRODUCT_AIPLUS, seedPrice: 'price_1TRcxx7kCFBD2fZaRYII5PbD' },
    { plan: 'Basic Map Listing', newPrice: process.env.BASIC_NEW_PRICE || 'price_1ULqU07kCFBD2fZa7v7nq3JT', expectedAmount: 129500,
      product: process.env.STRIPE_PRODUCT_BASIC || 'prod_VMZTrsXXIQXUK6' }
];

const idOf = ref => (typeof ref === 'string' ? ref : ref && ref.id);
const fmt = p => `${p.id} ($${(p.unit_amount / 100).toLocaleString('en-US')}/${p.recurring.interval})`;

async function swap({ plan, newPrice: newPriceId, expectedAmount, product: productId, seedPrice }) {
    console.log(`\n== ${plan}`);
    if (!newPriceId) throw new Error(`new price variable is not set`);

    if (!productId) productId = idOf((await stripe.prices.retrieve(seedPrice)).product);

    // Validate the new price every run, so a bad setup is caught well before Jan 1.
    const newPrice = await stripe.prices.retrieve(newPriceId);
    if (idOf(newPrice.product) !== productId) throw new Error(`${newPriceId} belongs to ${idOf(newPrice.product)}, expected ${productId}`);
    if (!newPrice.active) throw new Error(`${newPriceId} is archived`);
    if (!newPrice.recurring || newPrice.recurring.interval !== 'year') throw new Error(`${newPriceId} is not a yearly recurring price`);
    if (newPrice.unit_amount !== expectedAmount) throw new Error(`${fmt(newPrice)} should be $${(expectedAmount / 100).toLocaleString('en-US')}/year`);

    const product = await stripe.products.retrieve(productId);
    const oldPriceId = idOf(product.default_price);
    console.log(`Product: ${product.name} (${productId})`);
    console.log(`Current default: ${oldPriceId}  ->  new: ${fmt(newPrice)}`);

    if (oldPriceId === newPriceId) {
        console.log('Already swapped - nothing to do.');
        return;
    }
    if (Date.now() < SWAP_DATE.getTime()) {
        console.log(`Not yet - swap scheduled for ${SWAP_DATE.toISOString()}. Setup validated.`);
        return;
    }
    if (DRY_RUN) {
        console.log('DRY_RUN - would swap now.');
        return;
    }

    await stripe.products.update(productId, { default_price: newPriceId });
    console.log(`✅ Default price for ${product.name} is now ${fmt(newPrice)}`);

    if (ARCHIVE_OLD && oldPriceId) {
        await stripe.prices.update(oldPriceId, { active: false });
        console.log(`Archived old price ${oldPriceId}`);
    }
}

async function main() {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    if (isNaN(SWAP_DATE)) throw new Error(`SWAP_DATE is not a valid date: ${process.env.SWAP_DATE}`);

    let failed = 0;
    for (const s of SWAPS) {
        try {
            await swap(s);
        } catch (err) {
            failed++;
            console.error(`❌ ${s.plan} price swap failed: ${err.message}`);
        }
    }
    if (failed) process.exit(1);
}

main().catch(err => {
    console.error('❌ Price swap failed:', err.message);
    process.exit(1);
});
