const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(cors());

// ─── Plans ────────────────────────────────────────────────────────────────────
// Lineup as of Oct 2026: Level 1 ('small') and Level 2 ('medium') retired; 'large' is now Ai+Plus.
// Each plan charges its Stripe product's *default price*, so price changes (including the
// Jan 1, 2027 increases made by swap-price.js) need no redeploy here.
//   basic  - Basic Map Listing product ($995/yr; old $795 price was price_1TRcyB7kCFBD2fZagxnSCRSr)
//   aiplus - Ai+Plus product (formerly Level 3), located via its $2,395 price
const PLAN_SOURCES = {
    basic:  { product: process.env.STRIPE_PRODUCT_BASIC || 'prod_VMZTrsXXIQXUK6' },
    aiplus: { product: process.env.STRIPE_PRODUCT_AIPLUS, seedPrice: 'price_1TRcxx7kCFBD2fZaRYII5PbD' }
};
PLAN_SOURCES.large = PLAN_SOURCES.aiplus;   // key subscribe.html sends

// Resolve plan -> current default price, cached briefly to avoid a Stripe lookup per page view.
const PRICE_CACHE_MS = 5 * 60 * 1000;
const priceCache = {};

async function resolvePrice(plan) {
    const source = PLAN_SOURCES[plan];
    if (!source) return null;

    const cached = priceCache[plan];
    if (cached && Date.now() - cached.at < PRICE_CACHE_MS) return cached.price;

    let productId = source.product;
    if (!productId) {
        const seed = await stripe.prices.retrieve(source.seedPrice);
        productId = typeof seed.product === 'string' ? seed.product : seed.product.id;
    }

    const product = await stripe.products.retrieve(productId, { expand: ['default_price'] });
    const price = product.default_price;
    if (!price || !price.active || !price.recurring) {
        throw new Error(`Product ${productId} has no active recurring default price`);
    }

    priceCache[plan] = { price, at: Date.now() };
    return price;
}

// ─── V1 Webhook (Snapshot / charming-spark) ───────────────────────────────────
app.post('/webhooks/v1', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_V1_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('V1 webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    console.log('V1 event received:', event.type);
    res.status(200).json({ received: true });
});

// ─── V2 Webhook (Thin / dynamic-wonder) ──────────────────────────────────────
app.post('/webhooks/v2', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = await stripe.parseEventNotification(
            req.body,
            sig,
            process.env.STRIPE_V2_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('V2 webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    console.log('V2 event received:', event.type);
    res.status(200).json({ received: true });
});

// ─── JSON middleware for all other routes ─────────────────────────────────────
app.use(express.json());

// ─── Plan prices (shown on subscribe.html) ────────────────────────────────────
app.get('/plans', async (req, res) => {
    try {
        const plans = {};
        for (const plan of ['basic', 'aiplus']) {
            const price = await resolvePrice(plan);
            plans[plan] = { amount: price.unit_amount / 100, currency: price.currency, interval: price.recurring.interval };
        }
        plans.large = plans.aiplus;
        res.json(plans);
    } catch (error) {
        console.error('Plan lookup error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ─── Checkout Session ─────────────────────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
    try {
        const {
            plan, firstName, lastName, email, organization,
            departmentUrl, streetAddress, city, stateProvince,
            postalCode, country, edCategory, planName,
            consent_listings, consent_timestamp, consent_text
        } = req.body;

        const price = await resolvePrice(plan);
        if (!price) return res.status(400).json({ error: 'Invalid plan selected' });

        const subscriberMeta = {
            Subscriber_Name:   `${firstName} ${lastName}`,
            Email:             email,
            Organization:      organization,
            Department_URL:    departmentUrl  || 'N/A',
            Street_Address:    streetAddress  || 'N/A',
            City:              city           || 'N/A',
            State_Province:    stateProvince  || 'N/A',
            Postal_Code:       postalCode     || 'N/A',
            Country:           country        || 'N/A',
            ED_Category:       edCategory,
            Plan_Selected:     planName || plan.toUpperCase(),
            consent_listings,
            consent_timestamp,
            consent_text,
        };

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price: price.id, quantity: 1 }],
            mode: 'subscription',
            customer_email: email,
            metadata: subscriberMeta,
            subscription_data: { metadata: subscriberMeta },
            success_url: 'https://www.fastlocations.ai/success.html',
            cancel_url:  'https://www.fastlocations.ai/subscribe.html',
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Stripe error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
const { scoreLocations } = require('./locationScoring');

app.post('/api/score-locations', express.json({ limit: '5mb' }), (req, res) => {
  try {
    const { projectCriteria, candidates } = req.body;
    res.json(scoreLocations(projectCriteria, candidates));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.listen(PORT, () => {
    console.log(`✅ FastLocations Backend running on port ${PORT}`);
});