/**
 * Get Linked Profiles - PRODUCTION (Phoenix Encanto)
 *
 * Railway-deployable endpoint for Retell AI
 * Returns all family members (minors and adult guests) linked to a caller's account
 *
 * PRODUCTION CREDENTIALS - DO NOT USE FOR TESTING
 * Location: Keep It Cut - Phoenix Encanto (201664)
 */

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// PRODUCTION Meevo API Configuration
const CONFIG = {
  AUTH_URL: 'https://marketplace.meevo.com/oauth2/token',
  API_URL: 'https://na1pub.meevo.com/publicapi/v1',
  CLIENT_ID: 'f6a5046d-208e-4829-9941-034ebdd2aa65',
  CLIENT_SECRET: '2f8feb2e-51f5-40a3-83af-3d4a6a454abe',
  TENANT_ID: '200507',
  LOCATION_ID: '201664'  // Phoenix Encanto
};

let token = null;
let tokenExpiry = null;

async function getToken() {
  if (token && tokenExpiry && Date.now() < tokenExpiry - 300000) return token;

  const res = await axios.post(CONFIG.AUTH_URL, {
    client_id: CONFIG.CLIENT_ID,
    client_secret: CONFIG.CLIENT_SECRET
  });

  token = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in * 1000);
  return token;
}

async function callMeevoAPI(endpoint, method = 'GET', data = null) {
  const authToken = await getToken();

  try {
    const config = {
      method,
      url: `${CONFIG.API_URL}${endpoint}`,
      headers: { Authorization: `Bearer ${authToken}` }
    };
    if (data && method !== 'GET') config.data = data;
    return { success: true, data: (await axios(config)).data };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message
    };
  }
}

async function findClientByPhone(phone, locationId) {
  const normalizedPhone = phone.replace(/\D/g, '').slice(-10);

  // Parallel pagination search
  const PAGES_PER_BATCH = 10;
  const ITEMS_PER_PAGE = 100;
  const MAX_BATCHES = 20;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const startPage = batch * PAGES_PER_BATCH + 1;
    const pagePromises = [];

    for (let i = 0; i < PAGES_PER_BATCH; i++) {
      const page = startPage + i;
      pagePromises.push(
        callMeevoAPI(`/clients?tenantid=${CONFIG.TENANT_ID}&locationid=${locationId}&PageNumber=${page}&ItemsPerPage=${ITEMS_PER_PAGE}`)
          .catch(() => ({ success: false, data: { data: [] } }))
      );
    }

    const results = await Promise.all(pagePromises);
    let emptyPages = 0;

    for (const result of results) {
      const clients = result.success ? (result.data?.data || []) : [];
      if (clients.length === 0) emptyPages++;

      for (const c of clients) {
        const clientPhone = (c.primaryPhoneNumber || '').replace(/\D/g, '').slice(-10);
        if (clientPhone === normalizedPhone) {
          return c;
        }
      }
    }

    if (emptyPages === PAGES_PER_BATCH) break;
  }
  return null;
}

async function getClientDetails(clientId, locationId) {
  const result = await callMeevoAPI(
    `/client/${clientId}?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}`
  );
  return result.success ? (result.data?.data || result.data) : null;
}

