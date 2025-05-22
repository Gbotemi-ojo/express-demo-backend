// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors'); // Import the cors middleware

const app = express();
const port = process.env.PORT || 3000; // Using port 3000 for the combined server

// Paystack API details - Now loaded from environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY; // Get your secret key from environment variables
const PAYSTACK_API_URL = 'https://api.paystack.co';

// Middleware setup
app.use(cors()); // Enable CORS for all routes
app.use(bodyParser.json()); // Parse JSON request bodies
app.use(bodyParser.urlencoded({ extended: true })); // Parse URL-encoded request bodies

// --- Pharmacy Branch Logic ---

// Haversine formula to compute great-circle distance (in km)
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = deg => deg * Math.PI / 180;
  const R = 6371; // Earth radius in km

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Geocode an address using Nominatim via axios
async function geocode(address) {
  const params = {
    q: address,
    format: 'json',
    limit: 1
  };
  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params,
      headers: { 'User-Agent': 'MyPharmacyApp/1.0 (contact@yourdomain.com)' } // Important: Provide a valid User-Agent
    });
    const data = response.data;
    console.log("Geocoding response data:", data);
    if (!data || data.length === 0) {
      throw new Error('Address not found or could not be geocoded.');
    }
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  } catch (error) {
    console.error("Geocoding error:", error.response ? error.response.data : error.message);
    throw new Error(`Geocoding failed: ${error.response ? (error.response.data.error || 'Server error') : error.message}`);
  }
}

// Pharmacy branches in Lagos State
const branches = [
  { id: 1, name: 'Ikeja Pharmacy', lat: 6.6020, lon: 3.3515 },
  { id: 2, name: 'Victoria Island Pharmacy', lat: 6.4281, lon: 3.4216 },
  { id: 3, name: 'Lekki Pharmacy', lat: 6.4654, lon: 3.4765 },
  { id: 4, name: 'Surulere Pharmacy', lat: 6.5097, lon: 3.3619 }
];

// Find nearest branch
function findNearestBranch(userCoords) {
  return branches.reduce((nearest, branch) => {
    const distance = haversine(
      userCoords.lat, userCoords.lon,
      branch.lat, branch.lon
    );
    return distance < nearest.distance
      ? { branch, distance }
      : nearest;
  }, { branch: null, distance: Infinity });
}

// POST /assign-branch endpoint
app.post('/assign-branch', async (req, res) => {
  const { address } = req.body;
  if (!address) {
    return res.status(400).json({ error: 'Address is required' });
  }

  try {
    const userCoords = await geocode(address);
    const { branch, distance } = findNearestBranch(userCoords);
    res.json({
      nearestBranch: branch,
      distanceKm: parseFloat(distance.toFixed(2))
    });
  } catch (err) {
    console.error("Error in /assign-branch:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /branches (list all branches) endpoint
app.get('/branches', (req, res) => {
  res.json(branches);
});

// --- Paystack Payment Logic ---

// Route to initiate a payment
app.post('/initiate-payment', async (req, res) => {
  console.log('Received initiate-payment request');
  const { email, amount, currency, frontendCallbackOrigin } = req.body;

  // Basic validation
  if (!email || !amount || !currency || !frontendCallbackOrigin) {
    return res.status(400).json({ error: 'Missing required fields: email, amount, currency, or frontendCallbackOrigin' });
  }

  try {
    // Prepare data for Paystack initialization
    const data = {
      email: email,
      amount: amount * 100, // Amount in kobo (or the smallest currency unit)
      currency: currency,
      // Construct the callback_url using the frontend's origin
      callback_url: `${frontendCallbackOrigin}/paystack-callback`
    };
    console.log('Initiating Paystack transaction with data:', data);

    // Make a POST request to Paystack initialization endpoint
    const response = await axios.post(`${PAYSTACK_API_URL}/transaction/initialize`, data, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Paystack initialization response:', response.data);
    // Send the Paystack response back to the client
    res.status(200).json(response.data);

  } catch (error) {
    console.error('Error initiating payment:', error.response ? error.response.data : error.message);
    res.status(500).json({
      error: 'Failed to initiate payment',
      details: error.response ? error.response.data : error.message
    });
  }
});

// Route to handle Paystack callback (webhook) - This is for server-to-server communication
app.post('/paystack-callback', async (req, res) => {
  console.log('Received Paystack callback (webhook)');
  const { reference } = req.body.data;

  if (!reference) {
    return res.status(400).json({ error: 'No transaction reference provided in callback' });
  }

  try {
    const verificationResponse = await axios.get(`${PAYSTACK_API_URL}/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
      }
    });

    const transactionData = verificationResponse.data.data;

    if (transactionData.status === 'success') {
      console.log('Payment successful via webhook:', transactionData);
      // This is where you would definitively update your database and fulfill the order
      res.status(200).json({ message: 'Callback received and transaction verified successfully' });
    } else {
      console.log('Payment not successful via webhook:', transactionData);
      res.status(200).json({ message: 'Callback received, but transaction not successful' });
    }

  } catch (error) {
    console.error('Error verifying transaction via webhook:', error.response ? error.response.data : error.message);
    res.status(500).json({
      error: 'Failed to verify transaction via webhook',
      details: error.response ? error.response.data : error.message
    });
  }
});

// Route to verify a payment (called by your frontend after Paystack redirect)
app.post('/verify-payment', async (req, res) => {
  const { reference } = req.body;

  if (!reference) {
    return res.status(400).json({ error: 'Transaction reference is required.' });
  }

  try {
    const verificationResponse = await axios.get(`${PAYSTACK_API_URL}/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
      }
    });

    const transactionData = verificationResponse.data.data;

    if (transactionData.status === 'success') {
      console.log('Frontend requested verification: Payment successful for reference:', reference);
      res.status(200).json({ status: 'success', message: 'Payment verified successfully.', data: transactionData });
    } else {
      console.log('Frontend requested verification: Payment not successful for reference:', reference, 'Status:', transactionData.status);
      res.status(200).json({ status: transactionData.status, message: 'Payment not successful.', data: transactionData });
    }

  } catch (error) {
    console.error('Error verifying transaction from frontend:', error.response ? error.response.data : error.message);
    res.status(500).json({
      error: 'Failed to verify transaction on the server.',
      details: error.response ? error.response.data : error.message
    });
  }
});


// Basic root route
app.get('/', (req, res) => {
  res.send('Combined Express Server is running.');
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Paystack callback URL (for frontend redirect): http://localhost:${port}/paystack-callback`);
  console.log(`Nearest branch API available at http://localhost:${port}/assign-branch`);
});