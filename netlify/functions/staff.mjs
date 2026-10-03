// 工作人員帳號管理（只有管理員 owner 能呼叫）
// 需要在 Netlify 設定環境變數 SUPABASE_SERVICE_ROLE_KEY（Supabase 的 secret / service_role key）。
// 這把金鑰只存在伺服器端，絕對不會送到瀏覽器。
//
// POST /api/staff  （Authorization: Bearer <登入者的 access token>）
//   { action: 'create',         email, password, role }   建立帳號並設為工作人員（帳號已存在則只加入名單）
//   { action: 'reset_password', user_id, password }       重設工作人員密碼
//   { action: 'delete',         user_id }                 移除工作人員並刪除帳號

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createHandler(env = process.env, fetchImpl = fetch) {
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const service = { apikey: key, Authorization: `Bearer ${key}` };

  async function call(path, { method = 'GET', headers = {}, body } = {}) {
    const res = await fetchImpl(url + path, {
      method,
      headers: { ...service, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  }

  const errText = (d) => d?.msg || d?.message || d?.error_description || d?.error || '未知錯誤';

  async function currentUser(token) {
    const r = await fetchImpl(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new HttpError(401, '登入已過期，請重新登入');
    return r.json();
  }

  async function roleOf(userId) {
    const r = await call(`/rest/v1/admins?user_id=eq.${encodeURIComponent(userId)}&select=role`);
    if (!r.ok) throw new HttpError(500, `讀取權限失敗：${errText(r.data)}`);
    return r.data?.[0]?.role ?? null;
  }

  const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 72;
  const isUuid = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

  async function create({ email, password, role }) {
    email = String(email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Email 格式不正確');
    if (!['owner', 'staff'].includes(role)) throw new HttpError(400, '角色不正確');

    let userId = null;
    let created = false;
    const lookup = await call('/rest/v1/rpc/user_id_by_email', { method: 'POST', body: { p_email: email } });
    if (lookup.ok && lookup.data) userId = lookup.data;
    if (!userId) {
      if (!validPassword(password)) throw new HttpError(400, '密碼至少 8 個字元');
      const r = await call('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
      if (!r.ok) throw new HttpError(400, `建立帳號失敗：${errText(r.data)}`);
      userId = r.data?.id ?? r.data?.user?.id;
      created = true;
    }
    const up = await call('/rest/v1/admins?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { user_id: userId, role },
    });
    if (!up.ok) throw new HttpError(400, `設定權限失敗：${errText(up.data)}`);
    return { user_id: userId, created };
  }

  async function resetPassword({ user_id, password }) {
    if (!isUuid(user_id)) throw new HttpError(400, '帳號不正確');
    if (!validPassword(password)) throw new HttpError(400, '密碼至少 8 個字元');
    if (!(await roleOf(user_id))) throw new HttpError(404, '只能重設工作人員的密碼');
    const r = await call(`/auth/v1/admin/users/${user_id}`, { method: 'PUT', body: { password } });
    if (!r.ok) throw new HttpError(400, `重設密碼失敗：${errText(r.data)}`);
    return { ok: true };
  }

  async function remove({ user_id }, me) {
    if (!isUuid(user_id)) throw new HttpError(400, '帳號不正確');
    if (user_id === me.id) throw new HttpError(400, '不能移除自己');
    if (!(await roleOf(user_id))) throw new HttpError(404, '找不到這位工作人員');
    const del = await call(`/rest/v1/admins?user_id=eq.${user_id}`, { method: 'DELETE' });
    if (!del.ok) throw new HttpError(400, errText(del.data)); // 例如：至少要保留一位管理員
    const r = await call(`/auth/v1/admin/users/${user_id}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new HttpError(400, `刪除帳號失敗：${errText(r.data)}`);
    return { ok: true };
  }

  return async function handler(req) {
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (!url || !key) {
        throw new HttpError(503, '伺服器尚未設定 SUPABASE_SERVICE_ROLE_KEY，請依 README 在 Netlify 新增環境變數');
      }
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!token) throw new HttpError(401, '請先登入');
      const me = await currentUser(token);
      if ((await roleOf(me.id)) !== 'owner') throw new HttpError(403, '只有管理員可以管理工作人員');

      let body;
      try { body = await req.json(); } catch { throw new HttpError(400, '資料格式錯誤'); }
      switch (body?.action) {
        case 'create': return json(200, await create(body));
        case 'reset_password': return json(200, await resetPassword(body));
        case 'delete': return json(200, await remove(body, me));
        default: throw new HttpError(400, '未知的操作');
      }
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: '伺服器錯誤，請稍後再試' });
    }
  };
}

export default createHandler();

export const config = { path: '/api/staff' };
