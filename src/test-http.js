import fetch from 'node-fetch';

async function testHttpEndpoint(url) {
  console.log(`Testing HTTP endpoint: ${url}`);
  try {
    const response = await fetch(url, {
      method: 'GET',
      timeout: 5000 // 5 second timeout
    });
    
    console.log(`Response status: ${response.status}`);
    const data = await response.text();
    console.log(`Response data: ${data.substring(0, 200)}${data.length > 200 ? '...' : ''}`);
    return true;
  } catch (error) {
    console.error(`Error accessing endpoint: ${error.message}`);
    return false;
  }
}

// Test the health endpoint
const baseUrl = process.argv[2] || 'http://compendiumnav.com';
const healthUrl = `${baseUrl}/health`;

console.log(`Testing connection to VPS server at ${baseUrl}`);
testHttpEndpoint(healthUrl)
  .then(success => {
    console.log(`Health endpoint test ${success ? 'succeeded' : 'failed'}`);
    process.exit(success ? 0 : 1);
  });
