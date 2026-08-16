const fs = require('fs');

async function main() {
  const res = await fetch('https://api.plane.so/api/v1/workspaces/something2/projects/5af54080-02ab-4ce8-8473-0b20632e0460/issues/?state=2ae612a0-91ca-496b-accc-35d45d0861c4', {
    headers: {
      'x-api-key': 'plane_api_dc4f0777550942bfadb8d05f2edd1d7d'
    }
  });
  const data = await res.json();
  const backlog = data.results.filter(i => i.state === '2ae612a0-91ca-496b-accc-35d45d0861c4');
  console.log('Backlog tasks:');
  backlog.forEach(i => console.log('- ' + i.name));
}

main().catch(console.error);
