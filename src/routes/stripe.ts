import Stripe from 'stripe';
import type { Env } from '../types';
import { json } from '../lib/http';
import { supabase } from '../lib/supabase';

type DispatchRide = {
  id: string;
  pickup_lat: number | string | null;
  pickup_lng: number | string | null;
  dispatch_radius_miles: number | string | null;
};

type DispatchDriver = {
  id: string;
  current_lat: number | string | null;
  current_lng: number | string | null;
  total_trips: number | string | null;
  last_location_update: string | null;
};

type ActiveRide = {
  driver_id: string | null;
};

function toFiniteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radiusMiles = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radiusMiles * c;
}

async function dispatchNearestDriversToRide(env: Env, rideId: string): Promise<string[]> {
  const sb = supabase(env);

  const { data: ride, error: rideError } = await sb
    .from('rides')
    .select('id,pickup_lat,pickup_lng,dispatch_radius_miles')
    .eq('id', rideId)
    .single<DispatchRide>();

  if (rideError || !ride) {
    console.log('dispatchNearestDriversToRide: ride not found', rideError?.message);
    return [];
  }

  const pickupLat = toFiniteNumber(ride.pickup_lat);
  const pickupLng = toFiniteNumber(ride.pickup_lng);
  const dispatchRadiusMiles = toFiniteNumber(ride.dispatch_radius_miles) || 10;

  if (pickupLat === null || pickupLng === null) {
    console.log('dispatchNearestDriversToRide: missing pickup coordinates', rideId);

    await sb
      .from('rides')
      .update({
        dispatched_driver_ids: [],
        dispatch_radius_miles: dispatchRadiusMiles,
      })
      .eq('id', rideId);

    return [];
  }

  const { data: activeRides } = await sb
    .from('rides')
    .select('driver_id')
    .in('status', ['accepted', 'arrived', 'in_progress'])
    .not('driver_id', 'is', null)
    .returns<ActiveRide[]>();

  const busyDriverIds = new Set(
    (activeRides || [])
      .map((activeRide) => activeRide.driver_id)
      .filter(Boolean)
  );

  const { data: drivers, error: driversError } = await sb
    .from('drivers')
    .select('id,current_lat,current_lng,total_trips,last_location_update')
    .eq('is_online', true)
    .eq('availability_status', 'online')
    .eq('onboarding_status', 'approved')
    .returns<DispatchDriver[]>();

  if (driversError) {
    console.log('dispatchNearestDriversToRide: driver query failed', driversError.message);
    return [];
  }

  const nearbyDrivers = (drivers || [])
    .filter((driver) => !busyDriverIds.has(driver.id))
    .map((driver) => {
      const driverLat = toFiniteNumber(driver.current_lat);
      const driverLng = toFiniteNumber(driver.current_lng);

      if (driverLat === null || driverLng === null) {
        return null;
      }

      return {
        id: driver.id,
        distance_miles: distanceMiles(pickupLat, pickupLng, driverLat, driverLng),
        total_trips: Number(driver.total_trips || 0),
        last_location_update: driver.last_location_update,
      };
    })
    .filter((driver): driver is {
      id: string;
      distance_miles: number;
      total_trips: number;
      last_location_update: string | null;
    } => Boolean(driver))
    .filter((driver) => driver.distance_miles <= dispatchRadiusMiles)
    .sort((a, b) => {
      if (a.distance_miles !== b.distance_miles) {
        return a.distance_miles - b.distance_miles;
      }

      return b.total_trips - a.total_trips;
    });

  const dispatchedDriverIds = nearbyDrivers.slice(0, 5).map((driver) => driver.id);

  const { error: updateError } = await sb
    .from('rides')
    .update({
      dispatched_driver_ids: dispatchedDriverIds,
      dispatch_radius_miles: dispatchRadiusMiles,
    })
    .eq('id', rideId);

  if (updateError) {
    console.log('dispatchNearestDriversToRide: ride update failed', updateError.message);
    return [];
  }

  return dispatchedDriverIds;
}

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

      await dispatchNearestDriversToRide(env, rideId);
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