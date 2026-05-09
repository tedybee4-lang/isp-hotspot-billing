# Daraja API Setup Guide

This guide will help you connect your Safaricom Daraja API to the Ultrafaiba website.

## Prerequisites

1. Safaricom developer account (https://developer.safaricom.co.ke)
2. M-Pesa Business Shortcode (Paybill or Till Number)
3. Your app is already approved for production on Daraja

## Step 1: Get Your Credentials

Log into the Daraja portal and get these values:

1. **Consumer Key** - Found in your app settings
2. **Consumer Secret** - Found in your app settings
3. **Business Shortcode** - Your M-Pesa Paybill or Till number
4. **Passkey** - Get this from your M-Pesa account or Daraja portal

## Step 2: Configure the API

Edit `src/services/darajaApi.ts` and replace the placeholder values:

```typescript
const DARAJA_CONFIG = {
  CONSUMER_KEY: 'YOUR_ACTUAL_CONSUMER_KEY',
  CONSUMER_SECRET: 'YOUR_ACTUAL_CONSUMER_SECRET',
  BUSINESS_SHORTCODE: '174379', // Your Paybill/Till number
  PASSKEY: 'YOUR_ACTUAL_PASSKEY',
  CALLBACK_URL: 'https://yourdomain.com/api/mpesa/callback',
  // ... rest of config
};
```

## Step 3: Set Up Callback URL

The callback URL must be:
- HTTPS (not HTTP)
- Publicly accessible from the internet
- Able to receive POST requests

### Example Node.js/Express callback handler:

```javascript
app.post('/api/mpesa/callback', (req, res) => {
  const callbackData = req.body;
  
  // Validate the callback
  if (validateCallback(callbackData)) {
    const result = processCallback(callbackData);
    
    if (result.success) {
      // Update your database
      // Mark invoice as paid
      // Send confirmation SMS/email
      console.log('Payment successful:', result.mpesaReceiptNumber);
    }
  }
  
  // Always respond with 200 OK
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
});
```

## Step 4: Switch to Production

Change the base URL from sandbox to production:

```typescript
// For testing (sandbox)
BASE_URL: 'https://sandbox.safaricom.co.ke'

// For live payments (production)
BASE_URL: 'https://api.safaricom.co.ke'
```

## Step 5: Test the Integration

1. Go to the Billing section
2. Click "AutoPay via M-Pesa STK Push"
3. Enter a test phone number (use your own for testing)
4. Click "Send STK Push"
5. You should receive an M-Pesa PIN prompt on your phone

## Environment Variables (Recommended)

For better security, use environment variables:

Create a `.env` file:
```
VITE_DARAJA_CONSUMER_KEY=your_consumer_key
VITE_DARAJA_CONSUMER_SECRET=your_consumer_secret
VITE_DARAJA_PASSKEY=your_passkey
VITE_DARAJA_SHORTCODE=174379
VITE_DARAJA_CALLBACK_URL=https://yourdomain.com/api/mpesa/callback
```

Then update `darajaApi.ts`:
```typescript
const DARAJA_CONFIG = {
  CONSUMER_KEY: import.meta.env.VITE_DARAJA_CONSUMER_KEY,
  CONSUMER_SECRET: import.meta.env.VITE_DARAJA_CONSUMER_SECRET,
  // ... etc
};
```

## Troubleshooting

### "Invalid Credentials" Error
- Double-check your Consumer Key and Secret
- Ensure your app is approved for production

### "Invalid Business Shortcode" Error
- Verify your Paybill/Till number is correct
- Ensure the shortcode is registered on Daraja

### Callback Not Receiving Data
- Check your callback URL is HTTPS
- Ensure your server responds with 200 OK
- Test the callback URL manually with a POST request

### Phone Number Format
The API expects format: `254712345678`
- Remove leading 0 and add 254
- Or pass numbers starting with 0, and the code will auto-format them

## Security Notes

1. **Never commit credentials to git** - Use environment variables
2. **Validate callbacks** - Always validate the callback signature
3. **Use HTTPS** - All API calls and callbacks must use HTTPS
4. **Store sensitive data securely** - Don't expose passkeys in frontend code

## Support

For Daraja API support:
- Safaricom Developer Portal: https://developer.safaricom.co.ke
- Email: apisupport@safaricom.co.ke

For Ultrafaiba technical support:
- Phone: 0724167975
- Email: support@ultrafaiba.net
