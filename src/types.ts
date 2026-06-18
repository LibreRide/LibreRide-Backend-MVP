export interface Env {
  APP_ENV: string;
  CORS_ORIGIN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_PRICE_ID: string;
  STRIPE_WEBHOOK_SECRET: string;
  MAPBOX_ACCESS_TOKEN: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
  RIDE_SESSIONS: DurableObjectNamespace;
}

export type JsonResponse = Record<string, unknown> | unknown[];

export interface AuthUser {
  id: string;
  role: 'rider' | 'driver' | 'admin';
  email?: string;
}
