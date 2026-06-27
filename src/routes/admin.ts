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
  const { data: currentDriver, error: readError } = await sb
    .from('drivers')
    .select('*')
    .eq('id', driverId)
    .maybeSingle();

  if (readError || !currentDriver) {
    return json({ error: 'Driver not found' }, 404, env);
  }

  if (currentDriver.deactivation_status === 'deactivated_permanent') {
    return json(
      { error: 'This driver has been permanently deactivated and cannot be approved.' },
      403,
      env
    );
  }

  if (currentDriver.identity_verification_status !== 'cleared') {
    return json(
      { error: 'Driver identity must be cleared before approval.' },
      403,
      env
    );
  }

  if (currentDriver.background_check_status !== 'passed') {
    return json(
      { error: 'Background check must be marked as passed before approval.' },
      403,
      env
    );
  }
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
export async function reviewDriverBackgroundCheck(
  request: Request,
  env: Env,
  driverId: string
): Promise<Response> {
  const admin = await requireAdmin(request, env);

  const body = await readJson<{
    status?: string;
    notes?: string;
  }>(request);

  const status = String(body.status || '').trim().toLowerCase();
  const allowedStatuses = ['pending', 'passed', 'failed'];

  if (!allowedStatuses.includes(status)) {
    return json(
      { error: 'Background check status must be pending, passed, or failed.' },
      400,
      env
    );
  }

  const now = new Date().toISOString();
  const sb = supabase(env);

  const updates: Record<string, unknown> = {
    background_check_status: status,
    background_check_notes: body.notes || null,
    background_check_reviewed_at: now,
    background_check_reviewed_by: admin.id,
    is_online: false,
    availability_status: 'offline',
  };

  if (status === 'failed') {
    updates.onboarding_status = 'rejected';
    updates.rejected_at = now;
    updates.rejection_reason = body.notes || 'Background check failed';
    updates.vehicle_service_status = 'rejected';
    updates.approved_service_levels = [];
    updates.vehicle_rejected_at = now;
    updates.vehicle_rejection_reason = body.notes || 'Background check failed';
  }

  const { data, error } = await sb
    .from('drivers')
    .update(updates)
    .eq('id', driverId)
    .select('*')
    .single();

  if (error) {
    return json({ error: error.message }, 500, env);
  }

  await sb.from('admin_audit_logs').insert({
    admin_user_id: admin.id,
    action: 'review_driver_background_check',
    target_type: 'driver',
    target_id: driverId,
    metadata: {
      status,
      notes: body.notes || null,
    },
  });

  return json({ driver: data }, 200, env);
}

export async function deactivateDriverPermanently(
  request: Request,
  env: Env,
  driverId: string
): Promise<Response> {
  const admin = await requireAdmin(request, env);

  const body = await readJson<{
    reason?: string;
    notes?: string;
  }>(request);

  const reason = body.reason || body.notes || 'Permanently deactivated by admin';
  const now = new Date().toISOString();
  const sb = supabase(env);

  const { data: currentDriver, error: readError } = await sb
    .from('drivers')
    .select('*')
    .eq('id', driverId)
    .maybeSingle();

  if (readError || !currentDriver) {
    return json({ error: 'Driver not found' }, 404, env);
  }

  const { data, error } = await sb
    .from('drivers')
    .update({
      onboarding_status: 'rejected',
      rejected_at: now,
      rejection_reason: reason,
      suspended_at: now,
      deactivation_status: 'deactivated_permanent',
      deactivated_at: now,
      deactivation_reason: reason,
      identity_verification_status: 'deactivated_permanent',
      duplicate_flag: true,
      duplicate_reason:
        'This driver identity has been permanently deactivated and cannot create another account.',
      duplicate_detected_at: now,
      vehicle_service_status: 'suspended',
      approved_service_levels: [],
      vehicle_service_notes: reason,
      vehicle_suspended_at: now,
      background_check_status: 'failed',
      background_check_notes: reason,
      background_check_reviewed_at: now,
      background_check_reviewed_by: admin.id,
      is_online: false,
      availability_status: 'offline',
    })
    .eq('id', driverId)
    .select('*')
    .single();

  if (error) {
    return json({ error: error.message }, 500, env);
  }

  if (currentDriver.identity_registry_id) {
    await sb
      .from('driver_identity_registry')
      .update({
        status: 'deactivated_permanent',
        blocked_reason: reason,
        blocked_at: now,
        updated_at: now,
      })
      .eq('id', currentDriver.identity_registry_id);
  } else {
    await sb
      .from('driver_identity_registry')
      .update({
        status: 'deactivated_permanent',
        blocked_reason: reason,
        blocked_at: now,
        updated_at: now,
      })
      .eq('driver_id', driverId);
  }

  await sb.from('admin_audit_logs').insert({
    admin_user_id: admin.id,
    action: 'permanently_deactivate_driver',
    target_type: 'driver',
    target_id: driverId,
    metadata: {
      reason,
      notes: body.notes || null,
    },
  });


  return json({ driver: data }, 200, env);
}
export async function createDriverDocumentSignedUrl(
  request: Request,
  env: Env
): Promise<Response> {
  await requireAdmin(request, env);

  const body = await readJson<{
    path?: string;
  }>(request);

  const documentPath = String(body.path || '').trim();

  if (!documentPath) {
    return json({ error: 'Document path is required.' }, 400, env);
  }

  if (
    documentPath.startsWith('http://') ||
    documentPath.startsWith('https://') ||
    documentPath.includes('..')
  ) {
    return json({ error: 'Invalid document path.' }, 400, env);
  }

  const sb = supabase(env);

  const { data, error } = await sb.storage
    .from('driver-documents')
    .createSignedUrl(documentPath, 300);

  if (error || !data?.signedUrl) {
    return json(
      { error: error?.message || 'Could not open document.' },
      404,
      env
    );
  }

  return json({ signedUrl: data.signedUrl }, 200, env);
}