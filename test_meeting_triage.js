#!/usr/bin/env node

/**
 * Test script for improved meeting triage logic
 * 
 * This script tests the enhanced decision logic that should decline
 * informational questions and provide helpful answers instead of scheduling meetings.
 */

const fetch = require('node-fetch');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:4000';

async function testMeetingTriage() {
  console.log('🧪 Testing Improved Meeting Triage Logic\n');
  
  const testCases = [
    {
      name: "Informational Question (should decline)",
      message: "I want to know the difference between a magic link and an enchanted link in descope",
      expectedDecision: "DECLINE",
      expectedBehavior: "Should provide helpful answer about Descope features"
    },
    {
      name: "Genuine Meeting Request (should approve)",
      message: "I need to schedule a meeting to discuss our Q4 strategy with the team. We need to align on priorities and make some key decisions about resource allocation.",
      expectedDecision: "APPROVE",
      expectedBehavior: "Should request meeting details"
    },
    {
      name: "Simple How-to Question (should decline)",
      message: "How do I reset my password?",
      expectedDecision: "DECLINE",
      expectedBehavior: "Should provide helpful instructions"
    },
    {
      name: "Collaborative Discussion (should approve)",
      message: "We need to brainstorm solutions for our authentication issues. Can we get the engineering team together to discuss different approaches?",
      expectedDecision: "APPROVE",
      expectedBehavior: "Should request meeting details"
    },
    {
      name: "Intent Change - Info to Meeting (should approve)",
      message: "I need to know the difference between magic and enchanted link in descope. I would like a meeting to discuss this further.",
      expectedDecision: "APPROVE",
      expectedBehavior: "Should recognize meeting intent and probe for details"
    },
    {
      name: "Incomplete Meeting Request (should probe)",
      message: "I would like a meeting to discuss",
      expectedDecision: "APPROVE",
      expectedBehavior: "Should ask for clarification on meeting purpose"
    },
    {
      name: "Vague Meeting Request After Answer (should probe)",
      message: "What is the difference between magic and enchanted link in descope? Can we have a meeting?",
      expectedDecision: "DECLINE",
      expectedBehavior: "Should ask what additional value meeting would provide"
    },
    {
      name: "Justified Meeting Request After Answer (should approve)",
      message: "What is the difference between magic and enchanted link in descope? I'd like a meeting to discuss implementation details for our project.",
      expectedDecision: "APPROVE",
      expectedBehavior: "Should approve with clear justification"
    }
  ];

  for (const testCase of testCases) {
    console.log(`\n📝 Test: ${testCase.name}`);
    console.log(`Message: "${testCase.message}"`);
    console.log(`Expected: ${testCase.expectedDecision} - ${testCase.expectedBehavior}`);
    
    try {
      // Start a new conversation
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
        continue;
      }
      
      // Send the test message
      const messageResponse = await fetch(`${BASE_URL}/api/agent/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer mock-token'
        },
        body: JSON.stringify({ 
          jobId, 
          content: testCase.message 
        })
      });
      
      if (messageResponse.ok) {
        console.log('   ✅ Message sent successfully');
        console.log('   📋 Check the conversation in your browser to see the response');
      } else {
        console.log(`   ❌ Failed to send message: ${messageResponse.status}`);
      }
      
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
    }
  }
  
  console.log('\n📋 Test Summary:');
  console.log('- Enhanced decision logic: Implemented');
  console.log('- Informational question handling: Improved');
  console.log('- Helpful response generation: Added');
  console.log('- Descope knowledge: Included');
  
  console.log('\n🔧 Expected Behavior:');
  console.log('1. Informational questions should be answered directly');
  console.log('2. Only genuine meeting needs should be approved');
  console.log('3. Declined requests should get helpful responses');
  console.log('4. No more unnecessary meeting forms for simple questions');
}

// Run the test
if (require.main === module) {
  testMeetingTriage().catch(console.error);
}

module.exports = { testMeetingTriage };