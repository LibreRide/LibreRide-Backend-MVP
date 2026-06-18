import type { Env } from '../types';

type RideState = {
  rideId: string;
  status: string;
  riderId?: string;
  driverId?: string;
  updatedAt: string;
};

export class RideSession implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private sockets = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get('upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.add(server);
      server.addEventListener('close', () => this.sockets.delete(server));
      server.addEventListener('error', () => this.sockets.delete(server));
      server.send(JSON.stringify({ type: 'connected' }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/state')) {
      const patch = await request.json<Partial<RideState>>();
      const previous = (await this.state.storage.get<RideState>('ride')) || {
        rideId: patch.rideId || 'unknown',
        status: 'requested',
        updatedAt: new Date().toISOString(),
      };
      const next = { ...previous, ...patch, updatedAt: new Date().toISOString() };
      await this.state.storage.put('ride', next);
      this.broadcast({ type: 'ride_state_updated', ride: next });
      return Response.json(next);
    }

    const current = await this.state.storage.get<RideState>('ride');
    return Response.json(current || { status: 'empty' });
  }

  private broadcast(payload: unknown) {
    const message = JSON.stringify(payload);
    for (const socket of this.sockets) {
      try { socket.send(message); } catch { this.sockets.delete(socket); }
    }
  }
}
