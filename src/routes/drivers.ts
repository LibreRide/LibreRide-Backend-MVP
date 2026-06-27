import type { Env } from '../types';
import { json, readJson } from '../lib/http';
import { requireRole } from '../lib/auth';
import { supabase } from '../lib/supabase';

export async function updateDriverLocation(request: Request, env: Env): Promise<Response> {
  const user = await requireRole(request, env, ['driver']);
  const body = await readJson<{ lat: number; lng: number; is_online?: boolean }>(request);
  const sb = supabase(env);
  const { data: driver } = await sb.from('drivers').select('id').eq('user_id', user.id).single();
  if (!driver) return json({ error: 'Driver profile not found' }, 404, env);

  const updates: Record<string, unknown> = {
    current_location: `POINT(${body.lng} ${body.lat})`,
    last_location_update: new Date().toISOString(),
  };
  if (typeof body.is_online === 'boolean') updates.is_online = body.is_online;

  const { data, error } = await sb.from('drivers').update(updates).eq('id', driver.id).select('*').single();
  if (error) return json({ error: error.message }, 500, env);
  return json({ driver: data }, 200, env);
}

export async function goOnline(request: Request, env: Env): Promise<Response> {
  const user = await requireRole(request, env, ['driver']);
  const sb = supabase(env);

  const { data: driver, error } = await sb
    .from('drivers')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (error || !driver) {
    return json({ error: 'Driver profile not found' }, 404, env);
  }

  if (driver.onboarding_status !== 'approved') {
    return json({ error: 'Driver is not approved' }, 403, env);
  }

  if (!['trial_active', 'active'].includes(driver.subscription_status)) {
    return json({ error: 'Driver subscription is not active' }, 403, env);
  }

  const { data, error: updateError } = await sb
    .from('drivers')
    .update({
      is_online: true,
      availability_status: 'online',
      last_location_update: new Date().toISOString()
    })
    .eq('id', driver.id)
    .select('*')
    .single();

  if (updateError) {
    return json({ error: updateError.message }, 500, env);
  }

  return json({ driver: data }, 200, env);
}

export async function goOffline(request: Request, env: Env): Promise<Response> {
  const user = await requireRole(request, env, ['driver']);
  const sb = supabase(env);

  const { data, error } = await sb
    .from('drivers')
    .update({
      is_online: false,
      availability_status: 'offline',
      last_location_update: new Date().toISOString()
    })
    .eq('user_id', user.id)
    .select('*')
    .single();

  if (error) {
    return json({ error: error.message }, 500, env);
  }

  return json({ driver: data }, 200, env);
}
type DriverIdentityBody = {
  ssn?: string;
};

function normalizeSsn(value: string): string {
  return value.replace(/\D/g, '');
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));

  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function getAuthUserFromRequest(request: Request, env: Env) {
  const authorization = request.headers.get('authorization');

  if (!authorization?.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }

  const token = authorization.slice('Bearer '.length);
  const sb = supabase(env);

  const { data, error } = await sb.auth.getUser(token);

  if (error || !data.user) {
    throw new Error('Unauthorized');
  }

  return data.user;
}

