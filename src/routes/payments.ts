import Stripe from 'stripe';
import type { Env } from '../types';
import { json } from '../lib/http';

export async function createRideCheckout(
  request: Request,
  env: Env
): Promise<Response> {
  const body = await request.json() as {
    rideId?: string;
    amountCents?: number;
  };

  if (!body.rideId || !body.amountCents) {
    return json({ error: 'rideId and amountCents are required' }, 400, env);
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  });

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'LibreRide Trip Payment',
          },
          unit_amount: body.amountCents,
        },
        quantity: 1,
      },
    ],
    metadata: {
      ride_id: body.rideId,
      type: 'ride_payment',
    },
    success_url: `https://app.libreride.com/payment-success?ride_id=${body.rideId}`,
    cancel_url: `https://app.libreride.com/payment-cancelled?ride_id=${body.rideId}`,
  });

  return json({ url: session.url }, 200, env);
}

export async function createPrepaidRideCheckout(
  request: Request,
  env: Env
): Promise<Response> {
  const body = await request.json() as {
    riderId?: string;
    riderEmail?: string;
    pickupAddress?: string;
    destinationAddress?: string;
    pickupLat?: number;
    pickupLng?: number;
    destinationLat?: number;
    destinationLng?: number;
    amountCents?: number;
  };

  if (
    !body.riderId ||
    !body.pickupAddress ||
    !body.destinationAddress ||
    !body.amountCents
  ) {
    return json(
      { error: 'riderId, pickupAddress, destinationAddress, and amountCents are required' },
      400,
      env
    );
  }

  const pickupLat = Number.isFinite(body.pickupLat) ? body.pickupLat : 25.7959;
  const pickupLng = Number.isFinite(body.pickupLng) ? body.pickupLng : -80.2906;
  const destinationLat = Number.isFinite(body.destinationLat) ? body.destinationLat : 25.7617;
  const destinationLng = Number.isFinite(body.destinationLng) ? body.destinationLng : -80.1918;

  const rideResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rides`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      rider_id: body.riderId,
      status: 'payment_pending',
      pickup_address: body.pickupAddress,
      destination_address: body.destinationAddress,
      pickup_location: `POINT(${pickupLng} ${pickupLat})`,
      destination_location: `POINT(${destinationLng} ${destinationLat})`,
      pickup_lat: pickupLat,
      pickup_lng: pickupLng,
      destination_lat: destinationLat,
      destination_lng: destinationLng,
      estimated_fare_cents: body.amountCents,
      payment_status: 'pending',
      dispatched_driver_ids: [],
      dispatch_radius_miles: 10,
    }),
  });

  const rideData = await rideResponse.json() as any[];

  if (!rideResponse.ok || !Array.isArray(rideData) || !rideData[0]) {
    return json(
      { error: 'Could not create pending ride', details: rideData },
      500,
      env
    );
  }

  const ride = rideData[0];

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  });

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: body.riderEmail,
    payment_method_types: ['card'],
    payment_intent_data: {
      setup_future_usage: 'off_session',
    },
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'LibreRide Ride Payment',
            description: `${body.pickupAddress} to ${body.destinationAddress}`,
          },
          unit_amount: body.amountCents,
        },
        quantity: 1,
      },
    ],
    metadata: {
      ride_id: ride.id,
      rider_id: body.riderId,
      type: 'prepaid_ride',
    },
    success_url: `https://app.libreride.com/payment-success?ride_id=${ride.id}`,
    cancel_url: `https://app.libreride.com/payment-cancelled?ride_id=${ride.id}`,
  });

  await fetch(`${env.SUPABASE_URL}/rest/v1/rides?id=eq.${ride.id}`, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      stripe_checkout_session_id: session.id,
    }),
  });

  return json({ url: session.url, rideId: ride.id }, 200, env);
}