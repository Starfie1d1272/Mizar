import { readFile, unlink } from 'node:fs/promises';
import { replaceDurableJson } from './durable-json.js';
import { networkError, RivalHubResponseError } from './rivalhub-http-errors.js';

export type Installation = {
  baseUrl: string;
  credential: string;
  installationId: string;
  competitionId: string;
  displayName: string;
  authorizedUser?: { userId: string; displayName: string } | undefined;
};

type PendingPairing = {
  pairingId: string;
  pollToken: string;
  expiresAt: string;
};
export const OFFICIAL_RIVALHUB_URL = 'https://match.starfie1d.top';
export const CONTROL_TIMEOUT_MS = 15_000;
type PairingStatus = 'idle' | 'pending' | 'expired' | 'authorized';

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('请输入 RivalHub 的 HTTPS 网站地址。');
  return url.origin;
}

function authorizedUser(input: unknown): Installation['authorizedUser'] {
  if (!input || typeof input !== 'object') return undefined;
  const { userId, displayName } = input as Record<string, unknown>;
  if (
    typeof userId !== 'string' ||
    !userId.trim() ||
    userId.length > 128 ||
    typeof displayName !== 'string' ||
    !displayName.trim() ||
    displayName.length > 256
  )
    return undefined;
  return { userId: userId.trim(), displayName: displayName.trim() };
}

/** Owns the persisted credential and the pending browser authorization session. */
export class RivalHubAuthorization {
  private current: Installation | null = null;
  private pendingPairing: PendingPairing | null = null;
  private authorizedPairing: Installation | null = null;
  private pairingPoll: Promise<PairingStatus> | null = null;

  constructor(
    private readonly path: string,
    private readonly fetchImpl: typeof fetch,
    private readonly baseUrl: string,
    private readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>,
    private readonly beforeAuthorizationChange: () => Promise<void>,
    private readonly onAuthorized: () => void,
    private readonly onDiagnostic: (operation: string, error: unknown) => void,
    private readonly originalError: (operation: string, error: unknown) => void,
  ) {}

  get installation() {
    return this.current;
  }

  get pairing() {
    return this.pendingPairing === null ? 'idle' : 'pending';
  }

  redactionValues(): string[] {
    return [
      this.current?.credential ?? '',
      this.authorizedPairing?.credential ?? '',
      this.pendingPairing?.pollToken ?? '',
    ];
  }

  async load(onLoaded: (installation: Installation) => void): Promise<void> {
    let stage = 'connection_read';
    try {
      const raw = await readFile(this.path, 'utf8');
      stage = 'connection_parse';
      let parsed: Installation;
      try {
        parsed = JSON.parse(raw) as Installation;
      } catch (error) {
        // SyntaxError can quote the credential file before its key is known.
        if (error instanceof SyntaxError) {
          error.message = error.message.replace(/"[\s\S]*"/g, '"[redacted credential excerpt]"');
          if (error.stack)
            error.stack = error.stack.replace(/"[^\n]*"/g, '"[redacted credential excerpt]"');
        }
        throw error;
      }
      stage = 'connection_validate';
      if (
        !parsed ||
        typeof parsed.credential !== 'string' ||
        typeof parsed.installationId !== 'string' ||
        typeof parsed.competitionId !== 'string'
      )
        throw new Error('RivalHub connection setting has an invalid format');
      let baseUrl: string;
      try {
        baseUrl = normalizeBaseUrl(parsed.baseUrl);
      } catch {
        // A malformed URL exception may echo credential-bearing input.
        throw new Error('RivalHub connection setting has an invalid base URL');
      }
      const installation = {
        ...parsed,
        baseUrl,
        authorizedUser: authorizedUser(parsed.authorizedUser),
      };
      onLoaded(installation);
      this.current = installation;
    } catch (error) {
      if (stage === 'connection_read' && (error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return;
      this.onDiagnostic(stage, error);
      this.originalError(stage, error);
    }
  }

  async forget(onForgotten: () => void): Promise<void> {
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.current = null;
    onForgotten();
    this.pendingPairing = null;
    this.authorizedPairing = null;
  }

  async rememberViewer(installation: Installation, viewer: unknown): Promise<void> {
    await this.serialize(async () => {
      if (this.current !== installation) return;
      const user = authorizedUser(viewer);
      await this.persist({ ...installation, authorizedUser: user });
      installation.authorizedUser = user;
    });
  }

  private async persist(installation: Installation): Promise<void> {
    await replaceDurableJson(this.path, installation);
  }

  async request(operation: string, init: RequestInit = {}): Promise<Response> {
    if (!this.current) throw new Error('请先连接 RivalHub。');
    try {
      const response = await this.fetchImpl(`${this.current.baseUrl}/api/mizar/${operation}`, {
        ...init,
        redirect: 'manual',
        headers: { authorization: `Bearer ${this.current.credential}`, ...init.headers },
        signal:
          init.signal ?? AbortSignal.timeout(operation === 'live' ? 4000 : CONTROL_TIMEOUT_MS),
      });
      if (!response.ok && response.status !== 304) {
        if (operation !== 'reliable' && operation !== 'claim') await response.body?.cancel();
        this.onDiagnostic(operation, new Error(`RivalHub HTTP ${response.status}`));
      }
      return response;
    } catch (error) {
      this.originalError(operation, error);
      const safe = networkError(error);
      this.onDiagnostic(operation, safe);
      throw safe;
    }
  }

  async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      // Keep the credential-redacted original in private local evidence; the browser
      // and transport classifier retain their existing safe public projection.
      this.originalError('response_json', error);
      throw new RivalHubResponseError(error instanceof SyntaxError ? 'parse' : 'read');
    }
  }

