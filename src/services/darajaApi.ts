// Daraja API Integration for M-Pesa STK Push
// Replace these with your actual Safaricom Daraja credentials

const DARAJA_CONFIG = {
  // Your Daraja API credentials
  CONSUMER_KEY: 'fgkxVtFnruYiWG7ftxnHALuIywWhK8Maw1NKWLqACQgeUnzg',
  CONSUMER_SECRET: 'XLGINGUNGVBRdCuAJu9ilVBzcESzeVMatK1Tc7qfUNYee2gL2Gse1pr8aXQlj66e',
  
  // API endpoints
  BASE_URL: 'https://sandbox.safaricom.co.ke', // Change to production: https://api.safaricom.co.ke
  
  // Business Shortcode (Paybill or Till Number)
  BUSINESS_SHORTCODE: '174379', // Sandbox test shortcode
  
  // Lipa na M-Pesa Online Passkey (from Daraja portal)
  // Sandbox passkey for testing
  PASSKEY: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  
  // Callback URL - must be HTTPS and publicly accessible
  // For sandbox testing, you can use a temporary URL or localhost with ngrok
  CALLBACK_URL: 'https:// ultrafaiba.netlify.app/api/mpesa/callback',
  
  // Transaction description
  ACCOUNT_REFERENCE: 'Ultrafaiba Internet',
  TRANSACTION_DESC: 'Internet Subscription Payment'
};

// Types
interface StkPushRequest {
  phoneNumber: string; // Format: 254712345678
  amount: number;
  accountReference?: string;
  transactionDesc?: string;
}

interface StkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: string;
}

// Get OAuth Token
async function getAccessToken(): Promise<string> {
  const auth = btoa(`${DARAJA_CONFIG.CONSUMER_KEY}:${DARAJA_CONFIG.CONSUMER_SECRET}`);
  
  const response = await fetch(`${DARAJA_CONFIG.BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error('Failed to get access token');
  }
  
  const data: TokenResponse = await response.json();
  return data.access_token;
}

// Generate password for STK push
function generatePassword(timestamp: string): string {
  const dataToEncode = `${DARAJA_CONFIG.BUSINESS_SHORTCODE}${DARAJA_CONFIG.PASSKEY}${timestamp}`;
  return btoa(dataToEncode);
}

// Format phone number to 254XXXXXXXXX
function formatPhoneNumber(phone: string): string {
  // Remove spaces and non-digits
  let cleaned = phone.replace(/\s/g, '').replace(/\D/g, '');
  
  // If starts with 0, replace with 254
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.substring(1);
  }
  
  // If starts with +, remove it
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  }
  
  return cleaned;
}

// Initiate STK Push
export async function initiateStkPush(request: StkPushRequest): Promise<StkPushResponse> {
  try {
    const accessToken = await getAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = generatePassword(timestamp);
    const formattedPhone = formatPhoneNumber(request.phoneNumber);
    
    const payload = {
      BusinessShortCode: DARAJA_CONFIG.BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(request.amount),
      PartyA: formattedPhone,
      PartyB: DARAJA_CONFIG.BUSINESS_SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: DARAJA_CONFIG.CALLBACK_URL,
      AccountReference: request.accountReference || DARAJA_CONFIG.ACCOUNT_REFERENCE,
      TransactionDesc: request.transactionDesc || DARAJA_CONFIG.TRANSACTION_DESC
    };
    
    const response = await fetch(`${DARAJA_CONFIG.BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.errorMessage || 'STK push failed');
    }
    
    const data: StkPushResponse = await response.json();
    return data;
    
  } catch (error) {
    console.error('Daraja STK Push Error:', error);
    throw error;
  }
}

// Query STK Push Status
export async function queryStkPushStatus(checkoutRequestId: string): Promise<any> {
  try {
    const accessToken = await getAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = generatePassword(timestamp);
    
    const payload = {
      BusinessShortCode: DARAJA_CONFIG.BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId
    };
    
    const response = await fetch(`${DARAJA_CONFIG.BASE_URL}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.errorMessage || 'Query failed');
    }
    
    return await response.json();
    
  } catch (error) {
    console.error('Query Error:', error);
    throw error;
  }
}

// Validate callback from M-Pesa (for your backend)
export function validateCallback(callbackData: any): boolean {
  // Validate the callback signature
  // This should be done on your backend
  // Return true if valid, false otherwise
  return callbackData && callbackData.Body && callbackData.Body.stkCallback;
}

// Process callback result
export function processCallback(callbackData: any): {
  success: boolean;
  resultCode: number;
  resultDesc: string;
  mpesaReceiptNumber?: string;
  transactionDate?: string;
  phoneNumber?: string;
  amount?: number;
} {
  const result = callbackData.Body.stkCallback;
  
  return {
    success: result.ResultCode === 0,
    resultCode: result.ResultCode,
    resultDesc: result.ResultDesc,
    mpesaReceiptNumber: result.CallbackMetadata?.Item?.find((i: any) => i.Name === 'MpesaReceiptNumber')?.Value,
    transactionDate: result.CallbackMetadata?.Item?.find((i: any) => i.Name === 'TransactionDate')?.Value,
    phoneNumber: result.CallbackMetadata?.Item?.find((i: any) => i.Name === 'PhoneNumber')?.Value,
    amount: result.CallbackMetadata?.Item?.find((i: any) => i.Name === 'Amount')?.Value
  };
}

// Configuration helper
export function updateDarajaConfig(config: Partial<typeof DARAJA_CONFIG>) {
  Object.assign(DARAJA_CONFIG, config);
}

export { DARAJA_CONFIG };
