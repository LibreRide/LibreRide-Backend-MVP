import type { Env } from '../types';
import { json, readJson } from '../lib/http';
import { requireRole } from '../lib/auth';
import { supabase } from '../lib/supabase';

export async function listPendingDrivers(request: Request, env: Env): Promise<Response> {
 // await requireRole(request, env, ['admin']);
  const sb = supabase(env);
  const { data, error } = await sb.from('drivers').select('*, users(*), vehicles(*)').in('onboarding_status', ['pending_review', 'in_progress']);
  if (error) return json({ error: error.message }, 500, env);
  return json({ drivers: data }, 200, env);
}

export async function approveDriver(request: Request, env: Env, driverId: string): Promise<Response> {
 // const admin = await requireRole(request, env, ['admin']);
 const admin = { id: '00000000-0000-0000-0000-000000000000' };
  const sb = supabase(env);
  const { data, error } = await sb.from('drivers').update({
    onboarding_status: 'approved',
    subscription_status: 'trial_pending',
    approved_at: new Date().toISOString(),
  }).eq('id', driverId).select('*').single();
  if (error) return json({ error: error.message }, 500, env);
  await sb.from('admin_audit_logs').insert({ admin_user_id: admin.id, action: 'approve_driver', target_type: 'driver', target_id: driverId });
  return json({ driver: data }, 200, env);
}

export async function rejectDriver(request: Request, env: Env, driverId: string): Promise<Response> {
  const admin = await requireRole(request, env, ['admin']);
  const body = await readJson<{ reason: string }>(request);
  const sb = supabase(env);
  const { data, error } = await sb.from('drivers').update({ onboarding_status: 'rejected' }).eq('id', driverId).select('*').single();
  if (error) return json({ error: error.message }, 500, env);
  await sb.from('admin_audit_logs').insert({ admin_user_id: admin.id, action: 'reject_driver', target_type: 'driver', target_id: driverId, metadata: { reason: body.reason } });
  return json({ driver: data }, 200, env);
}
