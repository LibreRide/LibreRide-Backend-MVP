import type { Env, AuthUser } from '../types';
import { supabase } from './supabase';

export async function getAuthUser(request: Request, env: Env): Promise<AuthUser | null> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length);
  const sb = supabase(env);
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return null;

  const { data: profile } = await sb
    .from('users')
    .select('id, role, email')
    .eq('auth_user_id', data.user.id)
    .single();

  return profile as AuthUser | null;
}

export async function requireRole(request: Request, env: Env, roles: AuthUser['role'][]): Promise<AuthUser> {
  const user = await getAuthUser(request, env);
  if (!user) throw new Error('Unauthorized');
  if (!roles.includes(user.role)) throw new Error('Forbidden');
  return user;
}
