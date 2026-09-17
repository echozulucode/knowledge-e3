import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Kysely } from 'kysely';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

/**
 * Plan §6 D2 — the security-relevant writes are audited.
 *
 * Each case asserts EXACTLY one row, because a duplicate is as misleading as a
 * missing one: an administrator counting sign-ins or role changes is counting
 * these rows.
 */
describe('audited security events', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
  });
  afterEach(async () => app.close());

  async function rows(action: string) {
    return db.selectFrom('audit_log').selectAll().where('action', '=', action).execute();
  }

  async function payloadOf(action: string): Promise<any> {
    const [row] = await rows(action);
    return row?.payload_json ? JSON.parse(row.payload_json) : null;
  }

  describe('sign-in', () => {
    it('auth.login records one row for the account that signed in', async () => {
      // seedAdminAndLogin already signed in once.
      const found = await rows('auth.login');
      expect(found).toHaveLength(1);
      expect(found[0]!.actor_id).toBe(adminId);
    });

    it('auth.logout records one row', async () => {
      await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);
      const found = await rows('auth.logout');
      expect(found).toHaveLength(1);
      expect(found[0]!.actor_id).toBe(adminId);
    });

    it('user.password_change records one row and no password', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/me/password')
        .set('Cookie', cookie)
        .send({ old_password: 'admin-password-123', new_password: 'a-brand-new-secret-9' })
        .expect(204);
      const found = await rows('user.password_change');
      expect(found).toHaveLength(1);
      expect(JSON.stringify(found[0])).not.toContain('admin-password-123');
      expect(JSON.stringify(found[0])).not.toContain('a-brand-new-secret-9');
    });
  });

  describe('failed sign-in', () => {
    const WRONG_PASSWORD = 'not-the-password-3141';

    async function failLogin(username: string): Promise<void> {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username, password: WRONG_PASSWORD })
        .expect(401);
    }

    it('records the attempt without the password', async () => {
      await failLogin('admin');
      const found = await rows('auth.login_failed');
      expect(found).toHaveLength(1);
      const raw = JSON.stringify(found[0]);
      expect(raw).not.toContain(WRONG_PASSWORD);
      expect(raw).not.toContain('password');
      expect(JSON.parse(found[0]!.payload_json!)).toEqual({
        username_attempted: 'admin',
        ip: expect.anything(),
        throttled: false,
      });
    });

    it('is not an existence oracle — the row is the same shape for a real and an unknown account', async () => {
      await failLogin('admin');
      await failLogin('definitely-not-a-user');
      const found = await rows('auth.login_failed');
      expect(found).toHaveLength(2);

      // The distinguishing fact would be a resolved actor. There is never one.
      expect(found.map((r) => r.actor_id)).toEqual([null, null]);
      expect(found.map((r) => r.page_id)).toEqual([null, null]);

      const [real, unknown] = found.map((r) => JSON.parse(r.payload_json!));
      // Identical key sets: nothing in the payload varies with whether the
      // account exists, only the attacker's own input echoed back.
      expect(Object.keys(real).sort()).toEqual(Object.keys(unknown).sort());
      expect(real.username_attempted).toBe('admin');
      expect(unknown.username_attempted).toBe('definitely-not-a-user');
    });

    it('normalizes and caps the attempted username', async () => {
      await failLogin(`  MiXeD${'x'.repeat(200)}  `);
      const payload = await payloadOf('auth.login_failed');
      expect(payload.username_attempted).toHaveLength(64);
      expect(payload.username_attempted).toBe(payload.username_attempted.toLowerCase());
    });

    it('marks the failure that filled the throttle, and records the refusal separately', async () => {
      for (let i = 0; i < 6; i++) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ username: 'throttle-me', password: WRONG_PASSWORD });
      }
      // The 6th attempt is refused before the password is checked (issue 41), so
      // it is not a failed sign-in: five failures, then one throttled refusal.
      const found = await rows('auth.login_failed');
      expect(found).toHaveLength(5);
      const throttled = found.map((r) => JSON.parse(r.payload_json!).throttled);
      expect(throttled).toEqual([false, false, false, false, true]);
      expect(await rows('auth.login_throttled')).toHaveLength(1);
    });
  });

  describe('accounts', () => {
    it('user.create records the acting admin and the new account', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/users')
        .set('Cookie', cookie)
        .send({ email: 'new@example.com', username: 'newbie', password: 'a-good-password-1', role: 'user' })
        .expect(201);
      const found = await rows('user.create');
      expect(found).toHaveLength(1);
      expect(found[0]!.actor_id).toBe(adminId);
      expect(JSON.parse(found[0]!.payload_json!)).toMatchObject({ username: 'newbie', role: 'user' });
      expect(JSON.stringify(found[0])).not.toContain('a-good-password-1');
    });

    it('user.role_change records both sides of the promotion', async () => {
      const { userId } = await seedUserAndLogin(app, 'climber');
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/users/${userId}`)
        .set('Cookie', cookie)
        .send({ role: 'admin' })
        .expect(200);
      const found = await rows('user.role_change');
      expect(found).toHaveLength(1);
      expect(found[0]!.actor_id).toBe(adminId);
      expect(JSON.parse(found[0]!.payload_json!)).toMatchObject({
        user_id: userId,
        username: 'climber',
        from: 'user',
        to: 'admin',
      });
    });

    it('a no-op role write records nothing', async () => {
      const { userId } = await seedUserAndLogin(app, 'unchanged');
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/users/${userId}`)
        .set('Cookie', cookie)
        .send({ role: 'user' })
        .expect(200);
      expect(await rows('user.role_change')).toHaveLength(0);
    });

    it('user.disable records the disable and the re-enable', async () => {
      const { userId } = await seedUserAndLogin(app, 'onoff');
      for (const disabled of [true, false]) {
        await request(app.getHttpServer())
          .patch(`/api/v1/admin/users/${userId}`)
          .set('Cookie', cookie)
          .send({ disabled })
          .expect(200);
      }
      const found = await rows('user.disable');
      expect(found.map((r) => JSON.parse(r.payload_json!).disabled)).toEqual([true, false]);
    });

    it('user.password_reset never carries the temporary password', async () => {
      const { userId } = await seedUserAndLogin(app, 'forgetful');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${userId}/reset-password`)
        .set('Cookie', cookie)
        .expect(201);
      const found = await rows('user.password_reset');
      expect(found).toHaveLength(1);
      expect(found[0]!.actor_id).toBe(adminId);
      expect(JSON.stringify(found[0])).not.toContain(res.body.temporary_password);
      // The target account by name, so the audit page need not look it up.
      expect(JSON.parse(found[0]!.payload_json!)).toEqual({ user_id: userId, username: 'forgetful' });
    });
  });

  describe('tokens', () => {
    it('token.create records the token identity, never the token', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/me/tokens')
        .set('Cookie', cookie)
        .send({ name: 'ci', scope: 'write', expires_in_days: 30 })
        .expect(201);
      const found = await rows('token.create');
      expect(found).toHaveLength(1);
      expect(found[0]!.actor_id).toBe(adminId);
      const payload = JSON.parse(found[0]!.payload_json!);
      // The id has to survive `redact()` for the row to be matchable at all.
      expect(payload.id).toBe(res.body.id);
      expect(payload.scope).toBe('write');
      expect(JSON.stringify(found[0])).not.toContain(res.body.token);
    });

    it('token.revoke records the revocation from both doors', async () => {
      const mine = await request(app.getHttpServer())
        .post('/api/v1/me/tokens')
        .set('Cookie', cookie)
        .send({ name: 'self', scope: 'read', expires_in_days: 30 })
        .expect(201);
      await request(app.getHttpServer())
        .delete(`/api/v1/me/tokens/${mine.body.id}`)
        .set('Cookie', cookie)
        .expect(204);

      const { cookie: userCookie } = await seedUserAndLogin(app, 'tokenholder');
      const theirs = await request(app.getHttpServer())
        .post('/api/v1/me/tokens')
        .set('Cookie', userCookie)
        .send({ name: 'theirs', scope: 'read', expires_in_days: 30 })
        .expect(201);
      await request(app.getHttpServer())
        .delete(`/api/v1/admin/tokens/${theirs.body.id}`)
        .set('Cookie', cookie)
        .expect(204);

      const found = await rows('token.revoke');
      expect(found).toHaveLength(2);
      const payloads = found.map((r) => JSON.parse(r.payload_json!));
      expect(payloads.map((p) => p.self)).toEqual([true, false]);
      // Which token and whose, by name: the owner revoking their own, then an
      // admin revoking somebody else's.
      expect(payloads[0]).toEqual({ id: mine.body.id, self: true, token_name: 'self', owner_username: 'admin' });
      expect(payloads[1]).toEqual({ id: theirs.body.id, self: false, token_name: 'theirs', owner_username: 'tokenholder' });
      // Names only: no part of either secret.
      for (const row of found) {
        expect(row.payload_json).not.toContain(mine.body.token);
        expect(row.payload_json).not.toContain(theirs.body.token);
        expect(row.payload_json).not.toContain(theirs.body.token.slice(0, 8));
      }
    });
  });

  describe('instance configuration', () => {
    it('config.read_access_change records both sides of the public-read toggle', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/admin/access')
        .set('Cookie', cookie)
        .send({ read_mode: 'authenticated' })
        .expect(200);
      const found = await rows('config.read_access_change');
      expect(found).toHaveLength(1);
      expect(found[0]!.actor_id).toBe(adminId);
      expect(JSON.parse(found[0]!.payload_json!)).toEqual({ from: 'public', to: 'authenticated' });
    });

    it('config.password_policy records the change', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/admin/auth/password-policy')
        .set('Cookie', cookie)
        .send({ min_length: 12, require_number: true, require_symbol: false, require_uppercase: false })
        .expect(200);
      const found = await rows('config.password_policy');
      expect(found).toHaveLength(1);
      expect(JSON.parse(found[0]!.payload_json!).to).toMatchObject({ min_length: 12 });
    });

    it('config.token_policy records the change under a key redact() keeps', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/admin/auth/token-policy')
        .set('Cookie', cookie)
        .send({ max_days: 90 })
        .expect(200);
      const found = await rows('config.token_policy');
      expect(found).toHaveLength(1);
      expect(JSON.parse(found[0]!.payload_json!)).toEqual({ from_max_days: null, to_max_days: 90 });
    });
  });

  describe('source registry', () => {
    it('source.upsert records the mode transition and the env var NAME, never a token', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/admin/sources/topic:audited')
        .set('Cookie', cookie)
        .send({ local_dir: 'audited', mode: 'read-only' })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/admin/sources/topic:audited')
        .set('Cookie', cookie)
        .send({ mode: 'direct', host_token_env: 'E3_AUDITED_TOKEN' })
        .expect(200);

      const found = await rows('source.upsert');
      expect(found).toHaveLength(2);
      expect(found.every((r) => r.actor_id === adminId)).toBe(true);
      const [created, changed] = found.map((r) => JSON.parse(r.payload_json!));
      expect(created).toMatchObject({ id: 'topic:audited', created: true, mode_to: 'read-only' });
      // read-only -> direct is the change a security question is about.
      expect(changed).toMatchObject({ created: false, mode_from: 'read-only', mode_to: 'direct' });
      expect(changed.host_env_var).toBe('E3_AUDITED_TOKEN');
    });

    it('source.remove records the removal', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/admin/sources/topic:doomed')
        .set('Cookie', cookie)
        .send({ local_dir: 'doomed', mode: 'read-only' })
        .expect(200);
      await request(app.getHttpServer())
        .delete('/api/v1/admin/sources/topic:doomed')
        .set('Cookie', cookie)
        .expect(200);
      const found = await rows('source.remove');
      expect(found).toHaveLength(1);
      expect(JSON.parse(found[0]!.payload_json!)).toMatchObject({ id: 'topic:doomed', mode: 'read-only' });
    });
  });

  describe('bulk data movement', () => {
    it('okf.export records who downloaded the library', async () => {
      await request(app.getHttpServer()).get('/api/v1/okf/export').set('Cookie', cookie).expect(200);
      const found = await rows('okf.export');
      expect(found).toHaveLength(1);
      expect(found[0]!.actor_id).toBe(adminId);
      expect(JSON.parse(found[0]!.payload_json!).format).toBe('json');
    });

    it('okf.import records a successful import', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/okf/import')
        .set('Cookie', cookie)
        .send({
          files: [
            {
              path: 'concepts/imported.md',
              content: '---\ntitle: Imported\ntype: concept\n---\n\nSome body text for the imported concept.\n',
            },
          ],
        })
        .expect(201);
      const found = await rows('okf.import');
      expect(found).toHaveLength(1);
      expect(found[0]!.actor_id).toBe(adminId);
      expect(JSON.parse(found[0]!.payload_json!).format).toBe('json');
    });

    it('okf.import_rejected records an import the gate refused', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/okf/import')
        .set('Cookie', cookie)
        .send({ files: [{ path: 'concepts/broken.md', content: 'no frontmatter at all' }] })
        .expect(422);
      const found = await rows('okf.import_rejected');
      expect(found).toHaveLength(1);
      expect(found[0]!.actor_id).toBe(adminId);
      // The rejected bundle's content is never copied into the log.
      expect(JSON.stringify(found[0])).not.toContain('no frontmatter at all');
      expect(await rows('okf.import')).toHaveLength(0);
    });
  });
});
