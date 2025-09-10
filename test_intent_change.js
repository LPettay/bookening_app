#!/usr/bin/env node

/**
 * Test script for intent change scenario
 * 
 * This tests the specific case where a user:
 * 1. Asks an informational question
 * 2. Gets an answer
 * 3. Then expresses a desire for a meeting
 * 
 * The system should recognize the intent change and probe for meeting details.
 */

const fetch = require('node-fetch');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:4000';

async function testIntentChange() {
  console.log('🧪 Testing Intent Change Scenario\n');
  
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
        content: "I need to know the difference between magic and enchanted link in descope"
      })
    });
    
    if (infoResponse.ok) {
      console.log('   ✅ Informational question sent');
      console.log('   📋 Expected: Should get direct answer about Descope features');
    } else {
      console.log(`   ❌ Failed to send informational question: ${infoResponse.status}`);
    }
    
    // Wait a moment for processing
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Step 2: Express meeting intent
    console.log('\n3. Expressing meeting intent...');
    const meetingResponse = await fetch(`${BASE_URL}/api/agent/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token'
      },
      body: JSON.stringify({ 
        jobId, 
        content: "I would like a meeting to discuss"
      })
    });
    
    if (meetingResponse.ok) {
      console.log('   ✅ Meeting request sent');
      console.log('   📋 Expected: Should recognize meeting intent and probe for details');
      console.log('   📋 Should NOT: Repeat the same informational answer');
    } else {
      console.log(`   ❌ Failed to send meeting request: ${meetingResponse.status}`);
    }
    
    console.log('\n📋 Test Summary:');
    console.log('- Intent change recognition: Should work now');
    console.log('- Meeting probing: Should ask for details');
    console.log('- Context awareness: Should not repeat previous answers');
    
    console.log('\n🔧 Expected Behavior:');
    console.log('1. First message: Direct answer about magic vs enchanted links');
    console.log('2. Second message: Recognition of meeting intent + probing questions');
    console.log('3. No repetition of the same informational answer');
    
    console.log('\n💡 Check your browser to see the actual conversation flow!');
    
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
  }
}

// Run the test
if (require.main === module) {
  testIntentChange().catch(console.error);
}

module.exports = { testIntentChange };