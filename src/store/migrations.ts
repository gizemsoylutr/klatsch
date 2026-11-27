// Append only. Each entry runs once, in order, inside a transaction.
export const migrations: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE circles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE memberships (
    circle_id TEXT NOT NULL REFERENCES circles(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    invited_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (circle_id, user_id)
  );

  CREATE TABLE tags (
    slug TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    parent TEXT REFERENCES tags(slug)
  );

  CREATE TABLE tag_aliases (
    alias TEXT PRIMARY KEY,
    slug TEXT NOT NULL REFERENCES tags(slug)
  );

  -- A sip is one line on a person's card: a status, tags and a short summary.
  CREATE TABLE sips (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    circle_id TEXT NOT NULL REFERENCES circles(id),
    status TEXT NOT NULL CHECK (status IN ('looking', 'solved', 'want-to-discuss')),
    summary TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('draft', 'approved', 'rejected', 'retired')),
    flags TEXT NOT NULL DEFAULT '[]',
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    approved_at INTEGER
  );

  CREATE TABLE sip_tags (
    sip_id TEXT NOT NULL REFERENCES sips(id) ON DELETE CASCADE,
    slug TEXT NOT NULL REFERENCES tags(slug),
    PRIMARY KEY (sip_id, slug)
  );

  CREATE TABLE matches (
    id TEXT PRIMARY KEY,
    seeker_id TEXT NOT NULL REFERENCES users(id),
    sip_id TEXT NOT NULL REFERENCES sips(id),
    tags TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (seeker_id, sip_id)
  );

  CREATE TABLE intros (
    id TEXT PRIMARY KEY,
    match_id TEXT NOT NULL UNIQUE REFERENCES matches(id),
    state TEXT NOT NULL CHECK (state IN ('awaiting-seeker', 'awaiting-solver', 'accepted', 'declined')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Events carry a kind and a reference only; text is rendered from templates.
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );

  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE web_logins (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE web_sessions (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    csrf TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user_id TEXT,
    via TEXT NOT NULL CHECK (via IN ('mcp', 'web', 'cli')),
    action TEXT NOT NULL,
    ref TEXT
  );

  CREATE INDEX sips_by_user ON sips (user_id, state);
  CREATE INDEX sip_tags_by_slug ON sip_tags (slug);
  CREATE INDEX events_by_user ON events (user_id, read_at);
  `,
  // An intro is tied to the seeker's approved looking sip, so the solver sees what it is about before accepting.
  `
  ALTER TABLE intros ADD COLUMN seeker_sip_id TEXT REFERENCES sips(id);
  `,
  // Chat approvals: a PIN only the human knows, and 'dialog' as an audit channel.
  `
  ALTER TABLE users ADD COLUMN pin_hash TEXT;
  ALTER TABLE users ADD COLUMN pin_failures INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE audit_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user_id TEXT,
    via TEXT NOT NULL CHECK (via IN ('mcp', 'web', 'cli', 'dialog')),
    action TEXT NOT NULL,
    ref TEXT
  );
  INSERT INTO audit_v3 SELECT * FROM audit;
  DROP TABLE audit;
  ALTER TABLE audit_v3 RENAME TO audit;
  `,
  // Approvals by code (RFC 8628 style) replace the PIN: an agent asks, the human enters the code
  // in their own web session and approves exactly that action.
  `
  ALTER TABLE users DROP COLUMN pin_hash;
  ALTER TABLE users DROP COLUMN pin_failures;

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL CHECK (action IN ('share_sip', 'send_intro', 'answer_intro')),
    payload TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'declined')),
    result TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX approvals_by_user ON approvals (user_id, state);
  `,
  // Which directory or client a token was made for, so reconnecting replaces it instead of piling up.
  `
  ALTER TABLE tokens ADD COLUMN label TEXT;
  `,
  // The seeker no longer confirms an intro after the agent asked (an approval does that first), so
  // intros left waiting for that confirmation could never move on.
  `
  DELETE FROM events WHERE kind LIKE 'intro.%' AND ref IN (SELECT id FROM intros WHERE state = 'awaiting-seeker');
  DELETE FROM intros WHERE state = 'awaiting-seeker';
  `,
  // Circles grow by invite: single use, stored only as a keyed hash. The owner may remove members.
  // Every existing circle gets exactly one owner: its first uninvited member, else its first member.
  `
  ALTER TABLE memberships ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member'));
  UPDATE memberships SET role = 'owner'
  WHERE rowid = (
    SELECT m.rowid FROM memberships m WHERE m.circle_id = memberships.circle_id
    ORDER BY m.invited_by IS NOT NULL, m.created_at, m.rowid LIMIT 1
  );

  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    circle_id TEXT NOT NULL REFERENCES circles(id),
    created_by TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_by TEXT REFERENCES users(id),
    used_at INTEGER
  );
  `,
  // Email notifications, content-free like the desktop ones; on by default once an address is known.
  `
  ALTER TABLE users ADD COLUMN email TEXT;
  ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1 CHECK (notify_email IN (0, 1));
  `,
  // A removal sticks: only the circle's owner can invite a removed person back.
  `
  CREATE TABLE removals (
    circle_id TEXT NOT NULL REFERENCES circles(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    removed_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (circle_id, user_id)
  );
  `,
  // Email goes only to a confirmed address. A confirmation link is single use, 24 hours, stored only as a keyed hash.
  `
  ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
  CREATE TABLE email_confirmations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  `,
  // A handle is an identifier, never free text (an agent may learn it after an accepted intro). New and
  // changed handles only: rows from before stay, and the service never hands such a handle to an agent.
  `
  CREATE TRIGGER users_handle_insert BEFORE INSERT ON users
  WHEN NOT (length(NEW.handle) BETWEEN 1 AND 39 AND NEW.handle GLOB '[a-z0-9]*' AND NEW.handle NOT GLOB '*[^a-z0-9-]*')
  BEGIN SELECT RAISE(ABORT, 'invalid handle'); END;
  CREATE TRIGGER users_handle_update BEFORE UPDATE OF handle ON users
  WHEN NOT (length(NEW.handle) BETWEEN 1 AND 39 AND NEW.handle GLOB '[a-z0-9]*' AND NEW.handle NOT GLOB '*[^a-z0-9-]*')
  BEGIN SELECT RAISE(ABORT, 'invalid handle'); END;
  `,
  // Watches: an agent waiting for news for its human (an MCP task). Persisted, so a client can ask about one
  // after a reconnect or a relay restart; at most one working watch per token.
  `
  CREATE TABLE watches (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_id TEXT NOT NULL REFERENCES tokens(id),
    status TEXT NOT NULL CHECK (status IN ('working', 'completed', 'cancelled')),
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX watches_one_working_per_token ON watches (token_id) WHERE status = 'working';
  CREATE INDEX watches_by_user ON watches (user_id, status);
  `,
  // News that arrives while no watch runs is not lost: per token, the last wake event a watch reported.
  `
  CREATE TABLE watch_marks (
    token_id TEXT PRIMARY KEY REFERENCES tokens(id),
    event_id INTEGER NOT NULL
  );
  CREATE INDEX watches_finished ON watches (status, updated_at);
  `,
  // Hand-offs: the other person's sip, sent by the human to their own agent after an accepted intro.
  // The text is a snapshot taken at the click and cleared once the agent has read it.
  `
  CREATE TABLE handoffs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    from_user_id TEXT NOT NULL REFERENCES users(id),
    intro_id TEXT NOT NULL REFERENCES intros(id),
    sip_id TEXT NOT NULL REFERENCES sips(id),
    text TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX handoffs_by_user ON handoffs (user_id, created_at);
  `,
  // Which events wake a watch (news from someone else, not the person's own action), and when an intro
  // was accepted (the other side's sip is readable for a while after that).
  `
  ALTER TABLE events ADD COLUMN wakes INTEGER NOT NULL DEFAULT 0 CHECK (wakes IN (0, 1));
  UPDATE events SET wakes = 1 WHERE kind IN ('match.new', 'intro.requested', 'intro.accepted', 'intro.declined', 'quote.received');
  CREATE INDEX events_wakes ON events (user_id, wakes, id);
  ALTER TABLE intros ADD COLUMN accepted_at INTEGER;
  UPDATE intros SET accepted_at = updated_at WHERE state = 'accepted';
  `,
  // Standing consent. A solved sip is open to the circle or asks first; sips from before stay "ask"
  // (their authors approved them under the intro model). Grants are per person: "show" lets the grantee
  // see the grantor's notes on the grant's tags that are approved after it, without asking (one per allowed
  // intro); "deliver" sends the grantee's readable notes to the grantor's agent. A match is backed by the
  // seeker's own approved looking sip when their human's share made it (a search by an agent backs nothing).
  // Hand-offs may now come from an open note (no intro), and may be automatic.
  `
  ALTER TABLE sips ADD COLUMN visibility TEXT NOT NULL DEFAULT 'ask' CHECK (visibility IN ('open', 'ask'));
  ALTER TABLE matches ADD COLUMN seeker_sip_id TEXT REFERENCES sips(id);
  CREATE TABLE grants (
    id TEXT PRIMARY KEY,
    grantor_id TEXT NOT NULL REFERENCES users(id),
    grantee_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('show', 'deliver')),
    tags TEXT,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE UNIQUE INDEX grants_deliver_live ON grants (grantor_id, grantee_id) WHERE kind = 'deliver' AND revoked_at IS NULL;
  CREATE INDEX grants_by_pair ON grants (grantor_id, grantee_id, kind);
  CREATE TABLE handoffs_v2 (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    from_user_id TEXT NOT NULL REFERENCES users(id),
    intro_id TEXT REFERENCES intros(id),
    sip_id TEXT NOT NULL REFERENCES sips(id),
    text TEXT,
    auto INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0, 1)),
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  INSERT INTO handoffs_v2 (id, user_id, from_user_id, intro_id, sip_id, text, created_at, delivered_at)
    SELECT id, user_id, from_user_id, intro_id, sip_id, text, created_at, delivered_at FROM handoffs;
  DROP TABLE handoffs;
  ALTER TABLE handoffs_v2 RENAME TO handoffs;
  CREATE INDEX handoffs_by_user ON handoffs (user_id, created_at);
  CREATE INDEX handoffs_by_sip ON handoffs (user_id, sip_id);
  `,
  // Sign in with GitHub: a person is found by GitHub's numeric user id, which survives a renamed login;
  // never by login or email. The login is kept only to show the person which GitHub account is connected.
  // No access token is kept.
  `
  ALTER TABLE users ADD COLUMN github_id INTEGER CHECK (github_id IS NULL OR github_id > 0);
  ALTER TABLE users ADD COLUMN github_login TEXT;
  CREATE UNIQUE INDEX users_by_github_id ON users (github_id) WHERE github_id IS NOT NULL;
  `,
  // What a token serves, as `klatsch connect` records it, for the Tokens page: the agent clients (a JSON array of
  // client names) and the project folder's name only, never its path.
  `
  ALTER TABLE tokens ADD COLUMN clients TEXT;
  ALTER TABLE tokens ADD COLUMN project TEXT;
  `,
  // "Thanks, this helped": a human's click for a note that reached them or an intro they are part of. One per
  // thanker and note or intro; never to oneself. The author sees only how many people thanked them. `badge_id`:
  // the random id of a person's public badge while they show one (null when off; a new one each time it is turned on).
  `
  CREATE TABLE thanks (
    id TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL REFERENCES users(id),
    to_user_id TEXT NOT NULL REFERENCES users(id),
    sip_id TEXT REFERENCES sips(id),
    intro_id TEXT REFERENCES intros(id),
    created_at INTEGER NOT NULL,
    CHECK (from_user_id != to_user_id),
    CHECK ((sip_id IS NULL) != (intro_id IS NULL))
  );
  CREATE UNIQUE INDEX thanks_once_per_sip ON thanks (from_user_id, sip_id) WHERE sip_id IS NOT NULL;
  CREATE UNIQUE INDEX thanks_once_per_intro ON thanks (from_user_id, intro_id) WHERE intro_id IS NOT NULL;
  CREATE INDEX thanks_to ON thanks (to_user_id, created_at);
  ALTER TABLE users ADD COLUMN badge_id TEXT;
  CREATE UNIQUE INDEX users_by_badge ON users (badge_id) WHERE badge_id IS NOT NULL;
  `,
  // The agent may say thanks too, for a note a quote brought it, when the note fixed the problem. `given_by`:
  // who gave a thanks (the human's click or their agent). `agent_thanks`: the person lets their agent do it
  // (on unless they turn it off). `thanks_undone`: notes whose agent thanks the person took back, so the agent
  // cannot give it again; `thanked_at` keeps an undone thanks in the agent's daily limit. Tokens that could
  // read the inbox (where the quote to thank comes from) get the new `thanks:write` scope.
  `
  ALTER TABLE thanks ADD COLUMN given_by TEXT NOT NULL DEFAULT 'human' CHECK (given_by IN ('human', 'agent'));
  ALTER TABLE users ADD COLUMN agent_thanks INTEGER NOT NULL DEFAULT 1 CHECK (agent_thanks IN (0, 1));
  CREATE TABLE thanks_undone (
    user_id TEXT NOT NULL REFERENCES users(id),
    sip_id TEXT NOT NULL REFERENCES sips(id),
    thanked_at INTEGER NOT NULL,
    undone_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, sip_id)
  );
  CREATE INDEX thanks_by_giver ON thanks (from_user_id, given_by, created_at);
  UPDATE tokens SET scopes = json_insert(scopes, '$[#]', 'thanks:write')
    WHERE EXISTS (SELECT 1 FROM json_each(tokens.scopes) WHERE value = 'inbox:read')
      AND NOT EXISTS (SELECT 1 FROM json_each(tokens.scopes) WHERE value = 'thanks:write');
  `,
  // Link cards: a solved sip may carry one public source (link, title, author as the sharer wrote them; never
  // fetched). A quote snapshots it with the text and clears it with the text.
  // Commons: a circle may have a public join link (`join_token`: random, or a short name the operator set; null
  // while off) and a cap. `public` stays 1 once a link was on, since strangers are in it from then on.
  // Scope: the circles a sip matches in (`sip_circles`), and per circle whether an open note is readable there
  // without an intro (`open`). Sips from before keep exactly the one circle they were shared in, open there
  // only if they were open; a circle that goes public loses every sip shared in it before.
  // An "allow always" (`show` grant) holds in one circle, where its intro happened; grants from before get the
  // first circle the two people shared (all circles were private then).
  `
  ALTER TABLE sips ADD COLUMN source_url TEXT;
  ALTER TABLE sips ADD COLUMN source_title TEXT;
  ALTER TABLE sips ADD COLUMN source_author TEXT;
  ALTER TABLE handoffs ADD COLUMN source_url TEXT;
  ALTER TABLE handoffs ADD COLUMN source_title TEXT;
  ALTER TABLE handoffs ADD COLUMN source_author TEXT;
  ALTER TABLE circles ADD COLUMN public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1));
  ALTER TABLE circles ADD COLUMN join_token TEXT;
  ALTER TABLE circles ADD COLUMN join_cap INTEGER CHECK (join_cap IS NULL OR join_cap > 0);
  CREATE UNIQUE INDEX circles_by_join_token ON circles (join_token) WHERE join_token IS NOT NULL;
  CREATE TABLE sip_circles (
    sip_id TEXT NOT NULL REFERENCES sips(id),
    circle_id TEXT NOT NULL REFERENCES circles(id),
    open INTEGER NOT NULL DEFAULT 0 CHECK (open IN (0, 1)),
    PRIMARY KEY (sip_id, circle_id)
  );
  CREATE INDEX sip_circles_by_circle ON sip_circles (circle_id, sip_id);
  INSERT INTO sip_circles (sip_id, circle_id, open)
    SELECT id, circle_id, CASE WHEN visibility = 'open' AND status = 'solved' THEN 1 ELSE 0 END FROM sips WHERE state != 'draft';
  ALTER TABLE grants ADD COLUMN circle_id TEXT REFERENCES circles(id);
  UPDATE grants SET circle_id = (
    SELECT a.circle_id FROM memberships a JOIN memberships b ON b.circle_id = a.circle_id AND b.user_id = grants.grantee_id
    WHERE a.user_id = grants.grantor_id ORDER BY a.created_at, a.circle_id LIMIT 1
  ) WHERE kind = 'show';
  `,
  // Sign-in links by email, for people without GitHub: random, stored only as a keyed hash, ten minutes, single
  // use. Each is bound to the address it went to (in lower case), to the browser that asked (a keyed hash of its
  // form cookie's value) and, for an address nobody here has, to the invite (by id) or public join link it was asked
  // for. A person is found by their confirmed address, compared in lower case. `mailbox` is that address as the
  // mailbox it reaches (lower case, no +tag, Gmail without dots): one mailbox makes at most one person by email.
  // `mailbox_history` keeps every mailbox a person ever confirmed, never cleared, so a removal sticks to the mailbox;
  // only as a keyed hash with the server secret, which SQL here does not have: the relay fills it when it starts.
  `
  CREATE TABLE email_logins (
    hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    nonce_hash TEXT NOT NULL,
    known INTEGER NOT NULL DEFAULT 0 CHECK (known IN (0, 1)),
    join_kind TEXT CHECK (join_kind IN ('invite', 'public')),
    join_ref TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    CHECK ((join_kind IS NULL) = (join_ref IS NULL))
  );
  CREATE INDEX email_logins_by_email ON email_logins (email, created_at);
  CREATE INDEX email_logins_by_join ON email_logins (join_ref, created_at) WHERE join_ref IS NOT NULL;
  CREATE INDEX email_logins_by_time ON email_logins (created_at);
  CREATE INDEX users_by_confirmed_email ON users (lower(email)) WHERE email_verified_at IS NOT NULL;
  ALTER TABLE users ADD COLUMN mailbox TEXT;
  UPDATE users SET mailbox = lower(email) WHERE email IS NOT NULL AND email_verified_at IS NOT NULL;
  UPDATE users SET mailbox = substr(mailbox, 1, instr(mailbox, '+') - 1) || substr(mailbox, instr(mailbox, '@')) WHERE instr(mailbox, '+') > 0;
  UPDATE users SET mailbox = replace(substr(mailbox, 1, instr(mailbox, '@') - 1), '.', '') || '@gmail.com'
    WHERE substr(mailbox, instr(mailbox, '@') + 1) IN ('gmail.com', 'googlemail.com');
  CREATE INDEX users_by_mailbox ON users (mailbox) WHERE mailbox IS NOT NULL;
  CREATE TABLE mailbox_history (
    user_id TEXT NOT NULL REFERENCES users(id),
    mailbox_hash TEXT NOT NULL,
    PRIMARY KEY (mailbox_hash, user_id)
  );
  `,
  // Sessions last 30 days from their last use, at most 90 from sign-in; older ones keep the end they had.
  `
  ALTER TABLE web_sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
  UPDATE web_sessions SET created_at = expires_at - 7776000000;
  CREATE INDEX web_sessions_by_user ON web_sessions (user_id);
  `,
  // Passkeys: only the public key and what checking a sign-in needs. Discoverable, so the browser offers them
  // without a name typed first; the person behind one is found by its credential id.
  `
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]',
    synced INTEGER NOT NULL DEFAULT 0 CHECK (synced IN (0, 1)),
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX passkeys_by_user ON passkeys (user_id);
  `,
  // A six-digit code beside the sign-in link, typed in the browser that asked; five wrong ones end the link.
  `
  ALTER TABLE email_logins ADD COLUMN code_hash TEXT;
  ALTER TABLE email_logins ADD COLUMN code_tries INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX email_logins_by_browser ON email_logins (nonce_hash, created_at);
  `,
  // Home offers to save a passkey once; "Not now" keeps it away (Settings still has "Add a passkey").
  `
  ALTER TABLE users ADD COLUMN passkey_offer_dismissed_at INTEGER;
  ALTER TABLE web_sessions ADD COLUMN offer_pending INTEGER NOT NULL DEFAULT 0 CHECK (offer_pending IN (0, 1));
  `,
  // "klatsch connect" without a token: a command waits, a person types its code in their session (RFC 8628).
  // The token is made when the command collects it, so it is never stored; only keyed hashes of the codes are.
  `
  CREATE TABLE connect_requests (
    id TEXT PRIMARY KEY,
    device_hash TEXT NOT NULL UNIQUE,
    code_hash TEXT NOT NULL UNIQUE,
    client TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'declined', 'collected')),
    user_id TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  // A "tried" sip: stored as a note like a solved one (same matching and consent), marked as not a fix.
  `
  ALTER TABLE sips ADD COLUMN failed INTEGER NOT NULL DEFAULT 0 CHECK (failed IN (0, 1));
  `,
  // "Still works": when the author last said a note still holds. Readers see it; old notes ask the author on Home.
  `
  ALTER TABLE sips ADD COLUMN checked_at INTEGER;
  `,
  // Semantic matching (off unless the operator turns it on): one summary as numbers, gone with the sip's readability.
  `
  CREATE TABLE sip_vectors (
    sip_id TEXT PRIMARY KEY REFERENCES sips(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    vector BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // Sealed payloads never compare equal, so "the same ask again" compares a keyed hash instead.
  `
  ALTER TABLE approvals ADD COLUMN payload_key TEXT;
  `,
  // Sign in with Google: a person is found by Google's `sub` only, never by address.
  `
  ALTER TABLE users ADD COLUMN google_sub TEXT;
  ALTER TABLE users ADD COLUMN google_email TEXT;
  CREATE UNIQUE INDEX users_by_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;
  `,
  // The Notes page: a note shows there only where its author ticked that. Notes from before stay off it: they were
  // shared on the promise that only someone stuck on the same thing reads them.
  `
  ALTER TABLE sip_circles ADD COLUMN feed INTEGER NOT NULL DEFAULT 0 CHECK (feed IN (0, 1));
  `,
  // Asking one person directly: an approval of its own kind, and the question and its answer, sealed like a sip.
  `
  CREATE TABLE approvals_v2 (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL CHECK (action IN ('share_sip', 'send_intro', 'answer_intro', 'ask_person', 'answer_ask')),
    payload TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'declined')),
    result TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER,
    payload_key TEXT
  );
  INSERT INTO approvals_v2 (id, user_id, code_hash, action, payload, state, result, created_at, expires_at, decided_at, payload_key)
    SELECT id, user_id, code_hash, action, payload, state, result, created_at, expires_at, decided_at, payload_key FROM approvals;
  DROP TABLE approvals;
  ALTER TABLE approvals_v2 RENAME TO approvals;
  CREATE INDEX approvals_by_user ON approvals (user_id, state);
  CREATE TABLE asks (
    id TEXT PRIMARY KEY,
    asker_id TEXT NOT NULL REFERENCES users(id),
    helper_id TEXT NOT NULL REFERENCES users(id),
    question TEXT NOT NULL,
    tags TEXT NOT NULL,
    answer TEXT,
    answer_failed INTEGER NOT NULL DEFAULT 0 CHECK (answer_failed IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('open', 'answered', 'declined', 'withdrawn')),
    question_for_agent INTEGER NOT NULL DEFAULT 0 CHECK (question_for_agent IN (0, 1)),
    answer_for_agent INTEGER NOT NULL DEFAULT 0 CHECK (answer_for_agent IN (0, 1)),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    answered_at INTEGER,
    CHECK (asker_id != helper_id)
  );
  CREATE INDEX asks_by_helper ON asks (helper_id, state);
  CREATE INDEX asks_by_asker ON asks (asker_id, state);
  `,
  // OAuth for MCP clients that cannot be given a token (ChatGPT, claude.ai): registered public clients, one-time
  // codes and rotating refresh tokens, stored as keyed hashes. The access token is an ordinary row in tokens.
  `
  CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_codes (
    hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    token_id TEXT REFERENCES tokens(id),
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE oauth_refresh (
    hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id),
    token_id TEXT NOT NULL REFERENCES tokens(id),
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX oauth_refresh_by_token ON oauth_refresh (token_id);
  `,
  // Friends: a private circle of exactly two, made by "Add a friend". Asks need no tags (a friend is asked
  // about anything), and an answer goes to the asker's agent at once: the asker's agent asked it.
  `
  ALTER TABLE circles ADD COLUMN pair INTEGER NOT NULL DEFAULT 0 CHECK (pair IN (0, 1));
  ALTER TABLE circles ADD COLUMN ended_at INTEGER;
  `,
  // Cards in the chat (MCP Apps): a one-time key that only Klatsch's card in the chat receives, never the model,
  // for one decision on one approval, or one answer to one question. Stored as a keyed hash.
  `
  CREATE TABLE app_keys (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('approval', 'ask')),
    ref TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX app_keys_by_user ON app_keys (user_id);
  `,
  // Web Push: a browser's subscription per device, for content-free notifications ("Something new in your circle").
  `
  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX push_subscriptions_by_user ON push_subscriptions (user_id);
  `,
  // A card key may also make a friend link: the link is made by the person's click and shown in the card only.
  `
  CREATE TABLE app_keys_v2 (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('approval', 'ask', 'friend')),
    ref TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  INSERT INTO app_keys_v2 SELECT hash, user_id, kind, ref, expires_at, used_at FROM app_keys;
  DROP TABLE app_keys;
  ALTER TABLE app_keys_v2 RENAME TO app_keys;
  CREATE INDEX app_keys_by_user ON app_keys (user_id);
  `,
  // Two friend links between the same two people made two friendships: keep the oldest, close the rest.
  `
  UPDATE circles SET ended_at = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE pair = 1 AND ended_at IS NULL AND id IN (
    SELECT c.id FROM circles c
    JOIN memberships a ON a.circle_id = c.id JOIN memberships b ON b.circle_id = c.id AND b.user_id > a.user_id
    WHERE c.pair = 1 AND c.ended_at IS NULL AND EXISTS (
      SELECT 1 FROM circles o JOIN memberships oa ON oa.circle_id = o.id AND oa.user_id = a.user_id JOIN memberships ob ON ob.circle_id = o.id AND ob.user_id = b.user_id
      WHERE o.pair = 1 AND o.ended_at IS NULL AND (o.created_at < c.created_at OR (o.created_at = c.created_at AND o.id < c.id))
    )
  );
  `,
  // "Not now" to Home's offer of notifications on this device: it is not shown again.
  `
  ALTER TABLE users ADD COLUMN push_offer_dismissed_at INTEGER;
  `,
  // A card shown again (the chat reloaded) asks whether it was already decided, and shows what came of it.
  `
  ALTER TABLE app_keys ADD COLUMN outcome TEXT;
  `,
  // Review accounts: a password for the one account the operator names (directory reviewers need one), and a
  // demo friend that answers at once, so a reviewer can try the whole flow alone.
  `
  ALTER TABLE users ADD COLUMN password_hash TEXT;
  ALTER TABLE users ADD COLUMN demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1));
  `,
  // Files with a direct question or its answer (a voice note, a photo, a PDF): sealed, small, gone with the question.
  `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    ask_id TEXT NOT NULL REFERENCES asks(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    side TEXT NOT NULL CHECK (side IN ('question', 'answer')),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_by_ask ON attachments (ask_id);
  CREATE INDEX attachments_by_user ON attachments (user_id, created_at);
  `,
  // Messages between two friends: one conversation per friendship, each message sealed, gone with the friendship
  // or after 90 days. A message from the friend reaches the person's agent only by their click or their "always".
  // A card key may also keep a conversation open in the chat; sending a message is an approval of its own.
  `
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    circle_id TEXT NOT NULL REFERENCES circles(id),
    sender_id TEXT NOT NULL REFERENCES users(id),
    recipient_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    for_agent INTEGER NOT NULL DEFAULT 0 CHECK (for_agent IN (0, 1)),
    CHECK (sender_id != recipient_id)
  );
  CREATE INDEX messages_by_circle ON messages (circle_id, created_at);
  CREATE INDEX messages_by_recipient ON messages (recipient_id, read_at);
  CREATE INDEX messages_by_sender ON messages (sender_id, created_at);
  CREATE TABLE message_files (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX message_files_by_message ON message_files (message_id);
  CREATE INDEX message_files_by_user ON message_files (user_id, created_at);
  CREATE TABLE approvals_v3 (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL CHECK (action IN ('share_sip', 'send_intro', 'answer_intro', 'ask_person', 'answer_ask', 'send_message')),
    payload TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'declined')),
    result TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER,
    payload_key TEXT
  );
  INSERT INTO approvals_v3 (id, user_id, code_hash, action, payload, state, result, created_at, expires_at, decided_at, payload_key)
    SELECT id, user_id, code_hash, action, payload, state, result, created_at, expires_at, decided_at, payload_key FROM approvals;
  DROP TABLE approvals;
  ALTER TABLE approvals_v3 RENAME TO approvals;
  CREATE INDEX approvals_by_user ON approvals (user_id, state);
  CREATE TABLE app_keys_v3 (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('approval', 'ask', 'friend', 'chat')),
    ref TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    outcome TEXT
  );
  INSERT INTO app_keys_v3 SELECT hash, user_id, kind, ref, expires_at, used_at, outcome FROM app_keys;
  DROP TABLE app_keys;
  ALTER TABLE app_keys_v3 RENAME TO app_keys;
  CREATE INDEX app_keys_by_user ON app_keys (user_id);
  `,
  // Devices someone turned off from another one ("Turn off everywhere"): the browser there still holds its
  // subscription, so when that page next re-sends it, the relay answers "off" instead of taking it back.
  `
  CREATE TABLE push_off (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX push_off_by_user ON push_off (user_id);
  `,
  // Guests ("Try it without an account"): when the account and everything in it goes. NULL for everyone else.
  `
  ALTER TABLE users ADD COLUMN guest_expires_at INTEGER;
  CREATE INDEX users_by_guest_expiry ON users (guest_expires_at) WHERE guest_expires_at IS NOT NULL;
  `,
  // "Send to my AI" with a word on how to answer ("yes, 9 is fine, keep it short"): the person's own directions
  // for their own agent, kept (sealed) with the event that hands the question or conversation over.
  `
  ALTER TABLE events ADD COLUMN how TEXT;
  `,
];
