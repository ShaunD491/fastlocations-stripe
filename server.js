const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Middleware to parse JSON bodies and handle CORS (Cross-Origin Resource Sharing)
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
        const { plan, firstName, lastName, email, organization, departmentUrl, streetAddress, city, stateProvince, postalCode, country, edCategory } = req.body;

        const priceId = PRICE_IDS[plan];
        if (!priceId) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        // Consolidate metadata so we easily pass ALL fields to both Stripe objects
        const subscriberMeta = {
            Subscriber_Name: `${firstName} ${lastName}`,
            Email: email,
            Organization: organization,
            Department_URL: departmentUrl || 'N/A',
            Street_Address: streetAddress || 'N/A',
            City: city || 'N/A',
            State_Province: stateProvince || 'N/A',
            Postal_Code: postalCode || 'N/A',
            Country: country || 'N/A',
            ED_Category: edCategory,
            Plan_Selected: plan.toUpperCase()
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
            
            // This attaches all data to the overall Payment Intent
            metadata: subscriberMeta,
            
            // This ensures all the exact same data also attaches to the Subscription record 
            subscription_data: {
                metadata: subscriberMeta
            },
            
            // TODO: Replace these URLs with the actual live URLs of your website once you launch
            success_url: 'https://www.fastlocations.ai/success.html', 
            cancel_url: 'https://www.fastlocations.ai/subscribe.html', 
        });


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ FastLocations Backend running on port ${PORT}`);
});
