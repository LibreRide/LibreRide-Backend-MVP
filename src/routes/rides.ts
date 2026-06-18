import type { Env } from '../types';
import { json, readJson } from '../lib/http';
import { requireRole } from '../lib/auth';
import { supabase } from '../lib/supabase';

type CreateRideBody = {
  pickup_address: string;
  destination_address: string;
  pickup_lat: number;
  pickup_lng: number;
  destination_lat: number;
  destination_lng: number;
  estimated_distance_miles?: number;
  estimated_duration_minutes?: number;
};

export async function createRide(request: Request, env: Env): Promise<Response> {
  const user = await requireRole(request, env, ['rider']);
  const body = await readJson<CreateRideBody>(request);
  const sb = supabase(env);

  const distance = body.estimated_distance_miles || 1;
  const duration = body.estimated_duration_minutes || 10;
  const { data: fareData, error: fareError } = await sb.rpc('calculate_fare_cents', {
    distance_miles: distance,
    duration_minutes: duration,
  });
  if (fareError) return json({ error: fareError.message }, 500, env);

  const { data: ride, error } = await sb.from('rides').insert({
    rider_id: user.id,
    pickup_address: body.pickup_address,
    destination_address: body.destination_address,
    pickup_location: `POINT(${body.pickup_lng} ${body.pickup_lat})`,
    destination_location: `POINT(${body.destination_lng} ${body.destination_lat})`,
    estimated_distance_miles: distance,
    estimated_duration_minutes: duration,
    estimated_fare_cents: fareData,
    status: 'requested',
  }).select('*').single();

  if (error) return json({ error: error.message }, 500, env);

  const id = env.RIDE_SESSIONS.idFromName(ride.id);
  const stub = env.RIDE_SESSIONS.get(id);
  await stub.fetch('https://ride-session/state', {
    method: 'POST',
    body: JSON.stringify({ rideId: ride.id, riderId: user.id, status: 'requested' }),
  });

  return json({ ride }, 201, env);
}

export async function matchRide(request: Request, env: Env, rideId: string): Promise<Response> {
  await requireRole(request, env, ['admin']);
  const sb = supabase(env);
  const { data: ride, error } = await sb.from('rides').select('*').eq('id', rideId).single();
  if (error || !ride) return json({ error: 'Ride not found' }, 404, env);

  const pickup = ride.pickup_location;
  // In production, call a Postgres RPC that returns nearby drivers. This starter exposes the intended flow.
  const { data: drivers, error: driverError } = await sb.rpc('find_nearby_drivers_for_ride', { ride_uuid: rideId });
  if (driverError) return json({ error: driverError.message }, 500, env);
  const driver = drivers?.[0];
  if (!driver) {
    await sb.from('rides').update({ status: 'no_driver_available' }).eq('id', rideId);
    return json({ status: 'no_driver_available' }, 200, env);
  }

  await sb.from('rides').update({ driver_id: driver.id, status: 'matched', matched_at: new Date().toISOString() }).eq('id', rideId);
  const id = env.RIDE_SESSIONS.idFromName(rideId);
  await env.RIDE_SESSIONS.get(id).fetch('https://ride-session/state', {
    method: 'POST',
    body: JSON.stringify({ rideId, driverId: driver.id, status: 'matched' }),
  });
  return json({ status: 'matched', driver }, 200, env);
}

export async function updateRideStatus(request: Request, env: Env, rideId: string): Promise<Response> {
  const user = await requireRole(request, env, ['driver', 'admin']);
  const body = await readJson<{ status: string }>(request);
  const allowed = ['driver_en_route', 'driver_arrived', 'in_progress', 'completed', 'canceled'];
  if (!allowed.includes(body.status)) return json({ error: 'Invalid status' }, 400, env);

  const sb = supabase(env);
  const patch: Record<string, string> = { status: body.status };
  if (body.status === 'driver_arrived') patch.driver_arrived_at = new Date().toISOString();
  if (body.status === 'in_progress') patch.trip_started_at = new Date().toISOString();
  if (body.status === 'completed') patch.completed_at = new Date().toISOString();
  if (body.status === 'canceled') patch.canceled_at = new Date().toISOString();

  const { data, error } = await sb.from('rides').update(patch).eq('id', rideId).select('*').single();
  if (error) return json({ error: error.message }, 500, env);

  await sb.from('ride_events').insert({ ride_id: rideId, event_type: body.status, event_data: { by: user.id } });
  await env.RIDE_SESSIONS.get(env.RIDE_SESSIONS.idFromName(rideId)).fetch('https://ride-session/state', {
    method: 'POST',
    body: JSON.stringify({ rideId, status: body.status }),
  });
  return json({ ride: data }, 200, env);
}

export async function rideSocket(request: Request, env: Env, rideId: string): Promise<Response> {
  const id = env.RIDE_SESSIONS.idFromName(rideId);
  return env.RIDE_SESSIONS.get(id).fetch(request);
}
