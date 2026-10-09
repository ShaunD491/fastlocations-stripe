// One-time import of EXISTING Stripe subscribers into the website's subscriber list (EDO/api.php),
// so incentive/park access follows their subscription from now on. It never emails anyone:
// every call is sent with notify:false (no welcome email, no admin alert).
//
//   railway run -s fastlocations-stripe -- node backfill-subscribers.js                dry run: only prints what would be sent
//   railway run -s fastlocations-stripe -- node backfill-subscribers.js --apply        really sends it
//   ... --include-canceled   also record cancelled subscriptions (they will show as lapsed)
//
// Needs STRIPE_SECRET_KEY and EDO_API_SECRET (Railway supplies both). Safe to run again: the website
// ignores a subscription id it already has. The website's api.php must be uploaded first.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, process.env.STRIPE_TEST_HOST ? {
    host: process.env.STRIPE_TEST_HOST, port: Number(process.env.STRIPE_TEST_PORT), protocol: 'http',   // testing against a local stand-in only
} : undefined);

const APPLY = process.argv.includes('--apply');
const INCLUDE_CANCELED = process.argv.includes('--include-canceled');
const EDO_API_URL = process.env.EDO_API_URL || 'https://www.fastlocations.ai/EDO/api.php';

// Stripe products -> plan keys used on the website (see PLAN_PRODUCTS in server.js). The old $795 Basic product is still in use.
const PRODUCT_PLAN = {
    prod_VMZTrsXXIQXUK6: 'basic', prod_VMZd29AefF9f6S: 'basic', prod_UQTwlgBJzYfUuG: 'basic',
    prod_UQTvmLzMFKcVDl: 'aiplus', prod_VMZePDnI2wx6Da: 'aiplus',
};

async function edoCall(action, payload) {
    const r = await fetch(`${EDO_API_URL}?action=${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: process.env.EDO_API_SECRET, ...payload }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(`${action}: HTTP ${r.status} ${data.error || '(not JSON: is the new api.php uploaded?)'}`);
    return data;
}

const maskEmail = e => (e || '').replace(/^(.).*(@.*)$/, '$1***$2');

function buildPayload(sub) {
    const m = sub.metadata || {};
    const cust = typeof sub.customer === 'object' && sub.customer ? sub.customer : {};
    const item = sub.items && sub.items.data && sub.items.data[0];
    const product = item && item.price && (typeof item.price.product === 'string' ? item.price.product : item.price.product && item.price.product.id);
    return {
        subscription_id: sub.id,
        customer_id: cust.id || (typeof sub.customer === 'string' ? sub.customer : ''),
        email: m.Email || cust.email || '',
        name: m.Subscriber_Name || cust.name || '',
        organization: m.Organization || (cust.name && !m.Subscriber_Name ? cust.name : '') || '',
        state: m.State_Province || (cust.address && cust.address.state) || '',
        country: m.Country || (cust.address && cust.address.country) || '',
        plan: PRODUCT_PLAN[product] || (/ai/i.test(m.Plan_Selected || '') ? 'aiplus' : /basic/i.test(m.Plan_Selected || '') ? 'basic' : ''),
        notify: false,
    };
}

(async () => {
    if (APPLY && !process.env.EDO_API_SECRET) throw new Error('EDO_API_SECRET is not set (run through "railway run -s fastlocations-stripe -- ...")');
    const wanted = new Set(['active', 'trialing', 'past_due', ...(INCLUDE_CANCELED ? ['canceled', 'unpaid', 'incomplete_expired'] : [])]);
    const rows = [];
    for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.customer'] })) {
        if (wanted.has(sub.status)) rows.push(sub);
    }
    console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${rows.length} subscription(s) to import (${[...wanted].join(', ')}). No email is sent either way.\n`);

    const tally = { sent: 0, existing: 0, exact: 0, review: 0, failed: 0 }, review = [];
    for (const sub of rows) {
        const p = buildPayload(sub);
        const gaps = ['email', 'organization', 'state'].filter(k => !p[k]);
        console.log(`${sub.id}  ${sub.status.padEnd(9)} ${String(p.plan || '?').padEnd(6)} ${p.organization || '(no organization)'} | ${p.state || '(no state)'} | ${maskEmail(p.email) || '(no email)'}${gaps.length ? '  <-- missing: ' + gaps.join(', ') : ''}`);
        if (!APPLY) continue;
        try {
            const r = await edoCall('subscriber_activate', p);
            if (r.existing) tally.existing++; else { tally.sent++; if (r.matched === 'exact') tally.exact++; else { tally.review++; review.push(p.organization || sub.id); } }
            if (!r.existing) {
                const status = sub.status === 'past_due' ? 'past_due' : (wanted.has(sub.status) && !['active', 'trialing'].includes(sub.status) ? 'canceled' : null);
                if (status) await edoCall('subscriber_status', { subscription_id: sub.id, status });
            }
        } catch (e) { tally.failed++; console.log('   FAILED:', e.message); }
        await new Promise(r => setTimeout(r, 150));
    }
    if (APPLY) {
        console.log(`\nDone. Imported ${tally.sent} (${tally.exact} matched to a directory organization, ${tally.review} need review), ${tally.existing} already there, ${tally.failed} failed.`);
        if (review.length) console.log('Attach these in EDO/admin.html > Subscribers (Attach... / State...):\n  - ' + review.join('\n  - '));
    } else {
        console.log('\nNothing was sent. Re-run with --apply to import.');
    }
})().catch(e => { console.error('Import stopped:', e.message); process.exit(1); });
