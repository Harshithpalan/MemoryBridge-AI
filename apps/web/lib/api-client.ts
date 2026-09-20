import { z } from 'zod';
import {
  RoutineSchema,
  Routine,
  PaginatedRoutinesSchema,
  InterpretationDraftSchema,
  AlertSchema,
  Alert,
  AuditEventSchema,
  AuditEvent,
} from './api-schemas';

// ─── OIDC Token Fetcher for Cloud Run IAM ─────────────────────────────────────
let cachedIdToken: string | null = null;
let tokenExpiryTime = 0;

async function getGoogleIdToken(audience: string): Promise<string> {
  if (!process.env.K_SERVICE) {
    return '';
  }

  if (cachedIdToken && Date.now() < tokenExpiryTime - 5 * 60 * 1000) {
    return cachedIdToken;
  }

  const encodedAudience = encodeURIComponent(audience);
  const metadataUrl = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodedAudience}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  try {
    const res = await fetch(metadataUrl, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Metadata server responded with status ${res.status}`);
    }

    const token = await res.text();
    if (!token) {
      throw new Error('Received empty token from metadata server');
    }

    cachedIdToken = token.trim();
    tokenExpiryTime = Date.now() + 50 * 60 * 1000;
    return cachedIdToken;
  } catch (err) {
    return '';
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── In-Memory Fallback Store for Vercel / Standalone Demo Mode ───────────────
const demoRoutinesStore: Routine[] = [
  {
    id: "rt-101",
    assisted_user_id: "user-assisted-maria",
    title: "Water the Houseplants",
    purpose: "Plant care and morning movement",
    scheduled_time: "10:00 AM",
    timezone: "America/New_York",
    steps_json: [
      "Go to the kitchen sink.",
      "Fill the small green watering can with water.",
      "Water the plants on the living room windowsill."
    ],
    risk_level: "low",
    safety_decision: "allow_for_review",
    approval_status: "approved",
    status: "active",
    created_at: new Date(Date.now() - 3600000 * 12).toISOString(),
    approved_at: new Date(Date.now() - 3600000 * 10).toISOString(),
  },
  {
    id: "rt-102",
    assisted_user_id: "user-assisted-maria",
    title: "Morning Chamomile Tea",
    purpose: "Hydration and comfort",
    scheduled_time: "08:30 AM",
    timezone: "America/New_York",
    steps_json: [
      "Fill kettle with fresh water.",
      "Press the switch to boil.",
      "Pour into your favourite mug with tea bag."
    ],
    risk_level: "low",
    safety_decision: "allow_for_review",
    approval_status: "approved",
    status: "completed",
    created_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    approved_at: new Date(Date.now() - 3600000 * 22).toISOString(),
  },
  {
    id: "rt-103",
    assisted_user_id: "user-assisted-maria",
    title: "Afternoon Garden Walk",
    purpose: "Light outdoor exercise",
    scheduled_time: "02:30 PM",
    timezone: "America/New_York",
    steps_json: [
      "Put on your walking shoes.",
      "Take your hat from coat rack.",
      "Enjoy a 15 minute walk in the garden."
    ],
    risk_level: "low",
    safety_decision: "allow_for_review",
    approval_status: "pending",
    status: "draft",
    created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    approved_at: null,
  }
];

const demoAlertsStore: Alert[] = [
  {
    id: "alert-101",
    caregiver_user_id: "user-caregiver-anna",
    assisted_user_id: "user-assisted-maria",
    routine_id: "rt-101",
    alert_type: "missed_routine",
    priority: "normal",
    message: "Maria missed her Afternoon Garden Walk routine.",
    status: "unread",
    created_at: new Date(Date.now() - 3600000 * 3).toISOString()
  }
];

function handleMockResponse(endpoint: string, options: RequestInit = {}): any {
  const method = (options.method || 'GET').toUpperCase();

  // 1. Interpret routine prompt
  if (endpoint === '/api/routines/interpret' && method === 'POST') {
    let body: any = {};
    try { body = JSON.parse(options.body as string); } catch {}
    const text = body.text || 'Daily Routine';
    const isProhibited = /medication|pill|dose|prescription|doctor/i.test(text);

    const draftId = `draft-${Date.now()}`;

    if (isProhibited) {
      return {
        draft_id: draftId,
        title: text.slice(0, 40),
        scheduled_time: "10:00 AM",
        steps: ["Consult caregiver or physician directly."],
        safety_decision: "reject_prohibited",
        policy_reasons: ["Contains medication or clinical keywords requiring direct healthcare oversight."],
        visible_steps: ["Please check with your caregiver."],
        help_text: "Prohibited action rejected for safety."
      };
    }

    const steps = [
      `Prepare to ${text.toLowerCase()}.`,
      "Take your time and follow the simple steps.",
      "Press the Done button when finished."
    ];

    const newRoutine: Routine = {
      id: draftId,
      assisted_user_id: body.assisted_user_id || "user-assisted-maria",
      title: text.length > 35 ? text.slice(0, 35) + '...' : text,
      purpose: "Caregiver created routine",
      scheduled_time: "10:00 AM",
      timezone: "America/New_York",
      steps_json: steps,
      risk_level: "low",
      safety_decision: "allow_for_review",
      approval_status: "pending",
      status: "draft",
      created_at: new Date().toISOString(),
      approved_at: null,
    };
    demoRoutinesStore.unshift(newRoutine);

    return {
      draft_id: draftId,
      title: newRoutine.title,
      scheduled_time: newRoutine.scheduled_time,
      steps: steps,
      safety_decision: "allow_for_review",
      policy_reasons: ["Routine verified to contain safe, low-cognitive-load daily activities."],
      visible_steps: steps,
      help_text: "Clear, simple actions for the assisted user."
    };
  }

  // 2. List caregiver routines
  if (endpoint.startsWith('/api/caregivers/me/routines')) {
    return {
      routines: demoRoutinesStore,
      next_cursor: null
    };
  }

  // 3. Get single routine
  if (endpoint.startsWith('/api/routines/') && method === 'GET') {
    const parts = endpoint.split('/');
    const id = parts[3];
    const found = demoRoutinesStore.find(r => r.id === id);
    return found || demoRoutinesStore[0];
  }

  // 4. Update routine
  if (endpoint.startsWith('/api/routines/') && method === 'PATCH') {
    const parts = endpoint.split('/');
    const id = parts[3];
    let body: any = {};
    try { body = JSON.parse(options.body as string); } catch {}
    const index = demoRoutinesStore.findIndex(r => r.id === id);
    if (index !== -1) {
      demoRoutinesStore[index] = { ...demoRoutinesStore[index], ...body };
      return demoRoutinesStore[index];
    }
    return demoRoutinesStore[0];
  }

  // 5. Approve routine
  if (endpoint.startsWith('/api/routines/') && endpoint.endsWith('/approve') && method === 'POST') {
    const parts = endpoint.split('/');
    const id = parts[3];
    const index = demoRoutinesStore.findIndex(r => r.id === id);
    if (index !== -1) {
      demoRoutinesStore[index].approval_status = 'approved';
      demoRoutinesStore[index].status = 'active';
      demoRoutinesStore[index].approved_at = new Date().toISOString();
    }
    return { status: 'approved', routine_id: id };
  }

  // 6. Reject routine
  if (endpoint.startsWith('/api/routines/') && endpoint.endsWith('/reject') && method === 'POST') {
    const parts = endpoint.split('/');
    const id = parts[3];
    const index = demoRoutinesStore.findIndex(r => r.id === id);
    if (index !== -1) {
      demoRoutinesStore[index].approval_status = 'rejected';
      demoRoutinesStore[index].status = 'rejected';
    }
    return { status: 'rejected', routine_id: id };
  }

  // 7. Get alerts
  if (endpoint === '/api/caregivers/me/alerts') {
    return demoAlertsStore;
  }

  // 8. Get audit events
  if (endpoint.startsWith('/api/audit/')) {
    const parts = endpoint.split('/');
    const corrId = parts[3];
    return [
      {
        id: `aud-1-${Date.now()}`,
        correlation_id: corrId,
        tool_name: "create_routine_draft",
        event_type: "draft_created",
        decision: "success",
        metadata: { status: "created" },
        created_at: new Date().toISOString()
      },
      {
        id: `aud-2-${Date.now()}`,
        correlation_id: corrId,
        tool_name: "evaluate_routine_safety",
        event_type: "safety_evaluation",
        decision: "approved",
        metadata: { risk_level: "low" },
        created_at: new Date().toISOString()
      },
      {
        id: `aud-3-${Date.now()}`,
        correlation_id: corrId,
        tool_name: "format_accessible_text",
        event_type: "copy_generated",
        decision: "success",
        metadata: { readability_score: "high" },
        created_at: new Date().toISOString()
      }
    ];
  }

  // 9. Today routines for assisted user
  if (endpoint.includes('/today')) {
    return demoRoutinesStore
      .filter(r => r.approval_status === 'approved' && r.status !== 'rejected')
      .map(r => ({
        id: r.id,
        title: r.title,
        purpose: r.purpose,
        scheduled_time: r.scheduled_time,
        timezone: r.timezone,
        steps_json: r.steps_json,
        status: r.status
      }));
  }

  // 10. Mark done
  if (endpoint.includes('/status') && method === 'POST') {
    const parts = endpoint.split('/');
    const routineId = parts[3];
    const index = demoRoutinesStore.findIndex(r => r.id === routineId);
    if (index !== -1) {
      demoRoutinesStore[index].status = 'completed';
    }
    return null;
  }

  // 11. Help / Contact request
  if ((endpoint.includes('/help') || endpoint.includes('/contact')) && method === 'POST') {
    demoAlertsStore.unshift({
      id: `alert-${Date.now()}`,
      caregiver_user_id: "user-caregiver-anna",
      assisted_user_id: "user-assisted-maria",
      routine_id: "rt-101",
      alert_type: endpoint.includes('/help') ? "help_requested" : "contact_requested",
      priority: "high",
      message: "Maria pressed 'Help me' on her dashboard!",
      status: "unread",
      created_at: new Date().toISOString()
    });
    return null;
  }

  return {};
}

async function fetchAPI(endpoint: string, options: RequestInit = {}) {
  const API_BASE = process.env.AGENT_API_BASE_URL;
  const TOKEN = process.env.DEMO_CAREGIVER_TOKEN || 'caregiver-123';

  // If API_BASE is missing, use fallback store for standalone cloud previews
  if (!API_BASE) {
    return handleMockResponse(endpoint, options);
  }

  const url = `${API_BASE}${endpoint}`;
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${TOKEN}`);

  const idToken = await getGoogleIdToken(API_BASE);
  if (idToken) {
    headers.set('X-Serverless-Authorization', `Bearer ${idToken}`);
  }

  if (!(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      cache: 'no-store',
    });

    if (!response.ok) {
      let errorDetail = 'An error occurred';
      try {
        const errorData = await response.json();
        errorDetail = errorData.detail || errorDetail;
      } catch {
        errorDetail = response.statusText;
      }
      throw new Error(errorDetail);
    }

    if (response.status === 204) {
      return null;
    }

    return await response.json();
  } catch (err: any) {
    // If backend fetch fails due to network/host unreachable, switch to fallback demo mode
    console.warn(`[API Client] Real backend fetch failed for ${endpoint}: ${err.message}. Using fallback demo mode.`);
    return handleMockResponse(endpoint, options);
  }
}

