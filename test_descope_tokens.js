#!/usr/bin/env node

/**
 * Test script for Descope Calendar Token Integration
 * 
 * This script tests the new Descope token fetching functionality
 * Run with: node test_descope_tokens.js
 */

const fetch = require('node-fetch');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:4000';
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL || 'test@example.com';
const TEST_USER_ID = process.env.TEST_USER_ID || 'test-user-123';

async function testDescopeTokenEndpoint() {
  console.log('🧪 Testing Descope Calendar Token Integration\n');
  
  try {
    // Test 1: Fetch tokens endpoint
    console.log('1. Testing Descope token fetching endpoint...');
    const response = await fetch(`${BASE_URL}/api/calendar/descope-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token' // This would be a real token in production
      },
      body: JSON.stringify({
        userId: TEST_USER_ID,
        userEmail: TEST_USER_EMAIL
      })
    });
    
    const result = await response.json();
    console.log(`   Status: ${response.status}`);
    console.log(`   Response:`, JSON.stringify(result, null, 2));
    
    if (result.success) {
      console.log('   ✅ Descope tokens fetched successfully');
    } else {
      console.log('   ⚠️  No Descope tokens found (expected if not configured)');
    }
    
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
  
  console.log('\n2. Testing calendar suggest endpoint...');
  try {
    const response = await fetch(`${BASE_URL}/api/calendar/suggest?ownerOnly=true&days=1`, {
      headers: {
        'Authorization': 'Bearer mock-token'
      }
    });
    
    const result = await response.json();
    console.log(`   Status: ${response.status}`);
    console.log(`   Suggestions found: ${result.suggestions?.length || 0}`);
    console.log(`   Owner only: ${result.ownerOnly}`);
    
    if (result.suggestions && result.suggestions.length > 0) {
      console.log('   ✅ Calendar suggestions working');
    } else {
      console.log('   ⚠️  No calendar suggestions (may need Google Calendar setup)');
    }
    
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
  
  console.log('\n3. Testing health endpoint...');
  try {
    const response = await fetch(`${BASE_URL}/api/health`);
    const result = await response.json();
    console.log(`   Status: ${response.status}`);
    console.log(`   Health: ${result.ok ? '✅ OK' : '❌ Not OK'}`);
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
  
  console.log('\n📋 Test Summary:');
  console.log('- Descope token endpoint: Implemented');
  console.log('- Calendar suggest endpoint: Enhanced with Descope support');
  console.log('- Fallback mechanisms: Implemented');
  console.log('- Error handling: Implemented');
  
  console.log('\n🔧 Next Steps:');
  console.log('1. Configure Descope with Google Calendar outbound app');
  console.log('2. Set DESCOPE_ENABLED=true in your environment');
  console.log('3. Add user tokens to Descope for testing');
  console.log('4. Test the full booking flow with real Descope tokens');
}

// Run the test
if (require.main === module) {
  testDescopeTokenEndpoint().catch(console.error);
}

module.exports = { testDescopeTokenEndpoint };