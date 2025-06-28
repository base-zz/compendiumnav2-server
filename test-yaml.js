import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testYaml() {
  // Try the path from bluetoothService.js
  const ymlPath1 = path.join(__dirname, 'src', 'bluetooth', 'btman.yml');
  console.log('\n=== Testing YAML Path 1 ===');
  console.log('Path:', ymlPath1);
  await testPath(ymlPath1);

  // Try alternative path
  const ymlPath2 = path.join(__dirname, 'src', 'bluetooth', 'config', 'btman.yml');
  console.log('\n=== Testing YAML Path 2 ===');
  console.log('Path:', ymlPath2);
  await testPath(ymlPath2);
}

async function testPath(ymlPath) {
  try {
    await fs.access(ymlPath);
    console.log('✅ File exists!');
    
    const content = await fs.readFile(ymlPath, 'utf8');
    console.log('File size:', content.length, 'bytes');
    console.log('First 100 chars:', content.substring(0, 100));
    
    // Try to parse YAML
    const yaml = await import('js-yaml');
    const data = yaml.load(content);
    console.log('YAML parsed successfully!');
    console.log('Top-level keys:', Object.keys(data));
    
    if (data.company_identifiers) {
      console.log(`Found ${data.company_identifiers.length} company identifiers`);
      const apple = data.company_identifiers.find(c => {
        const id = typeof c.value === 'string' && c.value.startsWith('0x') 
          ? parseInt(c.value.substring(2), 16) 
          : c.value;
        return id === 0x004C; // Apple's company ID
      });
      console.log('Apple entry:', apple || 'Not found!');
    } else {
      console.log('❌ No company_identifiers found in YAML');
    }
    
    return true;
  } catch (err) {
    console.error('❌ Error:', err.message);
    return false;
  }
}

testYaml().catch(console.error);
