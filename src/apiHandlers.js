import { extractEmail, generateRandomId } from './commonUtils.js';
import { buildMockEmails, buildMockMailboxes, buildMockEmailDetail } from './mockData.js';
import { getOrCreateMailboxId, getMailboxIdByAddress, recordSentEmail, updateSentEmail, ensureSentEmailsTable, toggleMailboxPin, 
  listUsersWithCounts, createUser, updateUser, deleteUser, assignMailboxToUser, getUserMailboxes } from './database.js';
import { parseEmailBody, extractVerificationCode } from './emailParser.js';
import { sendEmailWithResend, sendBatchWithResend, sendEmailWithAutoResend, sendBatchWithAutoResend, getEmailFromResend, updateEmailInResend, cancelEmailInResend } from './emailSender.js';

export async function handleApiRequest(request, db, mailDomains, options = { mockOnly: false, resendApiKey: '', adminName: '', r2: null, authPayload: null, mailboxOnly: false }) {
  const url = new URL(request.url);
  const path = url.pathname;
  const isMock = !!options.mockOnly;
  const isMailboxOnly = !!options.mailboxOnly;
  const MOCK_DOMAINS = ['exa.cc', 'exr.yp', 'duio.ty'];
  const RESEND_API_KEY = options.resendApiKey || '';

  // 邮箱用户只能访问特定的API端点和自己的数据
  if (isMailboxOnly) {
    const payload = getJwtPayload();
    const mailboxAddress = payload?.mailboxAddress;
    const mailboxId = payload?.mailboxId;
    
    // 允许的API端点
    const allowedPaths = ['/api/emails', '/api/email/', '/api/auth', '/api/quota', '/api/mailbox/password'];
    const isAllowedPath = allowedPaths.some(allowedPath => path.startsWith(allowedPath));
    
    if (!isAllowedPath) {
      return new Response('访问被拒绝', { status: 403 });
    }
    
    // 对于邮件相关API，限制只能访问自己的邮箱
    if (path === '/api/emails' && request.method === 'GET') {
      const requestedMailbox = url.searchParams.get('mailbox');
      if (requestedMailbox && requestedMailbox.toLowerCase() !== mailboxAddress?.toLowerCase()) {
        return new Response('只能访问自己的邮箱', { status: 403 });
      }
      // 如果没有指定邮箱，自动设置为用户自己的邮箱
      if (!requestedMailbox && mailboxAddress) {
        url.searchParams.set('mailbox', mailboxAddress);
      }
    }
    
    // 对于单个邮件操作，验证邮件是否属于该用户的邮箱
    if (path.startsWith('/api/email/') && mailboxId) {
      const emailId = path.split('/')[3];
      if (emailId && emailId !== 'batch') {
        try {
          const { results } = await db.prepare('SELECT mailbox_id FROM messages WHERE id = ?').bind(emailId).all();
          if (!results || results.length === 0) {
            return new Response('邮件不存在', { status: 404 });
          }
          if (results[0].mailbox_id !== mailboxId) {
            return new Response('无权访问此邮件', { status: 403 });
          }
        } catch (e) {
          return new Response('验证失败', { status: 500 });
        }
      }
    }
  }

  function getJwtPayload(){
    // 优先使用服务端传入的已解析身份（支持 __root__ 超管）
    if (options && options.authPayload) return options.authPayload;
    try{
      const cookie = request.headers.get('Cookie') || '';
      const token = (cookie.split(';').find(s=>s.trim().startsWith('iding-session='))||'').split('=')[1] || '';
      const parts = token.split('.');
      if (parts.length === 3){
        const json = atob(parts[1].replace(/-/g,'+').replace(/_/g,'/'));
        return JSON.parse(json);
      }
    }catch(_){ }
    return null;
  }
  function isStrictAdmin(){
    const p = getJwtPayload();
    if (!p) return false;
    if (p.role !== 'admin') return false;
    // __root__（根管理员）视为严格管理员
    if (String(p.username || '') === '__root__') return true;
    if (options?.adminName){ return String(p.username || '').toLowerCase() === String(options.adminName || '').toLowerCase(); }
    return true;
  }
  
  async function sha256Hex(text){
    const enc = new TextEncoder();
    const data = enc.encode(String(text || ''));
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  // ====== 演示模式：用户管理 Mock 状态 ======
  // 注意：内存态仅用于演示，不持久化
  if (!globalThis.__MOCK_USERS__) {
    const now = new Date();
    globalThis.__MOCK_USERS__ = [
      { id: 1, username: 'demo1', role: 'user', can_send: 0, mailbox_limit: 5, created_at: now.toISOString().replace('T',' ').slice(0,19) },
      { id: 2, username: 'demo2', role: 'user', can_send: 0, mailbox_limit: 8, created_at: now.toISOString().replace('T',' ').slice(0,19) },
      { id: 3, username: 'operator', role: 'admin', can_send: 0, mailbox_limit: 20, created_at: now.toISOString().replace('T',' ').slice(0,19) },
    ];
    globalThis.__MOCK_USER_MAILBOXES__ = new Map(); // userId -> [{ address, created_at, is_pinned }]
    // 为每个演示用户预生成若干邮箱，便于列表展示
    try {
      const domains = MOCK_DOMAINS;
      for (const u of globalThis.__MOCK_USERS__) {
        const maxCount = Math.min(u.mailbox_limit || 10, 8);
        const minCount = Math.min(3, maxCount);
        const count = Math.max(minCount, Math.min(maxCount, Math.floor(Math.random() * (maxCount - minCount + 1)) + minCount));
        const boxes = buildMockMailboxes(count, 0, domains);
        globalThis.__MOCK_USER_MAILBOXES__.set(u.id, boxes);
      }
    } catch (_) {
      // 忽略演示数据预生成失败
    }
    globalThis.__MOCK_USER_LAST_ID__ = 3;
  }

  // =================== 用户管理（演示模式） ===================
  if (isMock && path === '/api/users' && request.method === 'GET'){
    const list = (globalThis.__MOCK_USERS__ || []).map(u => {
      const boxes = globalThis.__MOCK_USER_MAILBOXES__?.get(u.id) || [];
      return { ...u, mailbox_count: boxes.length };
    });
    return Response.json(list);
  }
  if (isMock && path === '/api/users' && request.method === 'POST'){
    try{
      const body = await request.json();
      const username = String(body.username || '').trim().toLowerCase();
      if (!username) return new Response('用户名不能为空', { status: 400 });
      const exists = (globalThis.__MOCK_USERS__ || []).some(u => u.username === username);
      if (exists) return new Response('用户名已存在', { status: 400 });
      const role = (body.role === 'admin') ? 'admin' : 'user';
      const mailbox_limit = Math.max(0, Number(body.mailboxLimit || 10));
      const id = ++globalThis.__MOCK_USER_LAST_ID__;
      const item = { id, username, role, can_send: 0, mailbox_limit, created_at: new Date().toISOString().replace('T',' ').slice(0,19) };
      globalThis.__MOCK_USERS__.unshift(item);
      return Response.json(item);
    }catch(e){ return new Response('创建失败', { status: 500 }); }
  }
  if (isMock && request.method === 'PATCH' && path.startsWith('/api/users/')){
    const id = Number(path.split('/')[3]);
    const list = globalThis.__MOCK_USERS__ || [];
    const idx = list.findIndex(u => u.id === id);
    if (idx < 0) return new Response('未找到用户', { status: 404 });
    try{
      const body = await request.json();
      if (typeof body.mailboxLimit !== 'undefined') list[idx].mailbox_limit = Math.max(0, Number(body.mailboxLimit));
      if (typeof body.role === 'string') list[idx].role = (body.role === 'admin' ? 'admin' : 'user');
      if (typeof body.can_send !== 'undefined') list[idx].can_send = body.can_send ? 1 : 0;
      return Response.json({ success: true });
    }catch(_){ return new Response('更新失败', { status: 500 }); }
  }
  if (isMock && request.method === 'DELETE' && path.startsWith('/api/users/')){
    const id = Number(path.split('/')[3]);
    const list = globalThis.__MOCK_USERS__ || [];
    const idx = list.findIndex(u => u.id === id);
    if (idx < 0) return new Response('未找到用户', { status: 404 });
    list.splice(idx, 1);
    globalThis.__MOCK_USER_MAILBOXES__?.delete(id);
    return Response.json({ success: true });
  }
  if (isMock && path === '/api/users/assign' && request.method === 'POST'){
    try{
      const body = await request.json();
      const username = String(body.username || '').trim().toLowerCase();
      const address = String(body.address || '').trim().toLowerCase();
      const u = (globalThis.__MOCK_USERS__ || []).find(x => x.username === username);
      if (!u) return new Response('用户不存在', { status: 404 });
      const boxes = globalThis.__MOCK_USER_MAILBOXES__?.get(u.id) || [];
      if (boxes.length >= (u.mailbox_limit || 10)) return new Response('已达到邮箱上限', { status: 400 });
      const item = { address, created_at: new Date().toISOString().replace('T',' ').slice(0,19), is_pinned: 0 };
      boxes.unshift(item);
      globalThis.__MOCK_USER_MAILBOXES__?.set(u.id, boxes);
      return Response.json({ success: true });
    }catch(_){ return new Response('分配失败', { status: 500 }); }
  }
  if (isMock && request.method === 'GET' && path.startsWith('/api/users/') && path.endsWith('/mailboxes')){
    const id = Number(path.split('/')[3]);
    const all = globalThis.__MOCK_USER_MAILBOXES__?.get(id) || [];
    // 随机返回 3-8 个用于展示效果（若数量不足则返回全部）
    const n = Math.min(all.length, Math.max(3, Math.min(8, Math.floor(Math.random()*6) + 3)));
    const list = all.slice(0, n);
    return Response.json(list);
  }

  // 返回域名列表给前端
  if (path === '/api/domains' && request.method === 'GET') {
    if (isMock) return Response.json(MOCK_DOMAINS);
    const domains = Array.isArray(mailDomains) ? mailDomains : [(mailDomains || 'temp.example.com')];
    return Response.json(domains);
  }

  if (path === '/api/generate') {
    const lengthParam = Number(url.searchParams.get('length') || 0);
    const randomId = generateRandomId(lengthParam || undefined);
    const domains = isMock ? MOCK_DOMAINS : (Array.isArray(mailDomains) ? mailDomains : [(mailDomains || 'temp.example.com')]);
    const domainIdx = Math.max(0, Math.min(domains.length - 1, Number(url.searchParams.get('domainIndex') || 0)));
    const chosenDomain = domains[domainIdx] || domains[0];
    const email = `${randomId}@${chosenDomain}`;
    // 访客模式不写入历史
    if (!isMock) {
      try {
        const payload = getJwtPayload();
        if (payload?.userId) {
          await assignMailboxToUser(db, { userId: payload.userId, address: email });
          return Response.json({ email, expires: Date.now() + 3600000 });
        }
        await getOrCreateMailboxId(db, email);
        return Response.json({ email, expires: Date.now() + 3600000 });
      } catch (e) {
        return new Response(String(e?.message || '创建失败'), { status: 400 });
      }
    }
    return Response.json({ email, expires: Date.now() + 3600000 });
  }

  // ================= 用户管理接口（仅非演示模式） =================
  if (!isMock && path === '/api/users' && request.method === 'GET'){
    if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    try{
      const users = await listUsersWithCounts(db, { limit, offset });
      return Response.json(users);
    }catch(e){ return new Response('查询失败', { status: 500 }); }
  }

  if (!isMock && path === '/api/users' && request.method === 'POST'){
    if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try{
      const body = await request.json();
      const username = String(body.username || '').trim();
      const role = (body.role || 'user') === 'admin' ? 'admin' : 'user';
      const mailboxLimit = Number(body.mailboxLimit || 10);
      const password = String(body.password || '').trim();
      let passwordHash = null;
      if (password){ passwordHash = await sha256Hex(password); }
      const user = await createUser(db, { username, passwordHash, role, mailboxLimit });
      return Response.json(user);
    }catch(e){ return new Response('创建失败: ' + (e?.message || e), { status: 500 }); }
  }

  if (!isMock && request.method === 'PATCH' && path.startsWith('/api/users/')){
    if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    const id = Number(path.split('/')[3]);
    if (!id) return new Response('无效ID', { status: 400 });
    try{
      const body = await request.json();
      const fields = {};
      if (typeof body.mailboxLimit !== 'undefined') fields.mailbox_limit = Math.max(0, Number(body.mailboxLimit));
      if (typeof body.role === 'string') fields.role = (body.role === 'admin' ? 'admin' : 'user');
      if (typeof body.can_send !== 'undefined') fields.can_send = body.can_send ? 1 : 0;
      if (typeof body.password === 'string' && body.password){ fields.password_hash = await sha256Hex(String(body.password)); }
      await updateUser(db, id, fields);
      return Response.json({ success: true });
    }catch(e){ return new Response('更新失败: ' + (e?.message || e), { status: 500 }); }
  }

  if (!isMock && request.method === 'DELETE' && path.startsWith('/api/users/')){
    if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    const id = Number(path.split('/')[3]);
    if (!id) return new Response('无效ID', { status: 400 });
    try{ await deleteUser(db, id); return Response.json({ success: true }); }
    catch(e){ return new Response('删除失败: ' + (e?.message || e), { status: 500 }); }
  }

  if (!isMock && path === '/api/users/assign' && request.method === 'POST'){
    if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try{
      const body = await request.json();
      const username = String(body.username || '').trim();
      const address = String(body.address || '').trim().toLowerCase();
      if (!username || !address) return new Response('参数不完整', { status: 400 });
      const result = await assignMailboxToUser(db, { username, address });
      return Response.json(result);
    }catch(e){ return new Response('分配失败: ' + (e?.message || e), { status: 500 }); }
  }

  if (!isMock && request.method === 'GET' && path.startsWith('/api/users/') && path.endsWith('/mailboxes')){
    const id = Number(path.split('/')[3]);
    if (!id) return new Response('无效ID', { status: 400 });
    try{ const list = await getUserMailboxes(db, id); return Response.json(list || []); }
    catch(e){ return new Response('查询失败', { status: 500 }); }
  }

  // 自定义创建邮箱：{ local, domainIndex }
  if (path === '/api/create' && request.method === 'POST'){
    if (isMock){
      // demo 模式下使用模拟域名（仅内存，不写库）
      try{
        const body = await request.json();
        const local = String(body.local || '').trim().toLowerCase();
        const valid = /^[a-z0-9._-]{1,64}$/i.test(local);
        if (!valid) return new Response('非法用户名', { status: 400 });
        const domains = MOCK_DOMAINS;
        const domainIdx = Math.max(0, Math.min(domains.length - 1, Number(body.domainIndex || 0)));
        const chosenDomain = domains[domainIdx] || domains[0];
        const email = `${local}@${chosenDomain}`;
        return Response.json({ email, expires: Date.now() + 3600000 });
      }catch(_){ return new Response('Bad Request', { status: 400 }); }
    }
    try{
      const body = await request.json();
      const local = String(body.local || '').trim().toLowerCase();
      const valid = /^[a-z0-9._-]{1,64}$/i.test(local);
      if (!valid) return new Response('非法用户名', { status: 400 });
      const domains = Array.isArray(mailDomains) ? mailDomains : [(mailDomains || 'temp.example.com')];
      const domainIdx = Math.max(0, Math.min(domains.length - 1, Number(body.domainIndex || 0)));
      const chosenDomain = domains[domainIdx] || domains[0];
      const email = `${local}@${chosenDomain}`;
      try{
        const payload = getJwtPayload();
        if (payload?.userId) {
          await assignMailboxToUser(db, { userId: payload.userId, address: email });
          return Response.json({ email, expires: Date.now() + 3600000 });
        }
        await getOrCreateMailboxId(db, email);
        return Response.json({ email, expires: Date.now() + 3600000 });
      }catch(e){ return new Response(String(e?.message || '创建失败'), { status: 400 }); }
    }catch(e){ return new Response('创建失败', { status: 500 }); }
  }

  // 当前用户配额：已用/上限
  if (path === '/api/user/quota' && request.method === 'GET'){
    if (isMock){
      // 演示模式：无法区分用户，返回 0/10
      return Response.json({ used: 0, limit: 10 });
    }
    try{
      const payload = getJwtPayload();
      const uid = Number(payload?.userId || 0);
      if (!uid) return Response.json({ used: 0, limit: 0 });
      const ures = await db.prepare('SELECT mailbox_limit FROM users WHERE id = ?').bind(uid).all();
      const limit = ures?.results?.[0]?.mailbox_limit ?? 0;
      const cres = await db.prepare('SELECT COUNT(1) AS c FROM user_mailboxes WHERE user_id = ?').bind(uid).all();
      const used = cres?.results?.[0]?.c || 0;
      return Response.json({ used, limit });
    }catch(_){ return new Response('查询失败', { status: 500 }); }
  }

  // 发件记录列表（按发件人地址过滤）
  if (path === '/api/sent' && request.method === 'GET'){
    if (isMock){
      return Response.json([]);
    }
    const from = url.searchParams.get('from') || url.searchParams.get('mailbox') || '';
    if (!from){ return new Response('缺少 from 参数', { status: 400 }); }
    try{
      await ensureSentEmailsTable(db);
      const { results } = await db.prepare(`
        SELECT id, resend_id, to_addrs as recipients, subject, created_at, status
        FROM sent_emails
        WHERE from_addr = ?
        ORDER BY datetime(created_at) DESC
        LIMIT 50
      `).bind(String(from).trim().toLowerCase()).all();
      return Response.json(results || []);
    }catch(e){
      console.error('查询发件记录失败:', e);
      return new Response('查询发件记录失败', { status: 500 });
    }
  }

  // 发件详情
  if (request.method === 'GET' && path.startsWith('/api/sent/')){
    if (isMock){ return new Response('演示模式不可查询真实发送', { status: 403 }); }
    const id = path.split('/')[3];
    try{
      const { results } = await db.prepare(`
        SELECT id, resend_id, from_addr, to_addrs as recipients, subject,
               html_content, text_content, status, scheduled_at, created_at
        FROM sent_emails WHERE id = ?
      `).bind(id).all();
      if (!results || !results.length) return new Response('未找到发件', { status: 404 });
      return Response.json(results[0]);
    }catch(e){
      return new Response('查询失败', { status: 500 });
    }
  }

  // 发送单封邮件
  if (path === '/api/send' && request.method === 'POST'){
    if (isMock) return new Response('演示模式不可发送', { status: 403 });
    try{
      if (!RESEND_API_KEY) return new Response('未配置 Resend API Key', { status: 500 });
      // 校验是否允许发件：根据当前登录用户（从 Cookie 读取 JWT）
      const cookie = request.headers.get('Cookie') || '';
      const token = (cookie.split(';').find(s=>s.trim().startsWith('iding-session='))||'').split('=')[1] || '';
      let jwtPayload = null;
      try{
        const parts = token.split('.');
        if (parts.length === 3){
          const json = atob(parts[1].replace(/-/g,'+').replace(/_/g,'/'));
          jwtPayload = JSON.parse(json);
        }
      }catch(_){ }
      if (jwtPayload && jwtPayload.userId){
        const { results } = await db.prepare('SELECT can_send FROM users WHERE id = ?').bind(jwtPayload.userId).all();
        const canSend = results?.[0]?.can_send ? 1 : 0;
        if (!canSend) return new Response('该用户未被授予发件权限', { status: 403 });
      } else if (jwtPayload && jwtPayload.role === 'admin'){
        // 管理员默认允许
      } else {
        // 无用户身份或访客不允许
        return new Response('未授权发件', { status: 403 });
      }
      const sendPayload = await request.json();
      // 使用智能发送，根据发件人域名自动选择API密钥
      const result = await sendEmailWithAutoResend(RESEND_API_KEY, sendPayload);
      await ensureSentEmailsTable(db);
      await recordSentEmail(db, {
        resendId: result.id || null,
        fromName: sendPayload.fromName || null,
        from: sendPayload.from,
        to: sendPayload.to,
        subject: sendPayload.subject,
        html: sendPayload.html,
        text: sendPayload.text,
        status: 'delivered',
        scheduledAt: sendPayload.scheduledAt || null
      });
      return Response.json({ success: true, id: result.id });
    }catch(e){
      return new Response('发送失败: ' + e.message, { status: 500 });
    }
  }

  // 批量发送
  if (path === '/api/send/batch' && request.method === 'POST'){
    if (isMock) return new Response('演示模式不可发送', { status: 403 });
    try{
      if (!RESEND_API_KEY) return new Response('未配置 Resend API Key', { status: 500 });
      // 同样校验发件权限
      const cookie = request.headers.get('Cookie') || '';
      const token = (cookie.split(';').find(s=>s.trim().startsWith('iding-session='))||'').split('=')[1] || '';
      let payloadJwt = null;
      try{
        const parts = token.split('.');
        if (parts.length === 3){
          const json = atob(parts[1].replace(/-/g,'+').replace(/_/g,'/'));
          payloadJwt = JSON.parse(json);
        }
      }catch(_){ }
      if (payloadJwt && payloadJwt.userId){
        const { results } = await db.prepare('SELECT can_send FROM users WHERE id = ?').bind(payloadJwt.userId).all();
        const canSend = results?.[0]?.can_send ? 1 : 0;
        if (!canSend) return new Response('该用户未被授予发件权限', { status: 403 });
      } else if (payloadJwt && payloadJwt.role === 'admin'){
        // 管理员默认允许
      } else {
        return new Response('未授权发件', { status: 403 });
      }
      const items = await request.json();
      // 使用智能批量发送，自动按域名分组并使用对应的API密钥
      const result = await sendBatchWithAutoResend(RESEND_API_KEY, items);
      try{
        await ensureSentEmailsTable(db);
        // 尝试记录（如果返回结构包含 id 列表）
        const arr = Array.isArray(result) ? result : [];
        for (let i = 0; i < arr.length; i++){
          const id = arr[i]?.id;
          const payload = items[i] || {};
          await recordSentEmail(db, {
            resendId: id || null,
            fromName: payload.fromName || null,
            from: payload.from,
            to: payload.to,
            subject: payload.subject,
            html: payload.html,
            text: payload.text,
            status: 'delivered',
            scheduledAt: payload.scheduledAt || null
          });
        }
      }catch(_){/* ignore */}
      return Response.json({ success: true, result });
    }catch(e){
      return new Response('批量发送失败: ' + e.message, { status: 500 });
    }
  }

  // 查询发送结果
  if (path.startsWith('/api/send/') && request.method === 'GET'){
    if (isMock) return new Response('演示模式不可查询真实发送', { status: 403 });
    const id = path.split('/')[3];
    try{
      if (!RESEND_API_KEY) return new Response('未配置 Resend API Key', { status: 500 });
      const data = await getEmailFromResend(RESEND_API_KEY, id);
      return Response.json(data);
    }catch(e){
      return new Response('查询失败: ' + e.message, { status: 500 });
    }
  }

  // 更新（修改定时/状态等）
  if (path.startsWith('/api/send/') && request.method === 'PATCH'){
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    const id = path.split('/')[3];
    try{
      if (!RESEND_API_KEY) return new Response('未配置 Resend API Key', { status: 500 });
      const body = await request.json();
      let data = { ok: true };
      // 如果只是更新本地状态，不必请求 Resend
      if (body && typeof body.status === 'string'){
        await updateSentEmail(db, id, { status: body.status });
      }
      // 更新定时设置时需要触达 Resend
      if (body && body.scheduledAt){
        data = await updateEmailInResend(RESEND_API_KEY, { id, scheduledAt: body.scheduledAt });
        await updateSentEmail(db, id, { scheduled_at: body.scheduledAt });
      }
      return Response.json(data || { ok: true });
    }catch(e){
      return new Response('更新失败: ' + e.message, { status: 500 });
    }
  }

  // 取消发送
  if (path.startsWith('/api/send/') && path.endsWith('/cancel') && request.method === 'POST'){
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    const id = path.split('/')[3];
    try{
      if (!RESEND_API_KEY) return new Response('未配置 Resend API Key', { status: 500 });
      const data = await cancelEmailInResend(RESEND_API_KEY, id);
      await updateSentEmail(db, id, { status: 'canceled' });
      return Response.json(data);
    }catch(e){
      return new Response('取消失败: ' + e.message, { status: 500 });
    }
  }

  // 删除发件记录
  if (request.method === 'DELETE' && path.startsWith('/api/sent/')){
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    const id = path.split('/')[3];
    try{
      await db.prepare('DELETE FROM sent_emails WHERE id = ?').bind(id).run();
      return Response.json({ success: true });
    }catch(e){
      return new Response('删除发件记录失败: ' + e.message, { status: 500 });
    }
  }

  if (path === '/api/emails' && request.method === 'GET') {
    const mailbox = url.searchParams.get('mailbox');
    if (!mailbox) {
      return new Response('缺少 mailbox 参数', { status: 400 });
    }
    try {
      if (isMock) {
        return Response.json(buildMockEmails(6));
      }
      const normalized = extractEmail(mailbox).trim().toLowerCase();
      // 纯读：不存在则返回空数组，不创建
      const mailboxId = await getMailboxIdByAddress(db, normalized);
      if (!mailboxId) return Response.json([]);
      
      // 邮箱用户只能查看近24小时的邮件
      let timeFilter = '';
      let timeParam = [];
      if (isMailboxOnly) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        timeFilter = ' AND received_at >= ?';
        timeParam = [twentyFourHoursAgo];
      }
      
      try{
        const { results } = await db.prepare(`
          SELECT id, sender, subject, received_at, is_read, preview, verification_code
          FROM messages 
          WHERE mailbox_id = ?${timeFilter}
          ORDER BY received_at DESC 
          LIMIT 50
        `).bind(mailboxId, ...timeParam).all();
        return Response.json(results);
      }catch(e){
        // 旧结构降级查询：从 content/html_content 计算 preview
        const { results } = await db.prepare(`
          SELECT id, sender, subject, received_at, is_read,
                 CASE WHEN content IS NOT NULL AND content <> ''
                      THEN SUBSTR(content, 1, 120)
                      ELSE SUBSTR(COALESCE(html_content, ''), 1, 120)
                 END AS preview
          FROM messages 
          WHERE mailbox_id = ?${timeFilter}
          ORDER BY received_at DESC 
          LIMIT 50
        `).bind(mailboxId, ...timeParam).all();
        return Response.json(results);
      }
    } catch (e) {
      console.error('查询邮件失败:', e);
      return new Response('查询邮件失败', { status: 500 });
    }
  }

  // 批量查询邮件详情，减少前端 N+1 请求
  if (path === '/api/emails/batch' && request.method === 'GET'){
    try{
      const idsParam = String(url.searchParams.get('ids') || '').trim();
      if (!idsParam) return Response.json([]);
      const ids = idsParam.split(',').map(s=>parseInt(s,10)).filter(n=>Number.isInteger(n) && n>0);
      if (!ids.length) return Response.json([]);
      if (isMock){
        const arr = ids.map(id => buildMockEmailDetail(id));
        return Response.json(arr);
      }
      
      // 邮箱用户只能查看近24小时的邮件
      let timeFilter = '';
      let timeParam = [];
      if (isMailboxOnly) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        timeFilter = ' AND received_at >= ?';
        timeParam = [twentyFourHoursAgo];
      }
      
      const placeholders = ids.map(()=>'?').join(',');
      try{
        const { results } = await db.prepare(`
          SELECT id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key, received_at, is_read
          FROM messages WHERE id IN (${placeholders})${timeFilter}
        `).bind(...ids, ...timeParam).all();
        return Response.json(results || []);
      }catch(e){
        const { results } = await db.prepare(`
          SELECT id, sender, subject, content, html_content, received_at, is_read
          FROM messages WHERE id IN (${placeholders})${timeFilter}
        `).bind(...ids, ...timeParam).all();
        return Response.json(results || []);
      }
    }catch(e){
      return new Response('批量查询失败', { status: 500 });
    }
  }

  // 历史邮箱列表（按创建时间倒序）支持分页
  if (path === '/api/mailboxes' && request.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 100);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    if (isMock) {
      return Response.json(buildMockMailboxes(limit, offset, mailDomains));
    }
    // 超级管理员（严格管理员）可查看全部；其他仅查看自身绑定
    try{
      if (isStrictAdmin()){
        // 严格管理员：查看所有邮箱，并用自己在 user_mailboxes 中的置顶状态覆盖；未置顶则为 0
        const payload = getJwtPayload();
        const adminUid = Number(payload?.userId || 0);
        const like = `%${q.replace(/%/g,'').replace(/_/g,'')}%`;
        const { results } = await db.prepare(`
          SELECT m.address, m.created_at, COALESCE(um.is_pinned, 0) AS is_pinned,
                 CASE WHEN (m.password_hash IS NULL OR m.password_hash = '') THEN 1 ELSE 0 END AS password_is_default,
                 COALESCE(m.can_login, 0) AS can_login
          FROM mailboxes m
          LEFT JOIN user_mailboxes um ON um.mailbox_id = m.id AND um.user_id = ?
          WHERE (? = '' OR LOWER(m.address) LIKE LOWER(?))
          ORDER BY is_pinned DESC, m.created_at DESC
          LIMIT ? OFFSET ?
        `).bind(adminUid || 0, q ? like : '', q ? like : '', limit, offset).all();
        return Response.json(results || []);
      }
      const payload = getJwtPayload();
      const uid = Number(payload?.userId || 0);
      if (!uid) return Response.json([]);
      const like = `%${q.replace(/%/g,'').replace(/_/g,'')}%`;
      const { results } = await db.prepare(`
        SELECT m.address, m.created_at, um.is_pinned,
               CASE WHEN (m.password_hash IS NULL OR m.password_hash = '') THEN 1 ELSE 0 END AS password_is_default,
               COALESCE(m.can_login, 0) AS can_login
        FROM user_mailboxes um
        JOIN mailboxes m ON m.id = um.mailbox_id
        WHERE um.user_id = ? AND (? = '' OR LOWER(m.address) LIKE LOWER(?))
        ORDER BY um.is_pinned DESC, m.created_at DESC
        LIMIT ? OFFSET ?
      `).bind(uid, q ? like : '', q ? like : '', limit, offset).all();
      return Response.json(results || []);
    }catch(_){
      return Response.json([]);
    }
  }

  // 重置某个邮箱的密码为默认（邮箱本身）——仅严格管理员
  if (path === '/api/mailboxes/reset-password' && request.method === 'POST') {
    if (isMock) return Response.json({ success: true, mock: true });
    try{
      if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
      const address = String(url.searchParams.get('address') || '').trim().toLowerCase();
      if (!address) return new Response('缺少 address 参数', { status: 400 });
      await db.prepare('UPDATE mailboxes SET password_hash = NULL WHERE address = ?').bind(address).run();
      return Response.json({ success: true });
    }catch(e){ return new Response('重置失败', { status: 500 }); }
  }

  // 切换邮箱置顶状态
  if (path === '/api/mailboxes/pin' && request.method === 'POST') {
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    const address = url.searchParams.get('address');
    if (!address) return new Response('缺少 address 参数', { status: 400 });
    const payload = getJwtPayload();
    let uid = Number(payload?.userId || 0);
    // 兼容旧会话：严格管理员旧 Token 可能没有 userId，这里兜底保障可置顶
    if (!uid && isStrictAdmin()){
      try{
        const { results } = await db.prepare('SELECT id FROM users WHERE username = ?')
          .bind(String(options?.adminName || 'admin').toLowerCase()).all();
        if (results && results.length){
          uid = Number(results[0].id);
        } else {
          const uname = String(options?.adminName || 'admin').toLowerCase();
          await db.prepare("INSERT INTO users (username, role, can_send, mailbox_limit) VALUES (?, 'admin', 1, 9999)").bind(uname).run();
          const again = await db.prepare('SELECT id FROM users WHERE username = ?').bind(uname).all();
          uid = Number(again?.results?.[0]?.id || 0);
        }
      }catch(_){ uid = 0; }
    }
    if (!uid) return new Response('未登录', { status: 401 });
    try {
      const result = await toggleMailboxPin(db, address, uid);
      return Response.json({ success: true, ...result });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  // 切换邮箱登录权限（仅严格管理员可用）
  if (path === '/api/mailboxes/toggle-login' && request.method === 'POST') {
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try {
      const body = await request.json();
      const address = String(body.address || '').trim().toLowerCase();
      const canLogin = Boolean(body.can_login);
      
      if (!address) return new Response('缺少 address 参数', { status: 400 });
      
      // 检查邮箱是否存在
      const mbRes = await db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(address).all();
      if (!mbRes.results || mbRes.results.length === 0) {
        return new Response('邮箱不存在', { status: 404 });
      }
      
      // 更新登录权限
      await db.prepare('UPDATE mailboxes SET can_login = ? WHERE address = ?')
        .bind(canLogin ? 1 : 0, address).run();
      
      return Response.json({ success: true, can_login: canLogin });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  // 修改邮箱密码（仅严格管理员可用）
  if (path === '/api/mailboxes/change-password' && request.method === 'POST') {
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try {
      const body = await request.json();
      const address = String(body.address || '').trim().toLowerCase();
      const newPassword = String(body.new_password || '').trim();
      
      if (!address) return new Response('缺少 address 参数', { status: 400 });
      if (!newPassword || newPassword.length < 6) return new Response('密码长度至少6位', { status: 400 });
      
      // 检查邮箱是否存在
      const mbRes = await db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(address).all();
      if (!mbRes.results || mbRes.results.length === 0) {
        return new Response('邮箱不存在', { status: 404 });
      }
      
      // 生成密码哈希
      const newPasswordHash = await sha256Hex(newPassword);
      
      // 更新密码
      await db.prepare('UPDATE mailboxes SET password_hash = ? WHERE address = ?')
        .bind(newPasswordHash, address).run();
      
      return Response.json({ success: true });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  // 删除邮箱（及其所有邮件）
  if (path === '/api/mailboxes' && request.method === 'DELETE') {
    if (isMock) return new Response('演示模式不可删除', { status: 403 });
    const raw = url.searchParams.get('address');
    if (!raw) return new Response('缺少 address 参数', { status: 400 });
    const normalized = String(raw || '').trim().toLowerCase();
    try {
      const mailboxId = await getMailboxIdByAddress(db, normalized);
      // 未找到则明确返回 404，避免前端误判为成功
      if (!mailboxId) return new Response(JSON.stringify({ success: false, message: '邮箱不存在' }), { status: 404 });
      if (!isStrictAdmin()){
        // 二级管理员（数据库中的 admin 角色）仅能删除自己绑定的邮箱
        const payload = getJwtPayload();
        if (!payload || payload.role !== 'admin' || !payload.userId) return new Response('Forbidden', { status: 403 });
        const own = await db.prepare('SELECT 1 FROM user_mailboxes WHERE user_id = ? AND mailbox_id = ?')
          .bind(Number(payload.userId), mailboxId).all();
        if (!own?.results?.length) return new Response('Forbidden', { status: 403 });
      }
      // 简易事务，降低并发插入导致的外键失败概率
      try { await db.exec('BEGIN'); } catch(_) {}
      await db.prepare('DELETE FROM messages WHERE mailbox_id = ?').bind(mailboxId).run();
      await db.prepare('DELETE FROM mailboxes WHERE id = ?').bind(mailboxId).run();
      try { await db.exec('COMMIT'); } catch(_) {}

      // 确认删除结果
      const verify = await db.prepare('SELECT COUNT(1) AS c FROM mailboxes WHERE id = ?').bind(mailboxId).all();
      const deleted = (verify?.results?.[0]?.c || 0) === 0;
      return Response.json({ success: deleted, deleted });
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch(_) {}
      return new Response('删除失败', { status: 500 });
    }
  }

  // 下载 EML（从 R2 获取）- 必须在通用邮件详情处理器之前
  if (request.method === 'GET' && path.startsWith('/api/email/') && path.endsWith('/download')){
    if (options.mockOnly) return new Response('演示模式不可下载', { status: 403 });
    const id = path.split('/')[3];
    const { results } = await db.prepare('SELECT r2_bucket, r2_object_key FROM messages WHERE id = ?').bind(id).all();
    const row = (results||[])[0];
    if (!row || !row.r2_object_key) return new Response('未找到对象', { status: 404 });
    try{
      const r2 = options.r2;
      if (!r2) return new Response('R2 未绑定', { status: 500 });
      const obj = await r2.get(row.r2_object_key);
      if (!obj) return new Response('对象不存在', { status: 404 });
      const headers = new Headers({ 'Content-Type': 'message/rfc822' });
      headers.set('Content-Disposition', `attachment; filename="${String(row.r2_object_key).split('/').pop()}"`);
      return new Response(obj.body, { headers });
    }catch(e){
      return new Response('下载失败', { status: 500 });
    }
  }

  if (request.method === 'GET' && path.startsWith('/api/email/')) {
    const emailId = path.split('/')[3];
    if (isMock) {
      return Response.json(buildMockEmailDetail(emailId));
    }
    try{
      // 邮箱用户需要验证邮件是否在24小时内
      let timeFilter = '';
      let timeParam = [];
      if (isMailboxOnly) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        timeFilter = ' AND received_at >= ?';
        timeParam = [twentyFourHoursAgo];
      }
      
      const { results } = await db.prepare(`
        SELECT id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key, received_at, is_read
        FROM messages WHERE id = ?${timeFilter}
      `).bind(emailId, ...timeParam).all();
      if (results.length === 0) {
        if (isMailboxOnly) {
          return new Response('邮件不存在或已超过24小时访问期限', { status: 404 });
        }
        return new Response('未找到邮件', { status: 404 });
      }
      await db.prepare(`UPDATE messages SET is_read = 1 WHERE id = ?`).bind(emailId).run();
      const row = results[0];
      let content = '';
      let html_content = '';
      // 若存在 R2 对象，尝试解析正文并返回兼容字段
      try{
        if (row.r2_object_key && options.r2){
          const obj = await options.r2.get(row.r2_object_key);
          if (obj){
            let raw = '';
            if (typeof obj.text === 'function') raw = await obj.text();
            else if (typeof obj.arrayBuffer === 'function') raw = await new Response(await obj.arrayBuffer()).text();
            else raw = await new Response(obj.body).text();
            const parsed = parseEmailBody(raw || '');
            content = parsed.text || '';
            html_content = parsed.html || '';
          }
        }
      }catch(_){ }

      // 当未绑定 R2 或解析结果为空时，回退读取数据库中的 content/html_content（兼容旧数据/无 R2 环境）
      if ((!content && !html_content)){
        try{
          const fallback = await db.prepare('SELECT content, html_content FROM messages WHERE id = ?').bind(emailId).all();
          const fr = (fallback?.results || [])[0] || {};
          content = content || fr.content || '';
          html_content = html_content || fr.html_content || '';
        }catch(_){ /* 忽略：旧表可能缺少字段 */ }
      }

      return Response.json({ ...row, content, html_content, download: row.r2_object_key ? `/api/email/${emailId}/download` : '' });
    }catch(e){
      const { results } = await db.prepare(`
        SELECT id, sender, subject, content, html_content, received_at, is_read
        FROM messages WHERE id = ?
      `).bind(emailId).all();
      if (!results || !results.length) return new Response('未找到邮件', { status: 404 });
      await db.prepare(`UPDATE messages SET is_read = 1 WHERE id = ?`).bind(emailId).run();
      return Response.json(results[0]);
    }
  }

  if (request.method === 'DELETE' && path.startsWith('/api/email/')) {
    if (isMock) return new Response('演示模式不可删除', { status: 403 });
    const emailId = path.split('/')[3];
    
    if (!emailId || !Number.isInteger(parseInt(emailId))) {
      return new Response('无效的邮件ID', { status: 400 });
    }
    
    try {
      // 先检查邮件是否存在
      const existsResult = await db.prepare(`SELECT COUNT(*) as count FROM messages WHERE id = ?`).bind(emailId).all();
      const existsBefore = existsResult.results[0]?.count || 0;
      
      if (existsBefore === 0) {
        return Response.json({ success: true, deleted: false, message: '邮件不存在或已被删除' });
      }
      
      await db.prepare(`DELETE FROM messages WHERE id = ?`).bind(emailId).run();
      
      // 再次检查确认删除
      const existsAfterResult = await db.prepare(`SELECT COUNT(*) as count FROM messages WHERE id = ?`).bind(emailId).all();
      const existsAfter = existsAfterResult.results[0]?.count || 0;
      
      const actualDeleted = existsBefore - existsAfter;
      
      return Response.json({ 
        success: true, 
        deleted: actualDeleted > 0,
        message: actualDeleted > 0 ? '邮件已删除' : '删除操作未生效'
      });
    } catch (e) {
      console.error('删除邮件失败:', e);
      return new Response('删除邮件时发生错误: ' + e.message, { status: 500 });
    }
  }

  if (request.method === 'DELETE' && path === '/api/emails') {
    if (isMock) return new Response('演示模式不可清空', { status: 403 });
    const mailbox = url.searchParams.get('mailbox');
    if (!mailbox) {
      return new Response('缺少 mailbox 参数', { status: 400 });
    }
    try {
      const normalized = extractEmail(mailbox).trim().toLowerCase();
      // 仅当邮箱已存在时才执行清空操作；不存在则直接返回 0 删除
      const mailboxId = await getMailboxIdByAddress(db, normalized);
      if (!mailboxId) {
        return Response.json({ success: true, deletedCount: 0, previousCount: 0 });
      }
      
      // 先查询当前有多少邮件
      const countBeforeResult = await db.prepare(`SELECT COUNT(*) as count FROM messages WHERE mailbox_id = ?`).bind(mailboxId).all();
      const countBefore = countBeforeResult.results[0]?.count || 0;
      
      await db.prepare(`DELETE FROM messages WHERE mailbox_id = ?`).bind(mailboxId).run();
      
      // 再次查询确认删除后的数量
      const countAfterResult = await db.prepare(`SELECT COUNT(*) as count FROM messages WHERE mailbox_id = ?`).bind(mailboxId).all();
      const countAfter = countAfterResult.results[0]?.count || 0;
      
      // 通过前后对比计算实际删除的数量
      const actualDeletedCount = countBefore - countAfter;
      
      return Response.json({ 
        success: true, 
        deletedCount: actualDeletedCount, 
        previousCount: countBefore
      });
    } catch (e) {
      console.error('清空邮件失败:', e);
      return new Response('清空邮件失败', { status: 500 });
    }
  }

  // ================= 邮箱密码管理 =================
  if (path === '/api/mailbox/password' && request.method === 'PUT') {
    if (isMock) return new Response('演示模式不可修改密码', { status: 403 });
    
    try {
      const body = await request.json();
      const { currentPassword, newPassword } = body;
      
      if (!currentPassword || !newPassword) {
        return new Response('当前密码和新密码不能为空', { status: 400 });
      }
      
      if (newPassword.length < 6) {
        return new Response('新密码长度至少6位', { status: 400 });
      }
      
      const payload = getJwtPayload();
      const mailboxAddress = payload?.mailboxAddress;
      const mailboxId = payload?.mailboxId;
      
      if (!mailboxAddress || !mailboxId) {
        return new Response('未找到邮箱信息', { status: 401 });
      }
      
      // 验证当前密码
      const { results } = await db.prepare('SELECT password_hash FROM mailboxes WHERE id = ? AND address = ?')
        .bind(mailboxId, mailboxAddress).all();
      
      if (!results || results.length === 0) {
        return new Response('邮箱不存在', { status: 404 });
      }
      
      const mailbox = results[0];
      let currentPasswordValid = false;
      
      if (mailbox.password_hash) {
        // 如果有存储的密码哈希，验证哈希密码
        const { verifyPassword } = await import('./authentication.js');
        currentPasswordValid = await verifyPassword(currentPassword, mailbox.password_hash);
      } else {
        // 兼容性：如果没有密码哈希，使用邮箱地址作为默认密码
        currentPasswordValid = (currentPassword === mailboxAddress);
      }
      
      if (!currentPasswordValid) {
        return new Response('当前密码错误', { status: 400 });
      }
      
      // 生成新密码哈希
      const { hashPassword } = await import('./authentication.js');
      const newPasswordHash = await hashPassword(newPassword);
      
      // 更新密码
      await db.prepare('UPDATE mailboxes SET password_hash = ? WHERE id = ?')
        .bind(newPasswordHash, mailboxId).run();
      
      return Response.json({ success: true, message: '密码修改成功' });
      
    } catch (error) {
      console.error('修改密码失败:', error);
      return new Response('修改密码失败', { status: 500 });
    }
  }

  return new Response('未找到 API 路径', { status: 404 });
}

export async function handleEmailReceive(request, db, env) {
  try {
    const emailData = await request.json();
    const to = String(emailData?.to || '');
    const from = String(emailData?.from || '');
    const subject = String(emailData?.subject || '(无主题)');
    const text = String(emailData?.text || '');
    const html = String(emailData?.html || '');

    const mailbox = extractEmail(to);
    const sender = extractEmail(from);
    const mailboxId = await getOrCreateMailboxId(db, mailbox);

    // 构造简易 EML 并写入 R2（即便没有原始 raw 也生成便于详情查看）
    const now = new Date();
    const dateStr = now.toUTCString();
    const boundary = 'mf-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    let eml = '';
    if (html) {
      eml = [
        `From: <${sender}>`,
        `To: <${mailbox}>`,
        `Subject: ${subject}`,
        `Date: ${dateStr}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        text || '',
        `--${boundary}`,
        'Content-Type: text/html; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        html,
        `--${boundary}--`,
        ''
      ].join('\r\n');
    } else {
      eml = [
        `From: <${sender}>`,
        `To: <${mailbox}>`,
        `Subject: ${subject}`,
        `Date: ${dateStr}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        text || '',
        ''
      ].join('\r\n');
    }

    let objectKey = '';
    try {
      const r2 = env?.MAIL_EML;
      if (r2) {
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, '0');
        const d = String(now.getUTCDate()).padStart(2, '0');
        const hh = String(now.getUTCHours()).padStart(2, '0');
        const mm = String(now.getUTCMinutes()).padStart(2, '0');
        const ss = String(now.getUTCSeconds()).padStart(2, '0');
        const keyId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const safeMailbox = (mailbox || 'unknown').toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
        objectKey = `${y}/${m}/${d}/${safeMailbox}/${hh}${mm}${ss}-${keyId}.eml`;
        await r2.put(objectKey, eml, { httpMetadata: { contentType: 'message/rfc822' } });
      }
    } catch (_) { objectKey = ''; }

    const previewBase = (text || html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const preview = String(previewBase || '').slice(0, 120);
    let verificationCode = '';
    try {
      verificationCode = extractVerificationCode({ subject, text, html });
    } catch (_) {}

    // 动态列检测，兼容旧表
    let cols = [];
    try {
      const info = await db.prepare('PRAGMA table_info(messages)').all();
      cols = (info?.results || []).map(r => ({ name: (r.name || r['name']), notnull: r.notnull ? 1 : 0 }));
    } catch (_) {}
    const colSet = new Set(cols.map(c => c.name));
    const requiresContent = cols.some(c => c.name === 'content' && c.notnull === 1);

    const insertCols = ['mailbox_id', 'sender'];
    const values = [mailboxId, sender];
    if (colSet.has('to_addrs')) { insertCols.push('to_addrs'); values.push(String(to || '')); }
    insertCols.push('subject'); values.push(subject || '(无主题)');
    if (colSet.has('verification_code')) { insertCols.push('verification_code'); values.push(verificationCode || null); }
    if (colSet.has('preview')) { insertCols.push('preview'); values.push(preview || null); }
    if (colSet.has('r2_bucket')) { insertCols.push('r2_bucket'); values.push('mail-eml'); }
    if (colSet.has('r2_object_key')) { insertCols.push('r2_object_key'); values.push(objectKey || ''); }
    if (requiresContent || colSet.has('content')) { insertCols.push('content'); values.push(text || html || subject || '(无内容)'); }
    if (colSet.has('html_content')) { insertCols.push('html_content'); values.push(html || null); }

    const placeholders = insertCols.map(()=>'?').join(', ');
    const sql = `INSERT INTO messages (${insertCols.join(', ')}) VALUES (${placeholders})`;
    await db.prepare(sql).bind(...values).run();

    return Response.json({ success: true });
  } catch (error) {
    console.error('处理邮件时出错:', error);
    return new Response('处理邮件失败', { status: 500 });
  }
}

