/**
 * Get Linked Profiles - PRODUCTION (Phoenix Encanto)
 *
 * Railway-deployable endpoint for Retell AI
 * Returns all family members (minors and adult guests) linked to a caller's account
 *
 * PRODUCTION CREDENTIALS - DO NOT USE FOR TESTING
 * Location: Keep It Cut - Phoenix Encanto (201664)
 *
 * FAST SEARCH: Start from most recent clients (page 150+) where new linked profiles are
 * Only check clients without phone numbers (likely minors/dependents)
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

async function findClientByPhone(phone, locationId) {
  const authToken = await getToken();
  const normalizedPhone = phone.replace(/\D/g, '').slice(-10);

  const PAGES_PER_BATCH = 10;
  const ITEMS_PER_PAGE = 100;
  const MAX_BATCHES = 20;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const startPage = batch * PAGES_PER_BATCH + 1;
    const pagePromises = [];

    for (let i = 0; i < PAGES_PER_BATCH; i++) {
      const page = startPage + i;
      pagePromises.push(
        axios.get(
          `${CONFIG.API_URL}/clients?tenantid=${CONFIG.TENANT_ID}&locationid=${locationId}&PageNumber=${page}&ItemsPerPage=${ITEMS_PER_PAGE}`,
          { headers: { Authorization: `Bearer ${authToken}` }, timeout: 3000 }
        ).catch(() => ({ data: { data: [] } }))
      );
    }

    const results = await Promise.all(pagePromises);
    let emptyPages = 0;

    for (const result of results) {
      const clients = result.data?.data || [];
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
  const authToken = await getToken();
  try {
    const res = await axios.get(
      `${CONFIG.API_URL}/client/${clientId}?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}`,
      { headers: { Authorization: `Bearer ${authToken}` }, timeout: 3000 }
    );
    return res.data?.data || res.data;
  } catch (error) {
    return null;
  }
}

/**
 * FAST SEARCH: Find linked profiles
 * 1. Start from page 150 (most recent clients)
 * 2. Search backward and forward from there
 * 3. Stop early if we find results and have searched enough
 */
async function findLinkedProfiles(guardianId, locationId) {
  const linkedProfiles = [];
  const seenIds = new Set();
  const authToken = await getToken();

  console.log(`PRODUCTION: Finding linked profiles for guardian: ${guardianId}`);

  // Search in priority order: recent first, then older
  const PAGE_RANGES = [
    { start: 150, end: 200 },  // Most recent (page 150-200)
    { start: 100, end: 150 },  // Recent (page 100-150)
    { start: 50, end: 100 },   // Middle (page 50-100)
    { start: 1, end: 50 }      // Oldest (page 1-50)
  ];

  for (const range of PAGE_RANGES) {
    for (let batchStart = range.start; batchStart < range.end; batchStart += 10) {
      const pagePromises = [];

      for (let page = batchStart; page < batchStart + 10 && page <= range.end; page++) {
        pagePromises.push(
          axios.get(
            `${CONFIG.API_URL}/clients?tenantid=${CONFIG.TENANT_ID}&locationid=${locationId}&PageNumber=${page}&ItemsPerPage=100`,
            { headers: { Authorization: `Bearer ${authToken}` }, timeout: 3000 }
          ).catch(() => ({ data: { data: [] } }))
        );
      }

      const results = await Promise.all(pagePromises);
      let emptyPages = 0;
      const candidateClients = [];

      for (const result of results) {
        const clients = result.data?.data || [];
        if (clients.length === 0) {
          emptyPages++;
          continue;
        }

        for (const c of clients) {
          if (seenIds.has(c.clientId)) continue;
          // Only check clients WITHOUT a phone (likely minors/dependents)
          if (!c.primaryPhoneNumber) {
            candidateClients.push(c);
          }
        }
      }

      // Check candidates in parallel batches of 50
      for (let i = 0; i < candidateClients.length; i += 50) {
        const batch = candidateClients.slice(i, i + 50);
        const detailPromises = batch.map(c =>
          axios.get(
            `${CONFIG.API_URL}/client/${c.clientId}?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}`,
            { headers: { Authorization: `Bearer ${authToken}` }, timeout: 2000 }
          ).catch(() => null)
        );

        const detailResults = await Promise.all(detailPromises);

        for (const detailRes of detailResults) {
          if (!detailRes) continue;
          const client = detailRes.data?.data || detailRes.data;
          if (!client || seenIds.has(client.clientId)) continue;

          seenIds.add(client.clientId);

          if (client.guardianId === guardianId) {
            linkedProfiles.push({
              client_id: client.clientId,
              first_name: client.firstName,
              last_name: client.lastName,
              name: `${client.firstName} ${client.lastName}`,
              is_minor: client.isMinor || false,
              type: client.isMinor ? 'minor' : 'guest'
            });
            console.log(`PRODUCTION: Found linked profile: ${client.firstName} ${client.lastName}`);
          }
        }
      }

      // If all pages empty, we've reached the end of this range
      if (emptyPages >= 10) {
        break;
      }
    }

    // If we found linked profiles in recent pages, we can stop
    // (linked profiles are usually created recently)
    if (linkedProfiles.length > 0) {
      console.log(`PRODUCTION: Found profiles in range ${range.start}-${range.end}, stopping search`);
      break;
    }
  }

  console.log(`PRODUCTION: Found ${linkedProfiles.length} linked profiles total`);
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

    const linkedProfiles = await findLinkedProfiles(callerId, locationId);

    const canBookFor = [
      `${callerDetails.firstName} (yourself)`
    ];

    for (const profile of linkedProfiles) {
      const label = profile.is_minor ? 'child' : 'guest';
      canBookFor.push(`${profile.first_name} (${label})`);
    }

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
