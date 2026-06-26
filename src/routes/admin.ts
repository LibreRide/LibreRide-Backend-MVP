import type { Env } from '../types';
import { json, readJson } from '../lib/http';
import { supabase } from '../lib/supabase';

type AdminUser = {
  id: string;
  auth_user_id: string;
  email: string;
  role: string;
  is_active: boolean;
};

type ServiceLevel = 'regular' | 'xl' | 'premium' | 'premium_xl';

const ALLOWED_SERVICE_LEVELS: ServiceLevel[] = [
  'regular',
  'xl',
  'premium',
  'premium_xl',
];

async function requireAdmin(request: Request, env: Env): Promise<AdminUser> {
  const authorization = request.headers.get('authorization');

  if (!authorization?.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }

  const token = authorization.slice('Bearer '.length);
  const sb = supabase(env);

  const { data: authData, error: authError } = await sb.auth.getUser(token);

  if (authError || !authData.user) {
    throw new Error('Unauthorized');
  }

  const { data: adminUser, error: adminError } = await sb
    .from('admin_users')
    .select('*')
    .eq('auth_user_id', authData.user.id)
    .eq('is_active', true)
    .maybeSingle<AdminUser>();

  if (adminError || !adminUser) {
    throw new Error('Forbidden');
  }

  return adminUser;
}

function normalizeServiceLevels(value: unknown): ServiceLevel[] {
  if (!Array.isArray(value)) return ['regular'];

  const cleanLevels = value
    .map((level) => String(level).trim().toLowerCase().replace('-', '_').replace(' ', '_'))
    .filter((level): level is ServiceLevel =>
      ALLOWED_SERVICE_LEVELS.includes(level as ServiceLevel)
    );

  const uniqueLevels = Array.from(new Set(cleanLevels));

  if (uniqueLevels.length === 0) {
    return ['regular'];
  }

  if (!uniqueLevels.includes('regular')) {
    uniqueLevels.unshift('regular');
  }

  return uniqueLevels;
}

export async function adminMe(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);

  return json(
    {
      admin: {
        id: admin.id,
        email: admin.email,
        role: admin.role,
      },
    },
    200,
    env
  );
}

export async function listPendingDrivers(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);

  const sb = supabase(env);

  const { data, error } = await sb
    .from('drivers')
    .select('*')
    .in('onboarding_status', ['not_started', 'pending_review', 'approved', 'rejected'])
    .order('created_at', { ascending: false });

  if (error) {
    return json({ error: error.message }, 500, env);
  }

  return json({ drivers: data || [] }, 200, env);
}

export async function approveDriver(
  request: Request,
  env: Env,
  driverId: string
): Promise<Response> {
  const admin = await requireAdmin(request, env);

  const body = await readJson<{
    approvedServiceLevels?: string[];
    notes?: string;
  }>(request);

  const approvedServiceLevels = normalizeServiceLevels(body.approvedServiceLevels);
  const now = new Date().toISOString();
  const sb = supabase(env);

  const { data, error } = await sb
    .from('drivers')
    .update({
      onboarding_status: 'approved',
      subscription_status: 'trial_pending',
      approved_at: now,
      rejected_at: null,
      rejection_reason: null,
      vehicle_service_status: 'approved',
      approved_service_levels: approvedServiceLevels,
      vehicle_service_notes: body.notes || null,
      vehicle_reviewed_at: now,
      vehicle_rejected_at: null,
      vehicle_rejection_reason: null,
      vehicle_suspended_at: null,
      is_online: false,
      availability_status: 'offline',
    })
    .eq('id', driverId)
    .select('*')
    .single();

  if (error) {
    return json({ error: error.message }, 500, env);
  }

  await sb.from('admin_audit_logs').insert({
    admin_user_id: admin.id,
    action: 'approve_driver_vehicle_service',
    target_type: 'driver',
    target_id: driverId,
    metadata: {
      approvedServiceLevels,
      notes: body.notes || null,
    },
  });

  return json({ driver: data }, 200, env);
}

export async function rejectDriver(
  request: Request,
  env: Env,
  driverId: string
): Promise<Response> {
  const admin = await requireAdmin(request, env);

  const body = await readJson<{
    reason?: string;
    notes?: string;
  }>(request);

  const reason = body.reason || body.notes || 'Rejected by admin';
  const now = new Date().toISOString();
  const sb = supabase(env);

  const { data, error } = await sb
    .from('drivers')
    .update({
      onboarding_status: 'rejected',
      rejected_at: now,
      rejection_reason: reason,
      vehicle_service_status: 'rejected',
      approved_service_levels: [],
      vehicle_service_notes: body.notes || reason,
      vehicle_rejected_at: now,
      vehicle_rejection_reason: reason,
      is_online: false,
      availability_status: 'offline',
    })
    .eq('id', driverId)
    .select('*')
    .single();

  if (error) {
    return json({ error: error.message }, 500, env);
  }

  await sb.from('admin_audit_logs').insert({
    admin_user_id: admin.id,
    action: 'reject_driver_vehicle_service',
    target_type: 'driver',
    target_id: driverId,
    metadata: {
      reason,
      notes: body.notes || null,
    },
  });

  return json({ driver: data }, 200, env);
}

export async function suspendDriver(
  request: Request,
  env: Env,
  driverId: string
): Promise<Response> {
  const admin = await requireAdmin(request, env);

  const body = await readJson<{
    reason?: string;
    notes?: string;
  }>(request);

  const reason = body.reason || body.notes || 'Suspended by admin';
  const now = new Date().toISOString();
  const sb = supabase(env);

  const { data, error } = await sb
    .from('drivers')
    .update({
      suspended_at: now,
      vehicle_service_status: 'suspended',
      vehicle_service_notes: body.notes || reason,
      vehicle_suspended_at: now,
      is_online: false,
      availability_status: 'offline',
    })
    .eq('id', driverId)
    .select('*')
    .single();

  if (error) {
    return json({ error: error.message }, 500, env);
  }

  await sb.from('admin_audit_logs').insert({
    admin_user_id: admin.id,
    action: 'suspend_driver_vehicle_service',
    target_type: 'driver',
    target_id: driverId,
    metadata: {
      reason,
      notes: body.notes || null,
    },
  });

  return json({ driver: data }, 200, env);
}