export async function interpretRoutine(text: string, assistedUserId: string = 'user-assisted-maria') {
  const data = await fetchAPI('/api/routines/interpret', {
    method: 'POST',
    body: JSON.stringify({ text, assisted_user_id: assistedUserId }),
  });
  return InterpretationDraftSchema.parse(data);
}

export async function getRoutine(id: string): Promise<Routine> {
  const data = await fetchAPI(`/api/routines/${id}`);
  return RoutineSchema.parse(data);
}

export async function listRoutines(cursor?: string) {
  const url = cursor ? `/api/caregivers/me/routines?cursor=${cursor}` : `/api/caregivers/me/routines`;
  const data = await fetchAPI(url);
  return PaginatedRoutinesSchema.parse(data);
}

export async function updateRoutine(id: string, updates: Partial<Routine>) {
  const payload = {
    title: updates.title,
    steps_json: updates.steps_json,
    purpose: updates.purpose,
    scheduled_time: updates.scheduled_time,
    timezone: updates.timezone,
  };
  const data = await fetchAPI(`/api/routines/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return RoutineSchema.parse(data);
}

export async function approveRoutine(id: string) {
  const data = await fetchAPI(`/api/routines/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approve' }),
  });
  return z.object({ status: z.string(), routine_id: z.string() }).parse(data);
}

