# LibreRide MVP API

Base URL: Cloudflare Worker URL or custom domain.

Authentication: Supabase JWT in `Authorization: Bearer <token>`.

## Public

### GET /health
Returns service health.

## Rider

### POST /api/rides
Creates a ride request.

Body:
```json
{
  "pickup_address": "Brickell Ave, Miami, FL",
  "destination_address": "Miami International Airport",
  "pickup_lat": 25.7617,
  "pickup_lng": -80.1918,
  "destination_lat": 25.7959,
  "destination_lng": -80.2870,
  "estimated_distance_miles": 8.5,
  "estimated_duration_minutes": 22
}
```

## Driver

### POST /api/drivers/location
Updates driver GPS location.

Body:
```json
{ "lat": 25.7617, "lng": -80.1918, "is_online": true }
```

### POST /api/drivers/go-online
Sets approved active driver online.

### POST /api/drivers/go-offline
Sets driver offline.

### PATCH /api/rides/:rideId/status
Updates trip state.

Body:
```json
{ "status": "driver_arrived" }
```

Allowed statuses:
- driver_en_route
- driver_arrived
- in_progress
- completed
- canceled

## Admin

### GET /api/admin/drivers/pending
Lists pending driver applications.

### POST /api/admin/drivers/:driverId/approve
Approves a driver.

### POST /api/admin/drivers/:driverId/reject
Rejects a driver.

Body:
```json
{ "reason": "Insurance document expired" }
```

### POST /api/rides/:rideId/match
Manually triggers MVP matching flow for a ride.

## Realtime

### WebSocket /ws/rides/:rideId
Connects rider/driver/admin client to a Durable Object ride session.

Messages received:
```json
{ "type": "ride_state_updated", "ride": { "rideId": "...", "status": "matched" } }
```

## Webhooks

### POST /api/webhooks/stripe
Receives Stripe webhook events.