async function findLinkedProfiles(guardianId, guardianLastName, locationId) {
  const linkedProfiles = [];
  const seenIds = new Set();

  console.log(`PRODUCTION: Finding linked profiles for guardian: ${guardianId}`);

  // Search ALL clients with pagination and check guardianId for each
  // This is more thorough than just checking same last name
  const PAGES_PER_BATCH = 10;
  const ITEMS_PER_PAGE = 100;
  const MAX_BATCHES = 10;  // Search up to 10,000 clients

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const startPage = batch * PAGES_PER_BATCH + 1;
    const pagePromises = [];

    for (let i = 0; i < PAGES_PER_BATCH; i++) {
      const page = startPage + i;
      pagePromises.push(
        callMeevoAPI(`/clients?tenantid=${CONFIG.TENANT_ID}&locationid=${locationId}&PageNumber=${page}&ItemsPerPage=${ITEMS_PER_PAGE}`)
          .catch(() => ({ success: false, data: { data: [] } }))
      );
    }

    const results = await Promise.all(pagePromises);
    let emptyPages = 0;

    // Collect all potential linked profiles (minors or same last name)
    const potentials = [];
    for (const result of results) {
      const clients = result.success ? (result.data?.data || []) : [];
      if (clients.length === 0) emptyPages++;

      for (const c of clients) {
        if (c.clientId !== guardianId && !seenIds.has(c.clientId)) {
          // Check minors or same last name as potential linked profiles
          potentials.push(c);
        }
      }
    }

    // Check each potential's guardianId (in parallel batches of 10)
    for (let i = 0; i < potentials.length; i += 10) {
      const batch = potentials.slice(i, i + 10);
      const detailPromises = batch.map(c =>
        getClientDetails(c.clientId, locationId).catch(() => null)
      );
      const details = await Promise.all(detailPromises);

      for (let j = 0; j < batch.length; j++) {
        const c = batch[j];
        const detail = details[j];
        if (detail?.guardianId === guardianId) {
          seenIds.add(c.clientId);
          linkedProfiles.push({
            client_id: c.clientId,
            first_name: c.firstName,
            last_name: c.lastName,
            name: `${c.firstName} ${c.lastName}`,
            is_minor: detail.isMinor || false,
            type: detail.isMinor ? 'minor' : 'guest'
          });
        }
      }
    }

    if (emptyPages === PAGES_PER_BATCH) break;
  }

  return linkedProfiles;
}

app.post('/get', async (req, res) => {
  console.log('PRODUCTION: get_linked_profiles request:', JSON.stringify(req.body));

  try {
    const { phone, client_id, location_id } = req.body;
    const locationId = location_id || CONFIG.LOCATION_ID;

    if (!phone && !client_id) {
      return res.json({
        success: false,
        error: 'Missing phone or client_id'
      });
    }

    let callerClient = null;
    let callerId = client_id;

    if (phone && !callerId) {
      callerClient = await findClientByPhone(phone, locationId);
      if (!callerClient) {
        return res.json({
          success: true,
          found: false,
          caller: null,
          linked_profiles: [],
          can_book_for: [],
          total_linked: 0,
          message: 'No account found for this phone number'
        });
      }
      callerId = callerClient.clientId;
    }

    const callerDetails = await getClientDetails(callerId, locationId);
    if (!callerDetails) {
      return res.json({
        success: false,
        error: 'Could not retrieve caller details'
      });
    }

    const linkedProfiles = await findLinkedProfiles(
      callerId,
      callerDetails.lastName,
      locationId
    );

    const canBookFor = [
      `${callerDetails.firstName} (yourself)`
    ];

    for (const profile of linkedProfiles) {
      const label = profile.is_minor ? 'child' : 'guest';
      canBookFor.push(`${profile.first_name} (${label})`);
    }

    console.log(`PRODUCTION: Found ${linkedProfiles.length} linked profiles for ${callerDetails.firstName}`);

    res.json({
      success: true,
      found: true,
      caller: {
        client_id: callerId,
        first_name: callerDetails.firstName,
        last_name: callerDetails.lastName,
        name: `${callerDetails.firstName} ${callerDetails.lastName}`,
        phone: callerDetails.phoneNumbers?.[0]?.number || callerClient?.primaryPhoneNumber,
        email: callerDetails.emailAddress
      },
      linked_profiles: linkedProfiles,
      minors: linkedProfiles.filter(p => p.is_minor),
      guests: linkedProfiles.filter(p => !p.is_minor),
      can_book_for: canBookFor,
      total_linked: linkedProfiles.length,
      message: linkedProfiles.length > 0
        ? `Found ${linkedProfiles.length} linked profile(s): ${linkedProfiles.map(p => p.first_name).join(', ')}`
        : 'No linked profiles found'
    });

  } catch (error) {
    console.error('PRODUCTION Error:', error.message);
    res.json({
      success: false,
      error: error.message
    });
  }
});

app.post('/lookup', async (req, res) => {
  req.url = '/get';
  app._router.handle(req, res);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: 'PRODUCTION',
    location: 'Phoenix Encanto',
    service: 'get-linked-profiles'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PRODUCTION get-linked-profiles service running on port ${PORT}`);
});