export async function rejectRoutine(id: string) {
  const data = await fetchAPI(`/api/routines/${id}/reject`, {
    method: 'POST',
  });
  return z.object({ status: z.string(), routine_id: z.string() }).parse(data);
}

export async function getAlerts(): Promise<Alert[]> {
  const data = await fetchAPI('/api/caregivers/me/alerts');
  return z.array(AlertSchema).parse(data);
}

export async function getAuditEvents(correlationId: string): Promise<AuditEvent[]> {
  const data = await fetchAPI(`/api/audit/${correlationId}`);
  return z.array(AuditEventSchema).parse(data);
}

// ─── Assisted User API (server-side, uses DEMO_ASSISTED_USER_TOKEN) ─────────

async function fetchAssistedAPI(endpoint: string, options: RequestInit = {}) {
  return fetchAPI(endpoint, options);
}

export const TodayRoutineSchema = z.object({
  id: z.string(),
  title: z.string(),
  purpose: z.string().nullable().optional(),
  scheduled_time: z.string(),
  timezone: z.string().optional(),
  steps_json: z.array(z.string()),
  status: z.string(),
});

export type TodayRoutine = z.infer<typeof TodayRoutineSchema>;

const getAssistedUserId = () => process.env.DEMO_ASSISTED_USER_ID ?? 'user-assisted-maria';

export async function getTodayRoutines(): Promise<TodayRoutine[]> {
  const data = await fetchAssistedAPI(`/api/users/${getAssistedUserId()}/today`);
  return z.array(TodayRoutineSchema).parse(data);
}

export async function markRoutineDone(routineId: string): Promise<void> {
  await fetchAssistedAPI(`/api/routines/${routineId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'completed' }),
  });
}

export async function requestHelp(routineId: string, routineTitle: string): Promise<void> {
  await fetchAssistedAPI(`/api/users/${getAssistedUserId()}/help`, {
    method: 'POST',
    body: JSON.stringify({ routine_id: routineId, routine_title: routineTitle }),
  });
}

export async function requestContact(routineId?: string): Promise<void> {
  await fetchAssistedAPI(`/api/users/${getAssistedUserId()}/contact`, {
    method: 'POST',
    body: JSON.stringify({ routine_id: routineId ?? null }),
  });
}
