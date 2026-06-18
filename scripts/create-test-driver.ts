import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function createTestDriver() {
  const timestamp = Date.now();
  const email = `drivertest${timestamp}@test.com`;

  console.log(`Creating driver: ${email}`);

  // Create user
  const { data: user, error: userError } = await supabase
    .from('users')
    .insert({
      email,
      first_name: 'Test',
      last_name: 'Driver',
      phone_number: '5551234567',
      role: 'driver',
    })
    .select()
    .single();

  if (userError) {
    console.error('User error:', userError);
    return;
  }

  // Create driver
  const { data: driver, error: driverError } = await supabase
    .from('drivers')
    .insert({
      user_id: user.id,
      onboarding_status: 'pending_review',
    })
    .select()
    .single();

  if (driverError) {
    console.error('Driver error:', driverError);
    return;
  }

  // Create vehicle
  const { error: vehicleError } = await supabase
    .from('vehicles')
    .insert({
      driver_id: driver.id,
      year: 2024,
      make: 'Toyota',
      model: 'Camry',
      license_plate: `TEST${timestamp.toString().slice(-4)}`,
    });

  if (vehicleError) {
    console.error('Vehicle error:', vehicleError);
    return;
  }

  console.log('✅ Test driver created');
  console.log('Email:', email);
  console.log('Driver ID:', driver.id);
}

createTestDriver().catch(console.error);