const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(cors());

const PRICE_IDS = {
    basic:  'price_1TRcyB7kCFBD2fZagxnSCRSr',
    small:  'price_1TRcy67kCFBD2fZalpRnsxfz',
    medium: 'price_1TRcy17kCFBD2fZaH2KaeMsY',
    large:  'price_1TRcxx7kCFBD2fZaRYII5PbD'
};

// ─── V1 Webhook (Snapshot / charming-spark) ───────────────────────────────────
app.post('/webhooks/v1', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET_V1
        );
    } catch (err) {
        console.error('V1 webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    console.log('V1 event received:', event.type);
    res.status(200).json({ received: true });
});

// ─── V2 Webhook (Thin / dynamic-wonder) ──────────────────────────────────────
app.post('/webhooks/v2', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.parseThinEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET_V2
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

// ─── Checkout Session ─────────────────────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
    try {
        const {
            plan, firstName, lastName, email, organization,
            departmentUrl, streetAddress, city, stateProvince,
            postalCode, country, edCategory, planName,
            consent_listings, consent_timestamp, consent_text
        } = req.body;

        const priceId = PRICE_IDS[plan];
        if (!priceId) return res.status(400).json({ error: 'Invalid plan selected' });

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
            line_items: [{ price: priceId, quantity: 1 }],
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
app.listen(PORT, () => {
    console.log(`✅ FastLocations Backend running on port ${PORT}`);
});