  async startPairing(): Promise<{ authorizeUrl: string; expiresAt: string }> {
    return this.serialize(() => this.startPairingLocked());
  }

  private async startPairingLocked(): Promise<{ authorizeUrl: string; expiresAt: string }> {
    const baseUrl = normalizeBaseUrl(this.baseUrl);
    const response = await this.fetchImpl(`${baseUrl}/api/mizar/pairing/start`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    }).catch((error: unknown) => {
      this.originalError('pairing', error);
      throw networkError(error);
    });
    if (!response.ok) throw new Error('无法发起授权，请稍后重试。');
    const value = (await this.readJson(response)) as {
      pairingId?: unknown;
      pollToken?: unknown;
      authorizeUrl?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof value.pairingId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(value.pairingId) ||
      typeof value.pollToken !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(value.pollToken) ||
      typeof value.authorizeUrl !== 'string' ||
      typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.now()
    )
      throw new Error('授权请求格式无效。');
    const authorizeUrl = new URL(value.authorizeUrl);
    if (
      authorizeUrl.origin !== baseUrl ||
      authorizeUrl.username ||
      authorizeUrl.password ||
      authorizeUrl.hash ||
      authorizeUrl.pathname !== '/integrations/mizar/connect' ||
      authorizeUrl.searchParams.get('pairingId') !== value.pairingId
    )
      throw new Error('授权页面地址无效。');
    this.pendingPairing = {
      pairingId: value.pairingId,
      pollToken: value.pollToken,
      expiresAt: value.expiresAt,
    };
    this.authorizedPairing = null;
    return { authorizeUrl: authorizeUrl.toString(), expiresAt: value.expiresAt };
  }

  pollPairing(): Promise<PairingStatus> {
    if (!this.pairingPoll)
      this.pairingPoll = this.serialize(() => this.pollPairingOnce()).finally(() => {
        this.pairingPoll = null;
      });
    return this.pairingPoll;
  }

  private async pollPairingOnce(): Promise<PairingStatus> {
    if (this.authorizedPairing) return this.commitPairing(this.authorizedPairing);
    const pending = this.pendingPairing;
    if (pending === null) return 'idle';
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      this.pendingPairing = null;
      return 'expired';
    }
    const baseUrl = normalizeBaseUrl(this.baseUrl);
    const response = await this.fetchImpl(`${baseUrl}/api/mizar/pairing/poll`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingId: pending.pairingId, pollToken: pending.pollToken }),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    }).catch((error: unknown) => {
      this.originalError('pairing', error);
      throw networkError(error);
    });
    if (!response.ok) throw new Error('授权状态暂时无法获取。');
    const value = (await this.readJson(response)) as {
      status?: unknown;
      credential?: unknown;
      installationId?: unknown;
      competitionId?: unknown;
      displayName?: unknown;
      authorizedUser?: unknown;
    };
    if (value.status === 'pending') return 'pending';
    if (value.status === 'expired') {
      this.pendingPairing = null;
      return 'expired';
    }
    if (
      value.status !== 'authorized' ||
      typeof value.credential !== 'string' ||
      !/^rh_mizar_[0-9a-f-]{36}_[0-9a-f]{64}$/i.test(value.credential) ||
      typeof value.installationId !== 'string' ||
      typeof value.competitionId !== 'string'
    )
      throw new Error('授权结果格式无效。');

    const rawDisplayName = typeof value.displayName === 'string' ? value.displayName.trim() : '';
    const displayName = rawDisplayName.length > 0 ? rawDisplayName : '赛事管理员';

    this.authorizedPairing = {
      baseUrl,
      credential: value.credential,
      installationId: value.installationId,
      competitionId: value.competitionId,
      displayName,
      authorizedUser: authorizedUser(value.authorizedUser),
    };
    return this.commitPairing(this.authorizedPairing);
  }

  private async commitPairing(installation: Installation): Promise<PairingStatus> {
    await this.beforeAuthorizationChange();
    await this.persist(installation);
    this.onAuthorized();
    this.current = installation;
    this.authorizedPairing = null;
    this.pendingPairing = null;
    return 'authorized';
  }
}
