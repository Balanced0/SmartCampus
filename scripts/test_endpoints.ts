import app from '../src/app';
import { AddressInfo } from 'net';
import http from 'http';
import samplePayload from '../test-payload.json';

async function runTests() {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://localhost:${port}`;

  console.log(`\n🚀 Test server listening on ephemeral port ${port}\n`);

  try {
    // 1. Test GET /health
    console.log('--- [1/2] Testing GET /health ---');
    const healthRes = await fetch(`${baseUrl}/health`);
    const healthJson = await healthRes.json();
    console.log('Status Code:', healthRes.status);
    console.log('Response Body:', JSON.stringify(healthJson, null, 2));

    if (healthRes.status === 200 && healthJson.status === 'ok') {
      console.log('✅ GET /health passed!\n');
    } else {
      console.error('❌ GET /health failed!\n');
      process.exit(1);
    }

    // 2. Test POST /optimize-energy
    console.log('--- [2/2] Testing POST /optimize-energy ---');
    const start = Date.now();
    const optRes = await fetch(`${baseUrl}/optimize-energy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    });
    const elapsed = Date.now() - start;
    const optJson: any = await optRes.json();

    console.log(`Status Code: ${optRes.status} (completed in ${elapsed}ms)`);
    console.log(`Scenario ID: ${optJson.scenario_id}`);
    console.log(`Total Grid: ${optJson.total_grid_kwh} kWh`);
    console.log(`Total Cost: ${optJson.total_cost_bdt} BDT`);
    console.log(`Peak Grid: ${optJson.peak_grid_kwh} kWh`);
    console.log(`Plan Summary: ${optJson.plan_summary}`);
    console.log(`Hourly Plan count: ${optJson.hourly_plan?.length} hours`);
    console.log(`Directives count: ${optJson.directive_interpretation?.length}`);

    if (
      optRes.status === 200 &&
      optJson.scenario_id === samplePayload.scenario_id &&
      Array.isArray(optJson.hourly_plan) &&
      optJson.hourly_plan.length === 24
    ) {
      console.log('\n✅ POST /optimize-energy passed!\n');
      console.log('🎉 All automated tests passed successfully!');
    } else {
      console.error('❌ POST /optimize-energy failed!', optJson);
      process.exit(1);
    }
  } catch (err) {
    console.error('Test execution failed with error:', err);
    process.exit(1);
  } finally {
    server.close();
  }
}

runTests();
