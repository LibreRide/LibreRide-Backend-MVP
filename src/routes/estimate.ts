import type { Env } from '../types';
import { json } from '../lib/http';

type EstimateRequestBody = {
  pickupAddress?: string;
  destinationAddress?: string;
  pickupLat?: number;
  pickupLng?: number;
};

type MapboxFeature = {
  geometry?: {
    coordinates?: [number, number];
  };
  properties?: {
    full_address?: string;
    name?: string;
    place_formatted?: string;
    coordinates?: {
      longitude?: number;
      latitude?: number;
    };
  };
};

type MapboxGeocodeResponse = {
  features?: MapboxFeature[];
};

type MapboxDirectionsResponse = {
  code?: string;
  routes?: Array<{
    distance?: number;
    duration?: number;
  }>;
};

function toFiniteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function isValidLatitude(value: number | null): value is number {
  return value !== null && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null): value is number {
  return value !== null && value >= -180 && value <= 180;
}

function isZeroCoordinate(lat: number, lng: number): boolean {
  return Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001;
}

function calculateFareCents(distanceMiles: number, durationMinutes: number): number {
  const baseFareCents = 500;
  const perMileCents = 225;
  const perMinuteCents = 35;
  const minimumFareCents = 800;

  const calculatedFare =
    baseFareCents +
    distanceMiles * perMileCents +
    durationMinutes * perMinuteCents;

  return Math.max(minimumFareCents, Math.round(calculatedFare));
}

function getFeatureCoordinates(feature: MapboxFeature): { lat: number; lng: number } | null {
  const geometryCoordinates = feature.geometry?.coordinates;

  if (
    Array.isArray(geometryCoordinates) &&
    Number.isFinite(geometryCoordinates[0]) &&
    Number.isFinite(geometryCoordinates[1])
  ) {
    return {
      lng: Number(geometryCoordinates[0]),
      lat: Number(geometryCoordinates[1]),
    };
  }

  const lng = toFiniteNumber(feature.properties?.coordinates?.longitude);
  const lat = toFiniteNumber(feature.properties?.coordinates?.latitude);

  if (isValidLatitude(lat) && isValidLongitude(lng)) {
    return { lat, lng };
  }

  return null;
}

function getFeatureLabel(feature: MapboxFeature, fallback: string): string {
  const parts = [
    feature.properties?.full_address,
    feature.properties?.name,
    feature.properties?.place_formatted,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : fallback;
}

async function geocodeDestination(
  destinationAddress: string,
  pickupLat: number,
  pickupLng: number,
  env: Env
): Promise<{
  lat: number;
  lng: number;
  label: string;
} | null> {
  const params = new URLSearchParams({
    q: destinationAddress,
    access_token: env.MAPBOX_ACCESS_TOKEN,
    country: 'us',
    limit: '1',
    autocomplete: 'false',
    proximity: `${pickupLng},${pickupLat}`,
    types: 'address,street,place,postcode',
    permanent: 'true',
  });

  const response = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params.toString()}`);
  const data = await response.json() as MapboxGeocodeResponse;

  if (!response.ok || !data.features || data.features.length === 0) {
    return null;
  }

  const feature = data.features[0];
  const coordinates = getFeatureCoordinates(feature);

  if (!coordinates) {
    return null;
  }

  return {
    ...coordinates,
    label: getFeatureLabel(feature, destinationAddress),
  };
}

async function getDrivingRoute(
  pickupLat: number,
  pickupLng: number,
  destinationLat: number,
  destinationLng: number,
  env: Env
): Promise<{
  distanceMiles: number;
  durationMinutes: number;
} | null> {
  const coordinates = `${pickupLng},${pickupLat};${destinationLng},${destinationLat}`;

  const params = new URLSearchParams({
    access_token: env.MAPBOX_ACCESS_TOKEN,
    alternatives: 'false',
    overview: 'false',
    steps: 'false',
  });

  const response = await fetch(
    `https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}?${params.toString()}`
  );

  const data = await response.json() as MapboxDirectionsResponse;
  const route = data.routes?.[0];

  if (!response.ok || data.code !== 'Ok' || !route?.distance || !route?.duration) {
    return null;
  }

  return {
    distanceMiles: route.distance / 1609.344,
    durationMinutes: route.duration / 60,
  };
}

export async function estimateRide(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as EstimateRequestBody;

  if (!body.pickupAddress || !body.destinationAddress) {
    return json(
      { error: 'pickupAddress and destinationAddress are required' },
      400,
      env
    );
  }

  if (!env.MAPBOX_ACCESS_TOKEN) {
    return json({ error: 'MAPBOX_ACCESS_TOKEN is not configured' }, 500, env);
  }

  const pickupLat = toFiniteNumber(body.pickupLat);
  const pickupLng = toFiniteNumber(body.pickupLng);

  if (!isValidLatitude(pickupLat) || !isValidLongitude(pickupLng)) {
    return json(
      { error: 'Valid pickup GPS location is required to estimate the ride.' },
      400,
      env
    );
  }

  if (isZeroCoordinate(pickupLat, pickupLng)) {
    return json(
      { error: 'Pickup GPS location is invalid. Please refresh your GPS and try again.' },
      400,
      env
    );
  }

  const destination = await geocodeDestination(
    body.destinationAddress,
    pickupLat,
    pickupLng,
    env
  );

  if (!destination) {
    return json(
      { error: 'Could not find the destination address. Please enter a more complete address.' },
      400,
      env
    );
  }

  const route = await getDrivingRoute(
    pickupLat,
    pickupLng,
    destination.lat,
    destination.lng,
    env
  );

  if (!route) {
    return json(
      { error: 'Could not calculate driving distance for this ride.' },
      400,
      env
    );
  }

  const estimatedFareCents = calculateFareCents(
    route.distanceMiles,
    route.durationMinutes
  );

  return json(
    {
      pickupAddress: body.pickupAddress,
      destinationAddress: destination.label,
      pickupLat,
      pickupLng,
      destinationLat: destination.lat,
      destinationLng: destination.lng,
      distanceMiles: Number(route.distanceMiles.toFixed(2)),
      estimatedMinutes: Math.max(1, Math.round(route.durationMinutes)),
      estimatedFareCents,
      estimatedFareDollars: Number((estimatedFareCents / 100).toFixed(2)),
      pricing: {
        baseFareCents: 500,
        perMileCents: 225,
        perMinuteCents: 35,
        minimumFareCents: 800,
      },
    },
    200,
    env
  );
}