export async function verifyDriverIdentity(request: Request, env: Env): Promise<Response> {
  const authUser = await getAuthUserFromRequest(request, env);
  const body = await readJson<DriverIdentityBody>(request);
  const cleanSsn = normalizeSsn(body.ssn || '');

  if (cleanSsn.length !== 9) {
    return json({ error: 'A valid 9-digit Social Security number is required.' }, 400, env);
  }

  if (!env.SSN_HASH_SECRET) {
    return json({ error: 'Identity verification is not configured.' }, 500, env);
  }

  const ssnHash = await hmacSha256Hex(env.SSN_HASH_SECRET, cleanSsn);
  const ssnLast4 = cleanSsn.slice(-4);
  const now = new Date().toISOString();
  const sb = supabase(env);

  const { data: driver, error: driverError } = await sb
    .from('drivers')
    .upsert(
      {
        user_id: authUser.id,
        email: authUser.email,
      },
      { onConflict: 'user_id' }
    )
    .select('*')
    .single();

  if (driverError || !driver) {
    return json({ error: driverError?.message || 'Driver profile not found.' }, 500, env);
  }

  const { data: existingIdentity, error: identityReadError } = await sb
    .from('driver_identity_registry')
    .select('*')
    .eq('ssn_hash', ssnHash)
    .maybeSingle();

  if (identityReadError) {
    return json({ error: identityReadError.message }, 500, env);
  }

  if (existingIdentity) {
    const sameDriver =
      existingIdentity.driver_id === driver.id || existingIdentity.user_id === authUser.id;

    if (
      existingIdentity.status === 'deactivated_permanent' ||
      existingIdentity.status === 'blocked'
    ) {
      await sb
        .from('drivers')
        .update({
          identity_verification_status: 'deactivated_permanent',
          identity_registry_id: existingIdentity.id,
          ssn_last4: ssnLast4,
          duplicate_flag: true,
          duplicate_reason:
            'This identity was previously deactivated and cannot create another LibreRide driver account.',
          duplicate_detected_at: now,
          deactivation_status: 'deactivated_permanent',
          deactivated_at: now,
          is_online: false,
          availability_status: 'offline',
        })
        .eq('id', driver.id);

      return json(
        {
          blocked: true,
          identityStatus: 'deactivated_permanent',
          error:
            'This identity was previously deactivated and cannot create another LibreRide driver account.',
        },
        403,
        env
      );
    }

    if (!sameDriver) {
      await sb
        .from('drivers')
        .update({
          identity_verification_status: 'duplicate_review',
          identity_registry_id: existingIdentity.id,
          ssn_last4: ssnLast4,
          duplicate_flag: true,
          duplicate_reason:
            'This identity is already connected to another LibreRide driver account.',
          duplicate_detected_at: now,
          is_online: false,
          availability_status: 'offline',
        })
        .eq('id', driver.id);

      return json(
        {
          blocked: true,
          identityStatus: 'duplicate_review',
          error:
            'This identity is already connected to another LibreRide driver account. Your application has been flagged for review.',
        },
        409,
        env
      );
    }

    const { data: updatedDriver, error: updateError } = await sb
      .from('drivers')
      .update({
        identity_verification_status: 'cleared',
        identity_registry_id: existingIdentity.id,
        ssn_last4: ssnLast4,
        duplicate_flag: false,
        duplicate_reason: null,
        duplicate_detected_at: null,
      })
      .eq('id', driver.id)
      .select('*')
      .single();

    if (updateError) {
      return json({ error: updateError.message }, 500, env);
    }

    return json(
      {
        ok: true,
        identityStatus: 'cleared',
        ssnLast4,
        driver: updatedDriver,
      },
      200,
      env
    );
  }

  const { data: newIdentity, error: insertError } = await sb
    .from('driver_identity_registry')
    .insert({
      driver_id: driver.id,
      user_id: authUser.id,
      ssn_hash: ssnHash,
      ssn_last4: ssnLast4,
      status: 'cleared',
    })
    .select('*')
    .single();

  if (insertError) {
    return json({ error: insertError.message }, 500, env);
  }

  const { data: updatedDriver, error: updateError } = await sb
    .from('drivers')
    .update({
      identity_verification_status: 'cleared',
      identity_registry_id: newIdentity.id,
      ssn_last4: ssnLast4,
      duplicate_flag: false,
      duplicate_reason: null,
      duplicate_detected_at: null,
    })
    .eq('id', driver.id)
    .select('*')
    .single();

  if (updateError) {
    return json({ error: updateError.message }, 500, env);
  }

  return json(
    {
      ok: true,
      identityStatus: 'cleared',
      ssnLast4,
      driver: updatedDriver,
    },
    200,
    env
  );
}
export async function registerDriver(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as any;

  const {
    first_name,
    last_name,
    email,
    phone_number,
    vehicle_make,
    vehicle_model,
    vehicle_year,
    vehicle_color,
    license_plate
  } = body;

  if (!first_name || !last_name || !phone_number) {
    return json({ ok: false, error: 'Missing required driver fields' }, 400, env);
  }

  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };

  const userRes = await fetch(`${env.SUPABASE_URL}/rest/v1/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      role: 'driver',
      first_name,
      last_name,
      email,
      phone_number
    })
  });

  const userData = await userRes.json() as any[];

  if (!userRes.ok) {
    return json({ ok: false, step: 'create_user', error: userData }, 400, env);
  }

  const user = userData[0];

  const driverRes = await fetch(`${env.SUPABASE_URL}/rest/v1/drivers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      user_id: user.id,
      onboarding_status: 'in_progress',
      subscription_status: 'trial_pending'
    })
  });

  const driverData = await driverRes.json() as any[];

  if (!driverRes.ok) {
    return json({ ok: false, step: 'create_driver', error: driverData }, 400, env);
  }

  const driver = driverData[0];

  await fetch(`${env.SUPABASE_URL}/rest/v1/driver_subscriptions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      driver_id: driver.id,
      plan_name: 'Founding Driver',
      weekly_price_cents: 2000,
      status: 'trial_pending'
    })
  });

  if (vehicle_make && vehicle_model && vehicle_year && vehicle_color && license_plate) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/vehicles`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        driver_id: driver.id,
        make: vehicle_make,
        model: vehicle_model,
        year: vehicle_year,
        color: vehicle_color,
        license_plate
      })
    });
  }

  return json({
    ok: true,
    message: 'Driver registered successfully',
    user_id: user.id,
    driver_id: driver.id
  }, 201, env);
}