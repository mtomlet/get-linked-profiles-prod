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

  const result = await callMeevoAPI(
    `/clients?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}`
  );

  if (result.success && result.data?.data) {
    return result.data.data.find(c => {
      const clientPhone = (c.primaryPhoneNumber || '').replace(/\D/g, '').slice(-10);
      return clientPhone === normalizedPhone;
    });
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

  // Try CDC endpoint for recent changes
  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 6);
    const startDateStr = startDate.toISOString();

    const cdcResult = await callMeevoAPI(
      `/cdc/entity/Client/changes?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}&StartDate=${startDateStr}&ItemsPerPage=200`
    );

    if (cdcResult.success && cdcResult.data?.data) {
      for (const record of cdcResult.data.data) {
        const client = record.Client_T;
        if (!client) continue;

        if (client.GuardianId === guardianId && !seenIds.has(client.EntityId)) {
          seenIds.add(client.EntityId);
          linkedProfiles.push({
            client_id: client.EntityId,
            first_name: client.FirstName,
            last_name: client.LastName,
            name: `${client.FirstName} ${client.LastName}`,
            is_minor: client.IsMinor || false,
            type: client.IsMinor ? 'minor' : 'guest'
          });
        }
      }
    }
  } catch (e) {
    console.log(`PRODUCTION: CDC error: ${e.message}`);
  }

  // Check /clients list for same last name
  let pageNumber = 1;
  const maxPages = 10;

  while (pageNumber <= maxPages) {
    const clientsResult = await callMeevoAPI(
      `/clients?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}&ItemsPerPage=200&PageNumber=${pageNumber}`
    );

    if (!clientsResult.success || !clientsResult.data?.data || clientsResult.data.data.length === 0) {
      break;
    }

    const clients = clientsResult.data.data;
    const potentials = clients.filter(c =>
      c.clientId !== guardianId &&
      !seenIds.has(c.clientId) &&
      c.lastName?.toLowerCase() === guardianLastName?.toLowerCase()
    );

    for (const potential of potentials) {
      try {
        const detail = await getClientDetails(potential.clientId, locationId);

        if (detail?.guardianId === guardianId) {
          seenIds.add(potential.clientId);
          linkedProfiles.push({
            client_id: potential.clientId,
            first_name: potential.firstName,
            last_name: potential.lastName,
            name: `${potential.firstName} ${potential.lastName}`,
            is_minor: detail.isMinor || false,
            type: detail.isMinor ? 'minor' : 'guest'
          });
        }
      } catch (e) {
        // Skip on error
      }
    }

    if (clients.length < 200) break;
    pageNumber++;
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
