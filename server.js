const express = require('express');
const cors = require('cors');
// TODO: Replace 'sk_test_...' with your actual Stripe Secret Key from the Stripe Developers Dashboard
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Middleware to parse JSON bodies and handle CORS (Cross-Origin Resource Sharing)
app.use(express.json());
app.use(cors());

// TODO: Replace these placeholders with the actual "Price IDs" from your Stripe Dashboard
const PRICE_IDS = {
    basic: 'price_1TMtgQGEPKXHk2DWkwlX0EP4',
    small: 'price_1TNBchGEPKXHk2DWh73U5xHw',
    medium: 'price_1TNG5jGEPKXHk2DWT64Y7Fgp',
    large: 'price_1TNG3JGEPKXHk2DWwOhF2G58'
};
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { plan, firstName, lastName, email, organization, departmentUrl, edCategory } = req.body;

        const priceId = PRICE_IDS[plan];
        if (!priceId) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

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
            metadata: {
                Subscriber_Name: `${firstName} ${lastName}`,
                Email: email,
                Organization: organization,
                Department_URL: departmentUrl || 'N/A',
                ED_Category: edCategory,
                Plan_Selected: plan.toUpperCase()
            },
            
            // This ensures all the exact same data also attaches to the Subscription record 
            // so you see everything on the screen in your screenshot!
            subscription_data: {
                metadata: {
                    Subscriber_Name: `${firstName} ${lastName}`,
                    Email: email,
                    Organization: organization,
                    Department_URL: departmentUrl || 'N/A',
                    ED_Category: edCategory,
                    Plan_Selected: plan.toUpperCase()
                }
            },
            
            // TODO: Replace these URLs with the actual live URLs of your website once you launch
            success_url: 'https://www.fastlocations.ai/success.html', 
            cancel_url: 'https://www.fastlocations.ai/subscribe.html', 
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
    console.log(`Make sure you have updated your Stripe Secret Key and Price IDs in this file!`);
});