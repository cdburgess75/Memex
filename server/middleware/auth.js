const { createClient } = require('@supabase/supabase-js');

// Service-role client for token verification — never exposed to the browser
const adminClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await adminClient.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  // Look up role in user_roles table
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  let { data: roleRow } = await client.from('user_roles').select('role').eq('user_id', user.id).maybeSingle();

  if (!roleRow) {
    // Auto-assign role based on ADMIN_EMAILS env var
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    const assignedRole = adminEmails.includes((user.email || '').toLowerCase()) ? 'admin' : 'contributor';

    await client.from('user_roles').insert({
      user_id: user.id,
      role: assignedRole,
    });

    roleRow = { role: assignedRole };
  }

  req.user = {
    id: user.id,
    email: user.email,
    role: roleRow.role,
    user_metadata: user.user_metadata,
  };

  next();
};
