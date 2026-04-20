const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

app.use(express.json());
app.use(cors());

const PRICE_IDS = {
    basic: 'price_1TOKRCGEPKXHk2DWSwHFvTRN',
    small: 'price_1TOKahGEPKXHk2DWiU0jYNYA',
    medium: 'price_1TOKcDGEPKXHk2DWNmEyXZNN',
    large: 'price_1TOKeUGEPKXHk2DWXYQeKzNP'
};

app.post('/create-checkout-session', async (req, res) => {
    try {
        const {
            plan,
            firstName,
            lastName,
            email,
            organization,
            departmentUrl,
            streetAddress,
            city,
            stateProvince,
            postalCode,
            country,
            edCategory,
            planName
        } = req.body;

        const priceId = PRICE_IDS[plan];
        if (!priceId) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        // Map all collected data cleanly for Stripe
        const subscriberMeta = {
            Subscriber_Name:  `${firstName} ${lastName}`,
            Email:            email,
            Organization:     organization,
            Department_URL:   departmentUrl  || 'N/A',
            Street_Address:   streetAddress  || 'N/A',
            City:             city           || 'N/A',
            State_Province:   stateProvince  || 'N/A',
            Postal_Code:      postalCode     || 'N/A',
            Country:          country        || 'N/A',
            ED_Category:      edCategory,
            Plan_Selected:    planName || plan.toUpperCase()
        };

        // Create the Stripe Checkout Session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            customer_email: email,

            metadata: subscriberMeta,

            subscription_data: {
                metadata: subscriberMeta
            },

            success_url: 'https://www.fastlocations.ai/success.html',
            cancel_url:  'https://www.fastlocations.ai/subscribe.html',
        });

        // Send the generated Stripe URL back to the frontend
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
