import Stripe from 'stripe';
import type { Env } from '../types';
import { json } from '../lib/http';

type RideType = 'regular' | 'xl' | 'premium' | 'premium_xl';

type FareBreakdown = {
  rideType?: RideType;
  rideTypeLabel?: string;
  requestedCapacity?: number;
  baseFareCents?: number;
  perMileCents?: number;
  perMinuteCents?: number;
  mileageFareCents?: number;
  timeFareCents?: number;
  subtotalFareCents?: number;
  minimumFareCents?: number;
  demandMultiplier?: number;
  demandAdjustmentCents?: number;
  totalFareCents?: number;
};

function toFiniteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function isValidLatitude(value: number | null): value is number {
  return value !== null && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null): value is number {
  return value !== null && value >= -180 && value <= 180;
}

function isZeroCoordinate(lat: number, lng: number): boolean {
  return Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001;
}

function normalizeRideType(value: unknown): RideType {
  if (typeof value !== 'string') return 'regular';

  const normalized = value
    .trim()
    .toLowerCase()
    .replace('-', '_')
    .replace(' ', '_');

  if (normalized === 'xl') return 'xl';
  if (normalized === 'premium') return 'premium';
  if (normalized === 'premium_xl') return 'premium_xl';

  return 'regular';
}

function getRequestedCapacity(rideType: RideType, value: unknown): number {
  const requestedCapacity = toFiniteNumber(value);

  if (requestedCapacity && requestedCapacity >= 1 && requestedCapacity <= 8) {
    return Math.round(requestedCapacity);
  }

  if (rideType === 'xl' || rideType === 'premium_xl') {
    return 6;
  }

  return 4;
}

function getAppSuccessUrl(rideId: string): string {
  return `https://app.libreride.com/?payment=success&ride_id=${rideId}`;
}

function getAppCancelUrl(rideId: string): string {
  return `https://app.libreride.com/?payment=cancelled&ride_id=${rideId}`;
}

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
    apiVersion: '2025-02-24.acacia',
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
    success_url: getAppSuccessUrl(body.rideId),
    cancel_url: getAppCancelUrl(body.rideId),
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
    rideType?: string;
    rideTypeLabel?: string;
    requestedCapacity?: number;
    estimatedDistanceMiles?: number;
    estimatedDurationMinutes?: number;
    fareBreakdown?: FareBreakdown;
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

  const amountCents = Math.round(Number(body.amountCents));

  if (!Number.isFinite(amountCents) || amountCents < 100) {
    return json(
      { error: 'A valid ride fare is required before payment.' },
      400,
      env
    );
  }

  const pickupLat = toFiniteNumber(body.pickupLat);
  const pickupLng = toFiniteNumber(body.pickupLng);

  if (!isValidLatitude(pickupLat) || !isValidLongitude(pickupLng)) {
    return json(
      { error: 'Valid pickup GPS location is required before payment.' },
      400,
      env
    );
  }

  if (isZeroCoordinate(pickupLat, pickupLng)) {
    return json(
      { error: 'Pickup GPS location is invalid. Please refresh your GPS and try again.' },
      400,
      env
    );
  }

  const destinationLat = toFiniteNumber(body.destinationLat) ?? 25.7617;
  const destinationLng = toFiniteNumber(body.destinationLng) ?? -80.1918;

  const rideType = normalizeRideType(body.rideType);
  const requestedCapacity = getRequestedCapacity(rideType, body.requestedCapacity);
  const estimatedDistanceMiles = toFiniteNumber(body.estimatedDistanceMiles);
  const estimatedDurationMinutes = toFiniteNumber(body.estimatedDurationMinutes);

  const fareBreakdown = {
    ...(body.fareBreakdown || {}),
    rideType,
    rideTypeLabel:
      body.rideTypeLabel ||
      body.fareBreakdown?.rideTypeLabel ||
      (rideType === 'premium_xl'
        ? 'Premium XL'
        : rideType === 'premium'
          ? 'Premium'
          : rideType === 'xl'
            ? 'XL'
            : 'Regular'),
    requestedCapacity,
    totalFareCents: amountCents,
  };

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
      estimated_distance_miles: estimatedDistanceMiles,
      estimated_duration_minutes: estimatedDurationMinutes,
      estimated_fare_cents: amountCents,
      payment_status: 'pending',
      dispatched_driver_ids: [],
      dispatch_radius_miles: 10,
      ride_type: rideType,
      requested_capacity: requestedCapacity,
      fare_breakdown: fareBreakdown,
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
    apiVersion: '2025-02-24.acacia',
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
            name: `LibreRide ${fareBreakdown.rideTypeLabel} Ride Payment`,
            description: `${body.pickupAddress} to ${body.destinationAddress}`,
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    metadata: {
      ride_id: ride.id,
      rider_id: body.riderId,
      type: 'prepaid_ride',
      ride_type: rideType,
      requested_capacity: String(requestedCapacity),
      estimated_distance_miles: estimatedDistanceMiles !== null ? String(estimatedDistanceMiles) : '',
      estimated_duration_minutes: estimatedDurationMinutes !== null ? String(estimatedDurationMinutes) : '',
      amount_cents: String(amountCents),
    },
    success_url: getAppSuccessUrl(ride.id),
    cancel_url: getAppCancelUrl(ride.id),
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