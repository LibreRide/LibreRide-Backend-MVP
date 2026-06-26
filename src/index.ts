export { RideSession } from './durable/RideSession';

import { createCheckout } from './routes/subscriptions';
import { createRideCheckout, createPrepaidRideCheckout } from './routes/payments';
import type { Env } from './types';
import { json, notFound } from './lib/http';
import { createRide, matchRide, rideSocket, updateRideStatus } from './routes/rides';
import { estimateRide } from './routes/estimate';
import { goOffline, goOnline, updateDriverLocation, registerDriver } from './routes/drivers';
import { adminMe, approveDriver, listPendingDrivers, rejectDriver, suspendDriver } from './routes/admin';
import { stripeWebhook } from './routes/stripe';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return json({ ok: true }, 200, env);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/health') {
        return json(
          {
            ok: true,
            service: 'libreride-backend',
            env: env.APP_ENV,
          },
          200,
          env
        );
      }

      if (path === '/db-test') {
        const response = await fetch(
          `${env.SUPABASE_URL}/rest/v1/users?select=id`,
          {
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            },
          }
        );

        const data = await response.json();

        return json(
          {
            ok: response.ok,
            status: response.status,
            users_count: Array.isArray(data) ? data.length : null,
            data,
          },
          200,
          env
        );
      }

      if (request.method === 'POST' && path === '/api/rides') {
        return createRide(request, env);
      }

      if (request.method === 'POST' && path === '/api/rides/estimate') {
        return estimateRide(request, env);
      }

      const rideStatus = path.match(/^\/api\/rides\/([^/]+)\/status$/);
      if (request.method === 'PATCH' && rideStatus) {
        return updateRideStatus(request, env, rideStatus[1]);
      }

      const rideMatch = path.match(/^\/api\/rides\/([^/]+)\/match$/);
      if (request.method === 'POST' && rideMatch) {
        return matchRide(request, env, rideMatch[1]);
      }

      const rideWs = path.match(/^\/ws\/rides\/([^/]+)$/);
      if (rideWs) {
        return rideSocket(request, env, rideWs[1]);
      }

      if (request.method === 'POST' && path === '/api/drivers/location') {
        return updateDriverLocation(request, env);
      }

      if (request.method === 'POST' && path === '/api/drivers/go-online') {
        return goOnline(request, env);
      }

      if (request.method === 'POST' && path === '/api/drivers/go-offline') {
        return goOffline(request, env);
      }

      if (request.method === 'POST' && path === '/api/drivers/register') {
        return registerDriver(request, env);
      }
if (request.method === 'GET' && path === '/api/admin/me') {
  return adminMe(request, env);
}
      if (request.method === 'GET' && path === '/api/admin/drivers/pending') {
        return listPendingDrivers(request, env);
      }

      const approve = path.match(/^\/api\/admin\/drivers\/([^/]+)\/approve$/);
      if (request.method === 'POST' && approve) {
        return approveDriver(request, env, approve[1]);
      }

      const reject = path.match(/^\/api\/admin\/drivers\/([^/]+)\/reject$/);
      if (request.method === 'POST' && reject) {
        return rejectDriver(request, env, reject[1]);
      }
const suspend = path.match(/^\/api\/admin\/drivers\/([^/]+)\/suspend$/);
if (request.method === 'POST' && suspend) {
  return suspendDriver(request, env, suspend[1]);
}
      if (request.method === 'POST' && path === '/api/webhooks/stripe') {
        return stripeWebhook(request, env);
      }

      if (request.method === 'POST' && path === '/api/subscriptions/create-checkout') {
        return createCheckout(request, env);
      }

      if (request.method === 'POST' && path === '/api/payments/prepaid-ride-checkout') {
        return createPrepaidRideCheckout(request, env);
      }

      if (request.method === 'POST' && path === '/api/payments/create-checkout') {
        return createRideCheckout(request, env);
      }

      return notFound(env);
    } catch (error) {
      const message = (error as Error).message;
      const status =
        message === 'Unauthorized'
          ? 401
          : message === 'Forbidden'
            ? 403
            : 500;

      return json({ error: message }, status, env);
    }
  },
};