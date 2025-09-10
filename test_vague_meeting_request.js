#!/usr/bin/env node

/**
 * Test script for vague meeting request scenario
 * 
 * This tests the specific case where a user:
 * 1. Asks an informational question
 * 2. Gets a complete answer
 * 3. Then asks for a meeting without justification
 * 
 * The system should probe for what additional value the meeting would provide.
 */

const fetch = require('node-fetch');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:4000';

async function testVagueMeetingRequest() {
  console.log('🧪 Testing Vague Meeting Request Scenario\n');
  
  try {
    // Start a new conversation
    console.log('1. Starting conversation...');
    const startResponse = await fetch(`${BASE_URL}/api/agent/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token'
      },
      body: JSON.stringify({ initialMessage: '' })
    });
    
    const startData = await startResponse.json();
    const jobId = startData.jobId;
    
    if (!jobId) {
      console.log('   ❌ Failed to start conversation');
      return;
    }
    
    console.log(`   ✅ Conversation started with jobId: ${jobId}`);
    
    // Step 1: Ask informational question
    console.log('\n2. Asking informational question...');
    const infoResponse = await fetch(`${BASE_URL}/api/agent/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token'
      },
      body: JSON.stringify({ 
        jobId, 
        content: "What is the difference between a magic link and enchanted link in descope?"
      })
    });
    
    if (infoResponse.ok) {
      console.log('   ✅ Informational question sent');
      console.log('   📋 Expected: Should get complete answer about Descope features');
    } else {
      console.log(`   ❌ Failed to send informational question: ${infoResponse.status}`);
    }
    
    // Wait a moment for processing
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Step 2: Ask for meeting without justification
    console.log('\n3. Asking for meeting without justification...');
    const meetingResponse = await fetch(`${BASE_URL}/api/agent/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token'
      },
      body: JSON.stringify({ 
        jobId, 
        content: "Can we have a meeting?"
      })
    });
    
    if (meetingResponse.ok) {
      console.log('   ✅ Meeting request sent');
      console.log('   📋 Expected: Should probe for what additional value meeting would provide');
      console.log('   📋 Should NOT: Immediately approve and show meeting form');
      console.log('   📋 Should ask: What specific aspect needs discussion? What additional value?');
    } else {
      console.log(`   ❌ Failed to send meeting request: ${meetingResponse.status}`);
    }
    
    console.log('\n📋 Test Summary:');
    console.log('- Vague meeting request handling: Should work now');
    console.log('- Justification probing: Should ask for specific value');
    console.log('- Context awareness: Should recognize complete answer was given');
    
    console.log('\n🔧 Expected Behavior:');
    console.log('1. First message: Complete answer about magic vs enchanted links');
    console.log('2. Second message: Probing questions about meeting value');
    console.log('3. No immediate meeting form approval');
    console.log('4. Questions like: "What specific aspect would you like to discuss further?"');
    
    console.log('\n💡 Check your browser to see the actual conversation flow!');
    
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
  }
}

// Run the test
if (require.main === module) {
  testVagueMeetingRequest().catch(console.error);
}

module.exports = { testVagueMeetingRequest };