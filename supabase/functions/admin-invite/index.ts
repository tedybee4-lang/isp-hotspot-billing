// =============================================================================
//  Admin Invite — Supabase Edge Function (Deno)
// =============================================================================
//  Super admin creates an ISP owner / admin / agent account. Uses the service
//  role because auth.users rows cannot be created from SQL.
//
//  Deploy:  supabase functions deploy admin-invite --no-verify-jwt
//  Invoke:  POST {SUPABASE_URL}/functions/v1/admin-invite
//           { "email", "password", "fullName", "ispId", "role" }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

    // ── Only a super admin may call this ─────────────────────────────────────
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
    if (!token) return json({ error: 'Missing bearer token' }, 401)

    const { data: userData, error: userErr } = await admin.auth.getUser(token)
    if (userErr || !userData.user) return json({ error: 'Invalid session' }, 401)

    const { data: caller } = await admin
      .from('profiles')
      .select('role')
      .eq('id', userData.user.id)
      .single()

    if (caller?.role !== 'super_admin') {
      return json({ error: 'Super admin privileges required' }, 403)
    }

    // ── Validate ─────────────────────────────────────────────────────────────
    const { email, password, fullName, ispId, role } = await req.json()
    if (!email || !password || !ispId) {
      return json({ error: 'email, password and ispId are required' }, 400)
    }
    if (String(password).length < 8) {
      return json({ error: 'Password must be at least 8 characters' }, 400)
    }
    const targetRole = role ?? 'isp_agent'
    if (!['isp_owner', 'isp_admin', 'isp_agent'].includes(targetRole)) {
      return json({ error: 'Invalid staff role' }, 400)
    }

    const { data: isp } = await admin.from('isps').select('id, name').eq('id', ispId).single()
    if (!isp) return json({ error: 'ISP not found' }, 404)

    // ── Create (or reuse) the auth user ──────────────────────────────────────
    let userId: string
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: String(email).toLowerCase(),
      password: String(password),
      email_confirm: true,
      user_metadata: { full_name: fullName ?? String(email).split('@')[0] },
    })

    if (createErr) {
      // Already exists → look it up so the super admin can re-assign a tenant
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const existing = list?.users?.find(
        (u) => u.email?.toLowerCase() === String(email).toLowerCase(),
      )
      if (!existing) return json({ error: createErr.message }, 400)
      userId = existing.id
      await admin.auth.admin.updateUserById(userId, { password: String(password) })
    } else {
      userId = created!.user.id
    }

    // ── Attach tenant + role ─────────────────────────────────────────────────
    const { error: profileErr } = await admin
      .from('profiles')
      .update({ isp_id: ispId, role: targetRole })
      .eq('id', userId)

    if (profileErr) return json({ error: profileErr.message }, 500)

    await admin.from('audit_logs').insert({
      actor_id: userData.user.id,
      actor_email: userData.user.email,
      actor_role: 'super_admin',
      isp_id: ispId,
      isp_name: isp.name,
      action: 'staff:invited',
      target_type: 'profile',
      target_id: userId,
      metadata: { email, role: targetRole },
    })

    return json({ success: true, userId, ispId, role: targetRole })
  } catch (err) {
    console.error('admin-invite error:', err)
    return json({ error: (err as Error).message ?? 'Unexpected server error' }, 500)
  }
})