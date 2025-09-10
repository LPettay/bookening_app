# Descope Calendar Integration Setup

This document explains how to configure Descope to enable automatic Google Calendar token fetching for the booking system.

## Overview

The system now supports fetching Google Calendar tokens directly from Descope when agents try to book events. This eliminates the need for users to manually connect their Google accounts through OAuth flows.

## Descope Configuration

### 1. Create a Google Calendar Outbound App

1. Log into your Descope console
2. Navigate to **Integrations** > **Outbound Apps**
3. Click **Add App** and select **Google Calendar**
4. Configure the app with:
   - **App Name**: `Google Calendar Integration` (or any name containing "calendar")
   - **Scopes**: `https://www.googleapis.com/auth/calendar`
   - **Client ID**: Your Google OAuth client ID
   - **Client Secret**: Your Google OAuth client secret

### 2. Environment Variables

Ensure these environment variables are set in your `.env` file:

```bash
DESCOPE_ENABLED=true
DESCOPE_PROJECT_ID=your_descope_project_id
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=your_google_redirect_uri
GOOGLE_CALENDAR_ID=your_calendar_id_or_primary
```

### 3. User Token Management

Users need to have their Google Calendar tokens stored in Descope. This can be done through:

1. **Descope Flows**: Create a flow that prompts users to connect their Google Calendar
2. **Admin API**: Use Descope's management API to store tokens for users
3. **Manual Setup**: For testing, you can manually add tokens through the Descope console

## How It Works

### Token Fetching Flow

1. When an agent tries to book an event, the system first attempts to fetch Google tokens from Descope
2. If Descope tokens are available, they are used for calendar operations
3. If Descope tokens are not available, the system falls back to locally stored tokens
4. If no tokens are available, the operation fails with an appropriate error message

### API Endpoints

#### Fetch Descope Tokens
```
POST /api/calendar/descope-tokens
Content-Type: application/json

{
  "userId": "optional_user_id",
  "userEmail": "optional_user_email"
}
```

Response:
```json
{
  "success": true,
  "tokens": {
    "access_token": "...",
    "refresh_token": "...",
    "expiry_date": 1234567890,
    "token_type": "Bearer"
  }
}
```

### Enhanced Calendar Operations

All calendar operations now support Descope token fetching:

- **Calendar Suggestions**: `/api/calendar/suggest` - Uses Descope tokens when available
- **Event Scheduling**: `/api/agent/complete` and `/api/agent/form/submit` - Uses Descope tokens for booking
- **Agent Calendar Tools**: Automatically uses Descope tokens when agents need calendar access

## Fallback Behavior

The system maintains backward compatibility:

1. **Primary**: Descope token fetching (when enabled and tokens available)
2. **Secondary**: Local user token storage (existing OAuth flow)
3. **Tertiary**: Owner token fallback (for owner-only operations)

## Error Handling

- If Descope is not configured, the system silently falls back to local tokens
- If Descope tokens are not available for a user, the system falls back to local tokens
- If no tokens are available at all, appropriate error messages are returned
- All errors are logged for debugging purposes

## Testing

To test the integration:

1. Ensure Descope is properly configured
2. Create a test user with Google Calendar tokens in Descope
3. Start a booking conversation through the agent
4. Verify that calendar operations use Descope tokens (check logs)
5. Test fallback behavior by removing Descope tokens

## Troubleshooting

### Common Issues

1. **"No Google Calendar outbound app found"**
   - Ensure the outbound app name contains "calendar"
   - Verify the app is properly configured in Descope

2. **"No valid tokens found in Descope"**
   - Check that the user has valid Google Calendar tokens stored in Descope
   - Verify the user ID and email match what's stored in Descope

3. **"Descope not enabled"**
   - Set `DESCOPE_ENABLED=true` in your environment
   - Verify `DESCOPE_PROJECT_ID` is correctly set

### Debug Logging

The system logs detailed information about token fetching:
- When Descope tokens are successfully fetched
- When fallback to local tokens occurs
- Any errors during the token fetching process

Check your server logs for messages like:
- `"Using Descope tokens for user {email} calendar access"`
- `"Failed to fetch Descope tokens for user {email}, falling back to local tokens"`