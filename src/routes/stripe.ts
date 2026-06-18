import Stripe from 'stripe';
import type { Env } from '../types';
import { json } from '../lib/http';
import { supabase } from '../lib/supabase';

export async function stripeWebhook(request: Request, env: Env): Promise<Response> {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return json({ error: 'Missing Stripe signature' }, 400, env);
  }

  const body = await request.text();

  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return json(
      { error: `Webhook verification failed: ${(err as Error).message}` },
      400,
      env
    );
  }

  const sb = supabase(env);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const rideId = session.metadata?.ride_id;

    if (rideId) {
      await sb
        .from('rides')
        .update({
          status: 'requested',
          payment_status: 'paid',
          paid_at: new Date().toISOString(),
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id:
            typeof session.payment_intent === 'string'
              ? session.payment_intent
              : null,
        })
        .eq('id', rideId);
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const rideId = paymentIntent.metadata?.ride_id;

    if (rideId) {
      await sb
        .from('rides')
        .update({
          payment_status: 'failed',
          cancellation_reason: 'Payment failed',
        })
        .eq('id', rideId);
    }
  }

  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object as Stripe.Invoice;

    await sb
      .from('driver_subscriptions')
      .update({ status: 'active' })
      .eq('stripe_customer_id', invoice.customer as string);
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object as Stripe.Invoice;

    await sb
      .from('driver_subscriptions')
      .update({ status: 'grace_period' })
      .eq('stripe_customer_id', invoice.customer as string);
  }

  return json({ received: true, type: event.type }, 200, env);
}