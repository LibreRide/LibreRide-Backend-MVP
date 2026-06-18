import type { Env } from '../types';
import { json } from '../lib/http';

export async function createCheckout(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    email?: string;
    driver_id?: string;
  };

  if (!body.email || !body.driver_id) {
    return json({ ok: false, error: 'Missing email or driver_id' }, 400, env);
  }

  const form = new URLSearchParams();
  form.append('mode', 'subscription');
  form.append('line_items[0][price]', env.STRIPE_PRICE_ID);
  form.append('line_items[0][quantity]', '1');
  form.append('customer_email', body.email);
  form.append('subscription_data[trial_period_days]', '30');
  form.append('success_url', 'https://admin.libreride.com?subscription=success');
  form.append('cancel_url', 'https://admin.libreride.com?subscription=cancelled');
  form.append('metadata[driver_id]', body.driver_id);

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const data = await response.json() as any;

  if (!response.ok) {
    return json({ ok: false, error: data.error?.message || 'Stripe checkout failed', data }, 500, env);
  }

  return json({ ok: true, url: data.url }, 200, env);
}