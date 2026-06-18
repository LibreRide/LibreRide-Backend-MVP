import type { Env, JsonResponse } from '../types';

export function json(data: JsonResponse, status = 200, env?: Env): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'access-control-allow-origin': env?.CORS_ORIGIN || '*',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type,stripe-signature',
    },
  });
}

export async function readJson<T>(request: Request): Promise<T> {
  try { return await request.json<T>(); }
  catch { throw new Error('Invalid JSON body'); }
}

export function notFound(env: Env): Response {
  return json({ error: 'Not found' }, 404, env);
}

export function badRequest(message: string, env: Env): Response {
  return json({ error: message }, 400, env);
}
