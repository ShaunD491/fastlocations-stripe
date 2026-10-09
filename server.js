const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(cors());

// ─── Plans ────────────────────────────────────────────────────────────────────
// Lineup as of Oct 2026: Level 1 ('small') and Level 2 ('medium') retired; 'large' is now Ai+Plus.
// Each plan charges the default price of its current Stripe product. On PRICE_INCREASE_AT the
// plans switch to their 2027 products (Ai+Plus $2,395 -> $2,995, Basic $995 -> $1,295);
// subscribe.html reads /plans, so the page follows automatically. Existing subscriptions are untouched.
const PRICE_INCREASE_AT = new Date(process.env.PRICE_INCREASE_AT || '2027-01-01T00:00:00-05:00');
const PLAN_PRODUCTS = {
    basic:  { current: 'prod_VMZTrsXXIQXUK6', from2027: 'prod_VMZd29AefF9f6S' },  // Basic Map Listing (+ 2027)
    aiplus: { current: 'prod_UQTvmLzMFKcVDl', from2027: 'prod_VMZePDnI2wx6Da' }   // AI+Plus (+ 2027)
};
PLAN_PRODUCTS.large = PLAN_PRODUCTS.aiplus;   // key subscribe.html sends

// Resolve plan -> its product's default price, cached briefly to avoid a Stripe lookup per page view.
const PRICE_CACHE_MS = 5 * 60 * 1000;
const priceCache = {};

async function resolvePrice(plan) {
    const products = PLAN_PRODUCTS[plan];
    if (!products) return null;
    const productId = Date.now() >= PRICE_INCREASE_AT.getTime() ? products.from2027 : products.current;

    const cached = priceCache[productId];
    if (cached && Date.now() - cached.at < PRICE_CACHE_MS) return cached.price;

    const product = await stripe.products.retrieve(productId, { expand: ['default_price'] });
    const price = product.default_price;
    if (!price || !price.active || !price.recurring) {
        throw new Error(`Product ${productId} has no active recurring default price`);
    }

    priceCache[productId] = { price, at: Date.now() };
    return price;
}

// ─── EDO access codes ─────────────────────────────────────────────────────────
// A paid subscribe.html checkout creates the subscriber on the website (EDO/api.php), which issues the
// access code and emails the welcome message. Status changes (cancel, past due) are relayed the same way.
// Needs env EDO_API_SECRET (same value as 'subscriber_secret' in EDO/private/config.php on the website).
const EDO_API_URL = process.env.EDO_API_URL || 'https://www.fastlocations.ai/EDO/api.php';

async function edoCall(action, payload) {
    if (!process.env.EDO_API_SECRET) throw new Error('EDO_API_SECRET is not set');
    const r = await fetch(`${EDO_API_URL}?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: process.env.EDO_API_SECRET, ...payload }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(`EDO ${action} failed: HTTP ${r.status} ${data.error || ''}`);
    return data;
}

function planKey(planName) {
    return /ai/i.test(planName || '') ? 'aiplus' : /basic/i.test(planName || '') ? 'basic' : (planName || '').toLowerCase();
}

// Builds the subscriber_activate payload from a completed subscription checkout session.
function subscriberFromSession(session, extra) {
    const m = session.metadata || {};
    return {
        subscription_id: typeof session.subscription === 'string' ? session.subscription : (session.subscription && session.subscription.id),
        customer_id: typeof session.customer === 'string' ? session.customer : '',
        email: m.Email || (session.customer_details && session.customer_details.email) || session.customer_email || '',
        name: m.Subscriber_Name || (session.customer_details && session.customer_details.name) || '',
        organization: m.Organization || '',
        state: m.State_Province || '',
        country: m.Country || '',
        plan: planKey(m.Plan_Selected),
        ...extra,
    };
}

async function handleStripeEvent(event) {
    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            if (session.mode !== 'subscription' || !session.subscription) return;
            await edoCall('subscriber_activate', subscriberFromSession(session));
            return;
        }
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
            const sub = event.data.object;
            await edoCall('subscriber_status', { subscription_id: sub.id, status: event.type.endsWith('deleted') ? 'canceled' : sub.status });
            return;
        }
        default:
            return;
    }
}

// ─── V1 Webhook (Snapshot / charming-spark) ───────────────────────────────────
// Subscribe this endpoint to: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted.
app.post('/webhooks/v1', express.raw({ type: 'application/json' }), async (req, res) => {
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
    try {
        await handleStripeEvent(event);
    } catch (err) {
        // 500 makes Stripe retry; the website side is idempotent per subscription id.
        console.error('EDO sync failed for', event.type, event.id, '-', err.message);
        return res.status(500).json({ error: err.message });
    }
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