import express from 'express';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireOrgMember, requireOrgAdmin } from '../auth.js';
import { generateKey, logKeyEvent } from '../apiKeys.js';

/**
 * Managing API keys, from inside the organization console.
 *
 * Admins only. A regular member cannot mint a credential that reads documents
 * from outside the interface, because the whole permission model rests on who
 * is asking and a key answers that question differently.
 */
const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireOrgMember, requireOrgAdmin);

/** Never send a hash to the browser — nothing there needs it. */
const SAFE = 'id, name, key_prefix, folder_ids, created_at, last_used_at, expires_at, revoked_at';

/** GET /orgs/:orgId/api-keys */
router.get('/', async (req, res) => {
  try {
    // Both figures come from the database, using the same month boundary.
    // Counting the per-key rows in JavaScript meant the boundary came from this
    // host's local clock while the total came from Postgres, so on any non-UTC
    // host the column and the total beside it silently disagreed.
    const [{ data: keys, error }, { data: used }, { data: byKey }] = await Promise.all([
      supabase.from('api_keys').select(SAFE).eq('organization_id', req.org.id).order('created_at', { ascending: false }),
      supabase.rpc('api_calls_this_month', { p_org_id: req.org.id }),
      supabase.rpc('api_calls_by_key_this_month', { p_org_id: req.org.id }),
    ]);
    if (error) throw error;

    const perKey = {};
    for (const r of byKey || []) perKey[r.api_key_id] = Number(r.calls || 0);

    res.json({
      keys: (keys || []).map((k) => ({ ...k, calls_this_month: perKey[k.id] || 0 })),
      api_enabled: !!req.org.plan?.api_enabled,
      calls_this_month: Number(used || 0),
      calls_included: Number(req.org.plan?.max_api_calls_per_month || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /orgs/:orgId/api-keys { name, folder_ids?, expires_in_days? }
 *
 * The one and only time the key itself is returned. After this response it
 * exists nowhere we can read it.
 */
router.post('/', async (req, res) => {
  try {
    if (!req.org.plan?.api_enabled) {
      return res.status(403).json({ error: `The ${req.org.plan?.name || 'current'} plan does not include API access.` });
    }

    const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Give the key a name, so you can tell it apart later.' });

    // Ten is not a technical limit; it is the point past which a list of keys
    // stops being something anybody audits.
    const { count } = await supabase
      .from('api_keys').select('id', { count: 'exact', head: true })
      .eq('organization_id', req.org.id).is('revoked_at', null);
    if ((count || 0) >= 10) {
      return res.status(400).json({ error: 'You already have 10 active keys. Revoke one before creating another.' });
    }

    // Folder ids are checked against THIS organization's folders. Without that,
    // an admin could name a folder id belonging to somebody else and the key
    // would carry it — harmless today because the search also filters by
    // organization, but it would be one refactor away from not being harmless.
    let folderIds = null;
    const requested = Array.isArray(req.body?.folder_ids) ? req.body.folder_ids.filter(Boolean).map(String) : [];
    if (requested.length) {
      const { data: owned } = await supabase
        .from('folders').select('id').eq('organization_id', req.org.id).in('id', requested);
      const ownedIds = (owned || []).map((f) => String(f.id));
      if (ownedIds.length !== requested.length) {
        return res.status(400).json({ error: 'One of the folders does not belong to this organization.' });
      }
      folderIds = ownedIds;
    }

    let expiresAt = null;
    const days = parseInt(req.body?.expires_in_days, 10);
    if (Number.isFinite(days) && days > 0) {
      expiresAt = new Date(Date.now() + Math.min(days, 3650) * 86400000).toISOString();
    }

    const { key, hash, prefix } = generateKey();
    const { data, error } = await supabase
      .from('api_keys')
      .insert({
        organization_id: req.org.id,
        name,
        key_hash: hash,
        key_prefix: prefix,
        folder_ids: folderIds,
        expires_at: expiresAt,
        created_by: req.user.id,
      })
      .select(SAFE)
      .single();
    if (error) throw error;

    await logKeyEvent(req.org.id, req.user.id, `Created API key "${name}" (${prefix}…)`, { key_id: data.id });

    // `key` appears in this response and never again.
    res.json({ ...data, key, calls_this_month: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /orgs/:orgId/api-keys/:keyId — revoke.
 *
 * Revoked, not deleted: the usage rows point at it, and "which key made those
 * 40,000 calls last month" is exactly the question asked after a key is
 * revoked in a hurry.
 */
router.delete('/:keyId', async (req, res) => {
  try {
    const { data: key } = await supabase
      .from('api_keys').select('id, name, key_prefix, revoked_at')
      .eq('id', req.params.keyId).eq('organization_id', req.org.id).maybeSingle();
    if (!key) return res.status(404).json({ error: 'Key not found' });
    if (key.revoked_at) return res.json({ message: 'This key was already revoked' });

    const { error } = await supabase
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString(), revoked_by: req.user.id })
      .eq('id', key.id).eq('organization_id', req.org.id);
    if (error) throw error;

    await logKeyEvent(req.org.id, req.user.id, `Revoked API key "${key.name}" (${key.key_prefix}…)`, { key_id: key.id });
    res.json({ message: 'Key revoked. Any request using it now fails.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
