import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  api,
  type AppFull,
  type AiToolTest,
  type AppSummary,
  type Auth,
  type Client,
  type ClientConfig,
  type Connection,
  type Invocation,
  type InvocationDetail,
  type InvocationFilter,
  type Me,
  type PermissionDef,
  type ProfileRow,
  type UserRow,
  type ViewMode,
  UNAUTHORIZED_EVENT,
  type NexusOrg,
  type OAuthToken,
  type Tool,
  type ToolStatus,
  type UpstreamResult,
} from './api'

/* --------------------------------- util --------------------------------- */

const STATUS_LABEL: Record<ToolStatus, string> = { draft: 'Rascunho', approved: 'Aprovada', disabled: 'Desativada' }

function useHashRoute() {
  const [hash, setHash] = useState(location.hash.slice(1))
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1))
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return hash
}

function Copy({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn small"
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
    >
      {done ? 'Copiado' : label}
    </button>
  )
}

function Toast({ msg, onClose }: { msg: { text: string; err?: boolean } | null; onClose: () => void }) {
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(onClose, 4500)
    return () => clearTimeout(t)
  }, [msg, onClose])
  if (!msg) return null
  return <div className={`toast ${msg.err ? 'err' : ''}`}>{msg.text}</div>
}

const scoreClass = (s: number) => (s >= 80 ? 'good' : s >= 60 ? 'warn' : 'bad')

/* --------------------------------- app ---------------------------------- */

type Notify = (t: string, e?: boolean) => void

const AUTH_LABEL: Record<Auth['type'], string> = { none: 'Sem credencial', bearer: 'Bearer token', basic: 'Basic', apiKey: 'API key' }

/* -------------------------- usuário logado -------------------------- */

const MeCtx = createContext<{ me: Me; setMe: (m: Me) => void } | null>(null)
const useMe = () => useContext(MeCtx)!
/** O usuário logado tem alguma das permissões? */
function useCan() {
  const { me } = useMe()
  return useCallback((...perms: string[]) => perms.some((p) => me.permissions.includes(p)), [me])
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
    const out = () => setMe(null)
    addEventListener(UNAUTHORIZED_EVENT, out)
    return () => removeEventListener(UNAUTHORIZED_EVENT, out)
  }, [])

  if (me === undefined) return <div className="page muted">Carregando…</div>
  if (me === null) return <LoginPage onLogin={setMe} />
  return (
    <MeCtx.Provider value={{ me, setMe }}>
      <Shell />
    </MeCtx.Provider>
  )
}

/* ------------------------ logo animada (login) ------------------------ */

/** Path da engrenagem do logo (11 dentes), no sistema de coordenadas da imagem original (278×265). */
function gearPath(cx: number, cy: number, rTip: number, rBase: number, teeth: number, phase: number, tipHalf: number, baseHalf: number) {
  const P = (r: number, deg: number) => {
    const a = (deg * Math.PI) / 180
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`
  }
  const pts: string[] = []
  const step = 360 / teeth
  for (let k = 0; k < teeth; k++) {
    const c = phase + k * step
    pts.push(P(rBase, c - baseHalf), P(rTip, c - tipHalf), P(rTip, c + tipHalf), P(rBase, c + baseHalf))
  }
  return 'M' + pts.join('L') + 'Z'
}

const GX = 138.5
const GY = 123
const GEAR_OUTER = gearPath(GX, GY, 97, 83, 11, 268, 7.5, 11.5)
const GEAR_INSET = gearPath(GX, GY, 94, 80, 11, 268, 6.9, 10.9)
const GEAR_HOLE = `M${GX + 60},${GY} A60,60 0 1 0 ${GX - 60},${GY} A60,60 0 1 0 ${GX + 60},${GY}Z`
const RAYS = Array.from({ length: 18 }, (_, i) => {
  const a = ((i * 20 + (i % 2) * 7) * Math.PI) / 180
  const r0 = 104
  const r1 = i % 3 === 0 ? 290 : 250
  return { x1: GX + r0 * Math.cos(a), y1: GY + r0 * Math.sin(a), x2: GX + r1 * Math.cos(a), y2: GY + r1 * Math.sin(a), white: i % 4 === 0 }
})

/**
 * Logo em camadas: a engrenagem é vetorial (gira), a bigorna e o símbolo </> são as camadas
 * recortadas da imagem original. Com `forging`, a engrenagem gira e solta raios por 3 s.
 */
function ForgeLogo({ forging }: { forging: boolean }) {
  return (
    <div className={`login-logo ${forging ? 'forging' : ''}`}>
      <svg className="forge-svg" viewBox="0 0 278 265" aria-label="MCP Forge" role="img">
        <defs>
          <clipPath id="gear-left">
            <rect x="0" y="0" width={GX} height="265" />
          </clipPath>
          <clipPath id="gear-right">
            <rect x={GX} y="0" width="200" height="265" />
          </clipPath>
        </defs>
        <g className="rays" aria-hidden="true">
          {RAYS.map((r, i) => (
            <line key={i} {...r} style={{ ['--i' as any]: i }} stroke={r.white ? '#ffd9a8' : '#f7941d'} strokeWidth={r.white ? 6 : 9} strokeLinecap="round" />
          ))}
        </g>
        <g className="gear">
          <path clipPath="url(#gear-left)" fill="#fff" fillRule="evenodd" d={`${GEAR_OUTER} ${GEAR_HOLE}`} />
          <g clipPath="url(#gear-right)" fill="none" stroke="#f7941d" strokeWidth="6">
            <path d={GEAR_INSET} />
            <circle cx={GX} cy={GY} r="66" />
          </g>
        </g>
        <image href="/logo-layers/anvil.png" width="278" height="265" />
        <image href="/logo-layers/code.png" width="278" height="265" />
      </svg>
    </div>
  )
}

const FORGE_MS = 3000
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function LoginPage({ onLogin }: { onLogin: (m: Me) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [forging, setForging] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    setForging(true)
    const started = Date.now()
    try {
      const me = await api.login(username, password)
      // a forja gira por 3 s antes de entrar no sistema
      const wait = reducedMotion() ? 0 : Math.max(0, FORGE_MS - (Date.now() - started))
      await new Promise((r) => setTimeout(r, wait))
      onLogin(me)
    } catch (x: any) {
      setForging(false)
      setErr(x.message)
      setBusy(false)
    }
  }
  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-hero">
          <ForgeLogo forging={forging} />
          <h1 className="login-title">
            MCP <span>Forge</span>
          </h1>
          <p className="login-tagline">Documentação de API → servidor MCP</p>
        </div>
        <label className="field">
          Usuário
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          Senha
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {err && <div className="callout err small">{err}</div>}
        <button className="btn primary block" disabled={busy || !username || !password}>
          {forging ? 'Forjando acesso…' : busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}

function Shell() {
  const route = useHashRoute()
  const { me } = useMe()
  const can = useCan()
  const [apps, setApps] = useState<AppSummary[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null)
  const notify = useCallback((text: string, err = false) => setToast({ text, err }), [])
  const refresh = useCallback(() => {
    if (can('apps.view', 'apps.edit')) api.apps().then(setApps).catch((e) => notify(e.message, true))
    if (can('clients.view', 'clients.edit')) api.clients().then(setClients).catch((e) => notify(e.message, true))
  }, [notify, can])
  useEffect(() => {
    refresh()
  }, [refresh])

  const [page, id, sub] = route.split('/')
  const section = ['clients', 'client'].includes(page) ? 'clients' : ['apps', 'app', 'import'].includes(page) ? 'apps' : page
  return (
    <div className="shell">
      <aside className="side">
        <a className="brand" href="#">
          <img className="logo" src="/logo.png" alt="" width="32" height="32" /> MCP Forge
        </a>
        {can('apps.edit') && (
          <a className={`btn primary block ${page === 'import' ? 'active' : ''}`} href="#import">
            + Importar API
          </a>
        )}

        <div className="side-label">Cadastros</div>
        {can('clients.view', 'clients.edit') && (
          <a href="#clients" className={`side-item ${section === 'clients' ? 'active' : ''}`}>
            Clientes
          </a>
        )}
        {can('apps.view', 'apps.edit') && (
          <a href="#apps" className={`side-item ${section === 'apps' ? 'active' : ''}`}>
            MCP Apps
          </a>
        )}

        {can('logs.view') && (
          <>
            <div className="side-label">Operar</div>
            <a href="#invocations" className={`side-item ${page === 'invocations' ? 'active' : ''}`}>
              Logs de Requisições
            </a>
          </>
        )}

        {can('access.manage') && (
          <>
            <div className="side-label">Administração</div>
            <a href="#access" className={`side-item ${page === 'access' ? 'active' : ''}`}>
              Acesso
            </a>
          </>
        )}

        <span className="grow" />
        <div className="side-user">
          <div className="truncate">
            <b>{me.name}</b>
          </div>
          <div className="small muted truncate">
            {me.username} · {me.profileName}
          </div>
          <div className="row gap" style={{ marginTop: 6 }}>
            <a className="btn small ghost" href="#password">
              Alterar senha
            </a>
            <button
              className="btn small ghost"
              onClick={async () => {
                await api.logout().catch(() => {})
                location.hash = ''
                dispatchEvent(new Event(UNAUTHORIZED_EVENT))
              }}
            >
              Sair
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        {page === 'import' ? (
          <ImportPage notify={notify} onDone={refresh} />
        ) : page === 'apps' ? (
          <AppsListPage apps={apps} />
        ) : page === 'app' && id ? (
          <AppPage key={id} id={id} notify={notify} onChange={refresh} />
        ) : page === 'clients' && id === 'new' ? (
          <NewClientPage notify={notify} onDone={refresh} />
        ) : page === 'clients' ? (
          <ClientsListPage clients={clients} />
        ) : page === 'client' && id && sub ? (
          <ConnectionPage key={sub} id={sub} notify={notify} onChange={refresh} />
        ) : page === 'client' && id ? (
          <ClientPage key={id} id={id} apps={apps} notify={notify} onChange={refresh} />
        ) : page === 'invocations' ? (
          <InvocationsPage />
        ) : page === 'access' ? (
          <AccessPage notify={notify} />
        ) : page === 'password' ? (
          <PasswordPage notify={notify} />
        ) : (
          <Home apps={apps} clients={clients} />
        )}
      </main>
      <Toast msg={toast} onClose={() => setToast(null)} />
    </div>
  )
}

/* ------------------------ listas: cards ou lista ------------------------ */

/** Alterna cards/lista e salva a escolha no perfil do usuário. */
function useViewMode(kind: 'apps' | 'clients'): [ViewMode, (m: ViewMode) => void] {
  const { me, setMe } = useMe()
  const mode = me.prefs.viewMode[kind] ?? 'cards'
  const set = (m: ViewMode) => {
    setMe({ ...me, prefs: { ...me.prefs, viewMode: { ...me.prefs.viewMode, [kind]: m } } })
    api.savePrefs({ [kind]: m }).catch(() => {})
  }
  return [mode, set]
}

function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="toggle" role="group" aria-label="Visualização">
      <button className={mode === 'cards' ? 'on' : ''} onClick={() => onChange('cards')} title="Cards">
        Cards
      </button>
      <button className={mode === 'list' ? 'on' : ''} onClick={() => onChange('list')} title="Lista">
        Lista
      </button>
    </div>
  )
}

function ClientsListPage({ clients }: { clients: Client[] }) {
  const can = useCan()
  const [mode, setMode] = useViewMode('clients')
  const [q, setQ] = useState('')
  const t = q.trim().toLowerCase()
  const list = clients.filter((c) => !t || `${c.name} ${c.tradeName ?? ''} ${c.document ?? ''}`.toLowerCase().includes(t))
  return (
    <div className="page wide">
      <div className="row between">
        <div>
          <h1>Clientes</h1>
          <div className="muted small">{clients.length} cadastrados</div>
        </div>
        {can('clients.edit') && (
          <a className="btn primary" href="#clients/new">
            + Novo cliente
          </a>
        )}
      </div>
      <div className="row gap toolbar list-toolbar">
        <input className="search grow" placeholder="Buscar por nome, nome fantasia ou CNPJ" value={q} onChange={(e) => setQ(e.target.value)} />
        <ViewToggle mode={mode} onChange={setMode} />
      </div>
      {list.length === 0 ? (
        <div className="muted pad">{clients.length ? 'Nenhum cliente encontrado.' : 'Nenhum cliente cadastrado ainda.'}</div>
      ) : mode === 'cards' ? (
        <div className="cards">
          {list.map((c) => (
            <a key={c.id} className="card link" href={`#client/${c.id}`}>
              <div className="card-title">{c.tradeName || c.name}</div>
              {c.tradeName && <div className="muted small truncate">{c.name}</div>}
              {c.document && <div className="muted small mono">{c.document}</div>}
              <div className="row gap small wrap">
                {c.connections.length === 0 && <span className="muted">Nenhum MCP App vinculado</span>}
                {c.connections.map((x) => (
                  <span key={x.id} className={`badge ${x.enabled ? 'approved' : 'disabled'}`}>
                    {x.app.name}
                  </span>
                ))}
              </div>
            </a>
          ))}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Razão social</th>
                <th>CNPJ</th>
                <th>MCP Apps</th>
                <th>Cadastrado em</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} onClick={() => (location.hash = `client/${c.id}`)}>
                  <td>
                    <b>{c.tradeName || c.name}</b>
                  </td>
                  <td className="small">{c.name}</td>
                  <td className="mono small nowrap">{c.document ?? '—'}</td>
                  <td className="small">{c.connections.map((x) => x.app.name).join(', ') || <span className="muted">—</span>}</td>
                  <td className="small nowrap">{new Date(c.createdAt).toLocaleDateString('pt-BR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function AppsListPage({ apps }: { apps: AppSummary[] }) {
  const can = useCan()
  const [mode, setMode] = useViewMode('apps')
  const [q, setQ] = useState('')
  const t = q.trim().toLowerCase()
  const list = apps.filter((a) => !t || `${a.name} ${a.baseUrl}`.toLowerCase().includes(t))
  return (
    <div className="page wide">
      <div className="row between">
        <div>
          <h1>MCP Apps</h1>
          <div className="muted small">{apps.length} cadastrados</div>
        </div>
        {can('apps.edit') && (
          <a className="btn primary" href="#import">
            + Importar API
          </a>
        )}
      </div>
      <div className="row gap toolbar list-toolbar">
        <input className="search grow" placeholder="Buscar por nome ou URL" value={q} onChange={(e) => setQ(e.target.value)} />
        <ViewToggle mode={mode} onChange={setMode} />
      </div>
      {list.length === 0 ? (
        <div className="muted pad">{apps.length ? 'Nenhum MCP App encontrado.' : 'Nenhum MCP App ainda. Importe uma documentação de API.'}</div>
      ) : mode === 'cards' ? (
        <div className="cards">
          {list.map((a) => (
            <a key={a.id} className="card link" href={`#app/${a.id}`}>
              <div className="card-title">{a.name}</div>
              <div className="muted small mono truncate">{a.baseUrl || 'sem URL base'}</div>
              <div className="row gap small wrap">
                <span className="badge approved">{a.counts.approved} aprovadas</span>
                <span className="badge draft">{a.counts.draft} rascunho</span>
                <span className="badge disabled">
                  {a.clientCount} cliente{a.clientCount === 1 ? '' : 's'}
                </span>
              </div>
            </a>
          ))}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>MCP App</th>
                <th>URL da documentação</th>
                <th>Origem</th>
                <th>Tools aprovadas</th>
                <th>Clientes</th>
                <th>Criado em</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id} onClick={() => (location.hash = `app/${a.id}`)}>
                  <td>
                    <b>{a.name}</b>
                  </td>
                  <td className="mono small truncate">{a.baseUrl || '—'}</td>
                  <td className="small">{a.source.kind}</td>
                  <td className="small nowrap">
                    {a.counts.approved}/{a.counts.total}
                  </td>
                  <td className="small">{a.clientCount}</td>
                  <td className="small nowrap">{new Date(a.createdAt).toLocaleDateString('pt-BR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* -------------------------------- acesso -------------------------------- */

function PasswordPage({ notify }: { notify: Notify }) {
  const [current, setCurrent] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const save = async () => {
    if (pw !== pw2) return notify('A confirmação não confere com a nova senha.', true)
    try {
      await api.changePassword(current, pw)
      notify('Senha alterada.')
      setCurrent('')
      setPw('')
      setPw2('')
    } catch (e: any) {
      notify(e.message, true)
    }
  }
  return (
    <div className="page narrow">
      <h1>Alterar senha</h1>
      <label className="field">
        Senha atual
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="field">
        Nova senha
        <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <span className="hint">Pelo menos 6 caracteres.</span>
      </label>
      <label className="field">
        Confirmar nova senha
        <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </label>
      <button className="btn primary" disabled={!current || !pw || !pw2} onClick={save}>
        Salvar nova senha
      </button>
    </div>
  )
}

function AccessPage({ notify }: { notify: Notify }) {
  const [tab, setTab] = useState<'users' | 'profiles'>('users')
  const [users, setUsers] = useState<UserRow[]>([])
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [perms, setPerms] = useState<PermissionDef[]>([])
  const load = useCallback(() => {
    api.users().then(setUsers).catch((e) => notify(e.message, true))
    api.profiles().then(setProfiles).catch((e) => notify(e.message, true))
  }, [notify])
  useEffect(() => {
    load()
    api.permissions().then(setPerms).catch(() => {})
  }, [load])
  return (
    <div className="page wide">
      <h1>Acesso</h1>
      <p className="lead">Usuários da interface do MCP Forge e perfis de permissionamento.</p>
      <div className="tabs">
        <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>
          Usuários ({users.length})
        </button>
        <button className={tab === 'profiles' ? 'on' : ''} onClick={() => setTab('profiles')}>
          Perfis ({profiles.length})
        </button>
      </div>
      {tab === 'users' ? (
        <UsersTab users={users} profiles={profiles} notify={notify} reload={load} />
      ) : (
        <ProfilesTab profiles={profiles} perms={perms} notify={notify} reload={load} />
      )}
    </div>
  )
}

function UsersTab({ users, profiles, notify, reload }: { users: UserRow[]; profiles: ProfileRow[]; notify: Notify; reload: () => void }) {
  const { me } = useMe()
  const [edit, setEdit] = useState<UserRow | 'new' | null>(null)
  return (
    <div className={`split ${edit ? 'with-panel' : ''}`}>
      <div>
        <div className="row gap toolbar">
          <span className="grow" />
          <button className="btn primary" onClick={() => setEdit('new')}>
            + Novo usuário
          </button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Usuário</th>
                <th>Perfil</th>
                <th>Status</th>
                <th>Último acesso</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={edit !== 'new' && edit?.id === u.id ? 'sel' : ''} onClick={() => setEdit(u)}>
                  <td>
                    {u.name} {u.master && <span className="badge draft">master</span>}
                    {u.id === me.id && <span className="muted small"> (você)</span>}
                  </td>
                  <td className="mono small">{u.username}</td>
                  <td className="small">{u.profileName}</td>
                  <td>
                    <span className={`badge ${u.active ? 'approved' : 'disabled'}`}>{u.active ? 'Ativo' : 'Desativado'}</span>
                  </td>
                  <td className="small nowrap">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : <span className="muted">nunca</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {edit && (
        <UserPanel
          key={edit === 'new' ? 'new' : edit.id}
          user={edit === 'new' ? null : edit}
          profiles={profiles}
          notify={notify}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

function UserPanel({
  user,
  profiles,
  notify,
  onClose,
  onSaved,
}: {
  user: UserRow | null
  profiles: ProfileRow[]
  notify: Notify
  onClose: () => void
  onSaved: () => void
}) {
  const { me } = useMe()
  const [name, setName] = useState(user?.name ?? '')
  const [username, setUsername] = useState(user?.username ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [profileId, setProfileId] = useState(user?.profileId ?? profiles.find((p) => !p.system)?.id ?? profiles[0]?.id ?? '')
  const [active, setActive] = useState(user?.active ?? true)
  const [password, setPassword] = useState('')
  const locked = !!user?.master

  const save = async () => {
    try {
      if (user) {
        await api.updateUser(user.id, {
          name,
          email,
          ...(locked ? {} : { profileId, active }),
          ...(password ? { password } : {}),
        })
        notify('Usuário atualizado.')
      } else {
        await api.createUser({ username, name, email: email || undefined, profileId, password })
        notify(`Usuário ${username} criado.`)
      }
      onSaved()
    } catch (e: any) {
      notify(e.message, true)
    }
  }

  return (
    <aside className="panel">
      <div className="row between">
        <b>{user ? 'Editar usuário' : 'Novo usuário'}</b>
        <button className="btn small ghost" onClick={onClose}>
          Fechar ✕
        </button>
      </div>
      {locked && <div className="callout warn small">Admin master: não pode ser excluído, desativado nem mudar de perfil.</div>}
      <label className="field">
        Nome
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Usuário (login)
        <input className="mono" value={username} disabled={!!user} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
      </label>
      <label className="field">
        E-mail (opcional)
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        Perfil
        <select value={profileId} disabled={locked} onChange={(e) => setProfileId(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {user ? 'Nova senha (deixe em branco para manter)' : 'Senha'}
        <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <span className="hint">Pelo menos 6 caracteres.{user ? ' Trocar a senha encerra as sessões abertas do usuário.' : ''}</span>
      </label>
      {user && !locked && user.id !== me.id && (
        <label className="row gap small">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Usuário ativo
        </label>
      )}
      <div className="row gap wrap">
        <button className="btn primary" disabled={!name || (!user && (!username || !password))} onClick={save}>
          {user ? 'Salvar' : 'Criar usuário'}
        </button>
        {user && !locked && user.id !== me.id && (
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm(`Excluir o usuário ${user.username}?`)) return
              try {
                await api.deleteUser(user.id)
                notify('Usuário excluído.')
                onSaved()
              } catch (e: any) {
                notify(e.message, true)
              }
            }}
          >
            Excluir
          </button>
        )}
      </div>
    </aside>
  )
}

function ProfilesTab({ profiles, perms, notify, reload }: { profiles: ProfileRow[]; perms: PermissionDef[]; notify: Notify; reload: () => void }) {
  const [edit, setEdit] = useState<ProfileRow | 'new' | null>(null)
  const label = (k: string) => perms.find((p) => p.key === k)?.label ?? k
  return (
    <div className={`split ${edit ? 'with-panel' : ''}`}>
      <div>
        <div className="row gap toolbar">
          <span className="grow" />
          <button className="btn primary" onClick={() => setEdit('new')}>
            + Novo perfil
          </button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Perfil</th>
                <th>Permissões</th>
                <th>Usuários</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id} className={edit !== 'new' && edit?.id === p.id ? 'sel' : ''} onClick={() => setEdit(p)}>
                  <td>
                    <b>{p.name}</b> {p.system && <span className="badge draft">sistema</span>}
                    {p.description && <div className="small muted">{p.description}</div>}
                  </td>
                  <td className="small" title={p.permissions.map(label).join('\n')}>
                    {p.permissions.length} de {perms.length}
                  </td>
                  <td className="small">{p.userCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {edit && (
        <ProfilePanel
          key={edit === 'new' ? 'new' : edit.id}
          profile={edit === 'new' ? null : edit}
          perms={perms}
          notify={notify}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

function ProfilePanel({
  profile,
  perms,
  notify,
  onClose,
  onSaved,
}: {
  profile: ProfileRow | null
  perms: PermissionDef[]
  notify: Notify
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(profile?.name ?? '')
  const [description, setDescription] = useState(profile?.description ?? '')
  const [sel, setSel] = useState<Set<string>>(new Set(profile?.permissions ?? []))
  const system = !!profile?.system
  const groups = [...new Set(perms.map((p) => p.group))]
  const toggle = (k: string) => {
    const n = new Set(sel)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    setSel(n)
  }
  const save = async () => {
    try {
      const b = { name, description, ...(system ? {} : { permissions: [...sel] }) }
      if (profile) await api.updateProfile(profile.id, b)
      else await api.createProfile({ name, description, permissions: [...sel] })
      notify(profile ? 'Perfil atualizado.' : `Perfil ${name} criado.`)
      onSaved()
    } catch (e: any) {
      notify(e.message, true)
    }
  }
  return (
    <aside className="panel">
      <div className="row between">
        <b>{profile ? 'Editar perfil' : 'Novo perfil'}</b>
        <button className="btn small ghost" onClick={onClose}>
          Fechar ✕
        </button>
      </div>
      {system && <div className="callout warn small">Perfil do sistema: sempre tem todas as permissões.</div>}
      <label className="field">
        Nome
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Descrição
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="field">
        Permissões
        {groups.map((g) => (
          <div key={g} className="perm-group">
            <div className="small muted">{g}</div>
            {perms
              .filter((p) => p.group === g)
              .map((p) => (
                <label key={p.key} className="row gap small perm">
                  <input type="checkbox" disabled={system} checked={system || sel.has(p.key)} onChange={() => toggle(p.key)} />
                  <span>{p.label}</span>
                </label>
              ))}
          </div>
        ))}
      </div>
      <div className="row gap wrap">
        <button className="btn primary" disabled={!name.trim()} onClick={save}>
          {profile ? 'Salvar' : 'Criar perfil'}
        </button>
        {profile && !system && (
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm(`Excluir o perfil ${profile.name}?`)) return
              try {
                await api.deleteProfile(profile.id)
                notify('Perfil excluído.')
                onSaved()
              } catch (e: any) {
                notify(e.message, true)
              }
            }}
          >
            Excluir
          </button>
        )}
      </div>
    </aside>
  )
}

/* --------------------------------- home --------------------------------- */

function Home({ apps, clients }: { apps: AppSummary[]; clients: Client[] }) {
  return (
    <div className="page">
      <h1>Documentação de API → servidor MCP</h1>
      <p className="lead">
        Importe a documentação da API uma vez, revise as tools e conecte cada cliente com a credencial e a URL dele.
      </p>
      <ol className="steps">
        <li>
          <b>Importar</b> a documentação da API (vira um MCP App, ex.: Flashman).
        </li>
        <li>
          <b>Configurar o laboratório</b> do app (dados da API de testes) e <b>revisar, testar e aprovar</b> as tools. Só tools aprovadas
          aparecem no MCP, para todos os clientes.
        </li>
        <li>
          <b>Cadastrar o cliente</b> a partir das organizações do Nexus.
        </li>
        <li>
          <b>Vincular o MCP App ao cliente</b> e configurar os dados da API dele (URL base e credencial próprias).
        </li>
        <li>
          <b>Conectar</b>: o cliente MCP troca o client_id/secret daquela conexão por um Bearer token (OAuth 2.0, 24 h) e usa no
          Cherry Studio.
        </li>
      </ol>
      {clients.length > 0 && (
        <>
          <h3>Clientes</h3>
          <div className="cards">
            {clients.map((c) => (
              <a key={c.id} className="card link" href={`#client/${c.id}`}>
                <div className="card-title">{c.tradeName || c.name}</div>
                {c.tradeName && <div className="muted small truncate">{c.name}</div>}
                <div className="row gap small wrap">
                  {c.connections.length === 0 && <span className="muted">Nenhum MCP App vinculado</span>}
                  {c.connections.map((x) => (
                    <span key={x.id} className={`badge ${x.enabled ? 'approved' : 'disabled'}`}>
                      {x.app.name}
                    </span>
                  ))}
                </div>
              </a>
            ))}
          </div>
        </>
      )}
      {apps.length > 0 && (
        <>
          <h3>MCP Apps</h3>
          <div className="cards">
            {apps.map((a) => (
              <a key={a.id} className="card link" href={`#app/${a.id}`}>
                <div className="card-title">{a.name}</div>
                <div className="muted small mono truncate">{a.baseUrl || 'sem URL base padrão'}</div>
                <div className="row gap small wrap">
                  <span className="badge approved">{a.counts.approved} aprovadas</span>
                  <span className="badge draft">{a.counts.draft} rascunho</span>
                  <span className="badge disabled">
                    {a.clientCount} cliente{a.clientCount === 1 ? '' : 's'}
                  </span>
                </div>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/* -------------------------------- import -------------------------------- */

function ImportPage({ notify, onDone }: { notify: (t: string, e?: boolean) => void; onDone: () => void }) {
  const [mode, setMode] = useState<'url' | 'paste'>('url')
  const [url, setUrl] = useState('')
  const [content, setContent] = useState('')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])

  const submit = async () => {
    setBusy(true)
    setWarnings([])
    try {
      const r = await api.importApp({
        name: name || undefined,
        baseUrl: baseUrl || undefined,
        ...(mode === 'url' ? { url } : { content }),
      })
      onDone()
      notify(`${r.app.tools.length} tools geradas em rascunho.`)
      if (r.warnings.length) setWarnings(r.warnings)
      else location.hash = `app/${r.app.id}`
      if (r.warnings.length) setTimeout(() => (location.hash = `app/${r.app.id}`), 2500)
    } catch (e: any) {
      notify(e.message, true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page narrow">
      <h1>Importar API</h1>
      <p className="lead">Suporta OpenAPI 3.x, Swagger 2.0 (JSON ou YAML) e Postman Collection v2.x.</p>
      <div className="seg">
        <button className={mode === 'url' ? 'on' : ''} onClick={() => setMode('url')}>
          Link
        </button>
        <button className={mode === 'paste' ? 'on' : ''} onClick={() => setMode('paste')}>
          Colar / arquivo
        </button>
      </div>
      {mode === 'url' ? (
        <label className="field">
          URL da documentação
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.exemplo.com/openapi.json" />
          <span className="hint">
            Use o link do arquivo JSON/YAML. Links do Postman Documenter (documenter.getpostman.com/view/…) são convertidos
            automaticamente.
          </span>
        </label>
      ) : (
        <label className="field">
          Conteúdo
          <textarea rows={12} className="mono" value={content} onChange={(e) => setContent(e.target.value)} placeholder="Cole aqui o JSON/YAML" />
          <input
            type="file"
            accept=".json,.yaml,.yml"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (f) setContent(await f.text())
            }}
          />
        </label>
      )}
      <div className="grid2">
        <label className="field">
          Nome do app (opcional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Usa o título da documentação" />
        </label>
        <label className="field">
          URL base da API (opcional)
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Usa a declarada na documentação" />
        </label>
      </div>
      {warnings.length > 0 && (
        <div className="callout warn">
          {warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}
      <button className="btn primary" disabled={busy || (mode === 'url' ? !url : !content)} onClick={submit}>
        {busy ? 'Importando…' : 'Gerar tools'}
      </button>
    </div>
  )
}

/* ---------------------------------- app --------------------------------- */

type Tab = 'tools' | 'lab' | 'connect' | 'clients' | 'settings' | 'logs'

function AppPage({ id, notify, onChange }: { id: string; notify: Notify; onChange: () => void }) {
  const [app, setApp] = useState<AppFull | null>(null)
  const [lab, setLab] = useState<Connection | null>(null)
  const [tab, setTab] = useState<Tab>('tools')
  const load = useCallback(
    () =>
      api
        .app(id)
        .then((a) => {
          setApp(a)
          return api.connection(a.labConnectionId).then(setLab)
        })
        .catch((e) => notify(e.message, true)),
    [id, notify],
  )
  useEffect(() => {
    load()
  }, [load])
  const reload = useCallback(() => {
    load()
    onChange()
  }, [load, onChange])

  if (!app) return <div className="page muted">Carregando…</div>
  return (
    <div className="page wide">
      <div className="crumbs small muted">
        <a href="#apps">MCP Apps</a> › {app.name}
      </div>
      <div className="row between">
        <div>
          <h1>{app.name}</h1>
          <div className="muted small mono">
            {app.source.kind} {app.source.version && `· v${app.source.version}`} · lab: {lab?.effectiveBaseUrl || 'sem URL base'}
          </div>
        </div>
        <div className="row gap">
          <span className="badge approved">{app.counts.approved} aprovadas</span>
          <span className="badge draft">{app.counts.draft} rascunho</span>
          {app.counts.disabled > 0 && <span className="badge disabled">{app.counts.disabled} desativadas</span>}
        </div>
      </div>
      {lab && !lab.effectiveBaseUrl && (
        <div className="callout warn">Defina a URL base da API em Laboratório › Dados da API para testar as tools.</div>
      )}
      <div className="tabs">
        {(
          [
            ['tools', `Tools (${app.counts.total})`],
            ['lab', 'Laboratório · Dados da API'],
            ['connect', 'Laboratório · Conexão'],
            ['clients', `Clientes (${app.connections.length})`],
            ['settings', 'App'],
            ['logs', 'Logs de Requisições'],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'tools' && <ToolsTab app={app} notify={notify} reload={reload} />}
      {tab === 'lab' && lab && <ConnSettingsTab key={lab.id} conn={lab} notify={notify} reload={reload} />}
      {tab === 'connect' && lab && <ConnectTab conn={lab} notify={notify} reload={reload} />}
      {tab === 'clients' && <AppClientsTab app={app} notify={notify} reload={reload} />}
      {tab === 'settings' && <AppSettingsTab app={app} notify={notify} reload={reload} />}
      {tab === 'logs' && <InvocationsPage app={app.slug} embedded />}
    </div>
  )
}

function AppClientsTab({ app, notify, reload }: { app: AppFull; notify: Notify; reload: () => void }) {
  const [clients, setClients] = useState<Client[]>([])
  const [pick, setPick] = useState('')
  useEffect(() => {
    api.clients().then(setClients).catch(() => {})
  }, [app.connections.length])
  const linked = new Set(app.connections.map((c) => c.client.id))
  const available = clients.filter((c) => !linked.has(c.id))

  const link = async () => {
    try {
      const conn = await api.createConnection(pick, { appId: app.id })
      notify(`${app.name} vinculado a ${conn.client.name}. Configure a credencial do cliente.`)
      reload()
      location.hash = `client/${conn.client.id}/${conn.id}`
    } catch (e: any) {
      notify(e.message, true)
    }
  }

  return (
    <div>
      <p className="muted small">
        As tools aprovadas valem para todos os clientes. Cada cliente tem dados da API (URL base, credencial) e conexão (OAuth
        client_id/secret, tokens) próprios, separados do laboratório.
      </p>
      <div className="row gap wrap toolbar">
        <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ maxWidth: 360 }}>
          <option value="">Vincular a um cliente…</option>
          {available.map((c) => (
            <option key={c.id} value={c.id}>
              {c.tradeName || c.name}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={!pick} onClick={link}>
          Vincular
        </button>
        <a className="btn" href="#clients/new">
          + Novo cliente
        </a>
      </div>
      <ConnectionsTable rows={app.connections} show="client" />
    </div>
  )
}

function ConnectionsTable({ rows, show }: { rows: Connection[] | any[]; show: 'client' | 'app' }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{show === 'client' ? 'Cliente' : 'MCP App'}</th>
            <th>URL base</th>
            <th>Credencial</th>
            <th>Tools</th>
            <th>Status</th>
            <th>Endpoint MCP</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c: any) => (
            <tr key={c.id} onClick={() => (location.hash = `client/${c.client.id}/${c.id}`)}>
              <td>{show === 'client' ? c.client.name : c.app.name}</td>
              <td className="mono small truncate">{c.baseUrl || <span className="muted">—</span>}</td>
              <td className="small">{AUTH_LABEL[c.authType as Auth['type']]}</td>
              <td className="small">{c.approvedTools} aprovadas</td>
              <td>
                <span className={`badge ${c.enabled ? 'approved' : 'disabled'}`}>{c.enabled ? 'Ativo' : 'Desativado'}</span>
              </td>
              <td className="mono small truncate">{c.mcpUrl}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="muted center pad">
                {show === 'client' ? 'Nenhum cliente vinculado a este app.' : 'Nenhum MCP App vinculado a este cliente.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/* ---------------------------------- tools ------------------------------- */

function ToolsTab({ app, notify, reload }: { app: AppFull; notify: (t: string, e?: boolean) => void; reload: () => void }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | ToolStatus>('all')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const [ai, setAi] = useState<{ configured: boolean; model: string } | null>(null)
  const [aiRun, setAiRun] = useState<{ done: number; total: number; failed: number; cancel: boolean } | null>(null)
  useEffect(() => {
    api.aiStatus().then(setAi).catch(() => setAi({ configured: false, model: '' }))
  }, [])

  const list = useMemo(
    () =>
      app.tools.filter(
        (t) =>
          (status === 'all' || t.status === status) &&
          (!q || `${t.name} ${t.path} ${t.description}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [app.tools, q, status],
  )
  const allSel = list.length > 0 && list.every((t) => sel.has(t.id))

  const bulk = async (s: ToolStatus, ids = [...sel]) => {
    if (!ids.length) return
    const r = await api.bulk(app.id, ids, s)
    notify(`${r.updated} tools → ${STATUS_LABEL[s]}`)
    setSel(new Set())
    reload()
  }
  const goodDrafts = app.tools.filter((t) => t.status === 'draft' && t.lint.score >= 80).map((t) => t.id)
  const weak = app.tools.filter((t) => t.status !== 'disabled' && t.lint.score < 80).map((t) => t.id)

  /** Gera e salva descrições com IA para várias tools (3 por vez). Tools aprovadas voltam para rascunho. */
  const aiBulk = async (ids: string[]) => {
    if (!ids.length) return
    const approved = app.tools.filter((t) => ids.includes(t.id) && t.status === 'approved').length
    if (
      !confirm(
        `Gerar com IA a descrição e os parâmetros de ${ids.length} tool(s)?` +
          (approved ? `\n${approved} aprovada(s) voltarão para rascunho para você revisar.` : ''),
      )
    )
      return
    const state = { done: 0, total: ids.length, failed: 0, cancel: false }
    setAiRun({ ...state })
    const errors: string[] = []
    const queue = [...ids]
    const worker = async () => {
      while (queue.length && !state.cancel) {
        const id = queue.shift()!
        const t = app.tools.find((x) => x.id === id)!
        try {
          const r = await api.aiDescribe(app.id, id)
          await api.updateTool(app.id, id, { description: r.description, paramDescriptions: r.params })
        } catch (e: any) {
          state.failed++
          errors.push(`${t.name}: ${e.message}`)
          if (/não configurada|inválida|não encontrado/.test(e.message)) state.cancel = true // erro de configuração: para tudo
        }
        state.done++
        setAiRun({ ...state })
      }
    }
    await Promise.all([worker(), worker(), worker()])
    setAiRun(null)
    setSel(new Set())
    reload()
    notify(
      errors.length ? `IA: ${state.done - state.failed} geradas, ${state.failed} com erro. ${errors[0]}` : `IA: ${state.done} tool(s) documentadas. Revise e aprove.`,
      errors.length > 0,
    )
  }
  const cancelAi = () => setAiRun((r) => (r ? { ...r, cancel: true } : r))
  const current = app.tools.find((t) => t.id === open)

  return (
    <div className={`split ${current ? 'with-panel' : ''}`}>
      <div>
        <div className="row gap wrap toolbar">
          <input className="search" placeholder="Buscar tool, path…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={status} onChange={(e) => setStatus(e.target.value as any)}>
            <option value="all">Todos os status</option>
            <option value="draft">Rascunho</option>
            <option value="approved">Aprovada</option>
            <option value="disabled">Desativada</option>
          </select>
          <span className="grow" />
          {aiRun ? (
            <>
              <span className="small">
                Gerando com IA… {aiRun.done}/{aiRun.total}
                {aiRun.failed > 0 && <span className="muted"> · {aiRun.failed} erro(s)</span>}
              </span>
              <button className="btn small" onClick={cancelAi} disabled={aiRun.cancel}>
                {aiRun.cancel ? 'Parando…' : 'Parar'}
              </button>
            </>
          ) : sel.size > 0 ? (
            <>
              <span className="muted small">{sel.size} selecionadas</span>
              {ai?.configured && (
                <button className="btn small" onClick={() => aiBulk([...sel])} title={`Gera descrição e parâmetros com ${ai.model}`}>
                  Gerar com IA
                </button>
              )}
              <button className="btn small primary" onClick={() => bulk('approved')}>
                Aprovar
              </button>
              <button className="btn small" onClick={() => bulk('draft')}>
                Rascunho
              </button>
              <button className="btn small" onClick={() => bulk('disabled')}>
                Desativar
              </button>
            </>
          ) : (
            <>
              {ai?.configured && weak.length > 0 && (
                <button className="btn small" onClick={() => aiBulk(weak)} title={`Gera descrição e parâmetros com ${ai.model}`}>
                  Melhorar {weak.length} com IA (qualidade &lt; 80)
                </button>
              )}
              {goodDrafts.length > 0 && (
                <button className="btn small" onClick={() => bulk('approved', goodDrafts)} title="Rascunhos com qualidade ≥ 80">
                  Aprovar {goodDrafts.length} com qualidade ≥ 80
                </button>
              )}
            </>
          )}
        </div>
        <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input
                  type="checkbox"
                  checked={allSel}
                  onChange={() => setSel(allSel ? new Set() : new Set(list.map((t) => t.id)))}
                />
              </th>
              <th>Tool</th>
              <th>Endpoint</th>
              <th style={{ width: 90 }}>Qualidade</th>
              <th style={{ width: 110 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id} className={open === t.id ? 'sel' : ''} onClick={() => setOpen(t.id)}>
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={sel.has(t.id)}
                    onChange={() => {
                      const n = new Set(sel)
                      n.has(t.id) ? n.delete(t.id) : n.add(t.id)
                      setSel(n)
                    }}
                  />
                </td>
                <td className="mono">{t.name}</td>
                <td className="mono small">
                  <span className={`method ${t.method.toLowerCase()}`}>{t.method}</span> {t.path}
                </td>
                <td>
                  <span className={`score ${scoreClass(t.lint.score)}`}>{t.lint.score}</span>
                </td>
                <td>
                  <span className={`badge ${t.status}`}>{STATUS_LABEL[t.status]}</span>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={5} className="muted center pad">
                  Nenhuma tool.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
      {current && (
        <ToolPanel
          key={current.id + current.updatedAt}
          app={app}
          tool={current}
          ai={ai}
          notify={notify}
          reload={reload}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

function exampleArgs(t: Tool) {
  const out: Record<string, unknown> = {}
  for (const [k, s] of Object.entries<any>(t.inputSchema.properties ?? {})) {
    if (!t.inputSchema.required?.includes(k)) continue
    out[k] = s.enum?.[0] ?? (s.type === 'integer' || s.type === 'number' ? 0 : s.type === 'object' ? {} : s.type === 'boolean' ? false : '')
  }
  return JSON.stringify(out, null, 2)
}

function ToolPanel({
  app,
  tool,
  ai,
  notify,
  reload,
  onClose,
}: {
  app: AppFull
  tool: Tool
  ai: { configured: boolean; model: string } | null
  notify: (t: string, e?: boolean) => void
  reload: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(tool.name)
  const [desc, setDesc] = useState(tool.description)
  const props = tool.inputSchema.properties ?? {}
  const [pdesc, setPdesc] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries<any>(props).map(([k, s]) => [k, s?.description ?? ''])),
  )
  const [args, setArgs] = useState(exampleArgs(tool))
  const [result, setResult] = useState<UpstreamResult | null>(null)
  const [running, setRunning] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [mode, setMode] = useState<'message' | 'json'>(ai?.configured ? 'message' : 'json')
  const [message, setMessage] = useState('')
  const [aiResult, setAiResult] = useState<AiToolTest | null>(null)
  const [aiNote, setAiNote] = useState('')
  const [connId, setConnId] = useState(app.labConnectionId)
  const conn = app.connections.find((c) => c.id === connId)
  const [labBase, setLabBase] = useState('')
  useEffect(() => {
    api.connection(app.labConnectionId).then((l) => setLabBase(l.effectiveBaseUrl)).catch(() => {})
  }, [app.labConnectionId])
  const testBase = conn ? conn.baseUrl || app.baseUrl : labBase
  const dirty =
    name !== tool.name || desc !== tool.description || Object.entries(pdesc).some(([k, v]) => v !== (props[k]?.description ?? ''))
  const inOf = (k: string) => tool.params.find((p) => p.name === k)?.in ?? '?'

  const save = async (status?: ToolStatus) => {
    try {
      const changedParams = Object.fromEntries(Object.entries(pdesc).filter(([k, v]) => v !== (props[k]?.description ?? '')))
      await api.updateTool(app.id, tool.id, {
        ...(name !== tool.name ? { name } : {}),
        ...(desc !== tool.description ? { description: desc } : {}),
        ...(Object.keys(changedParams).length ? { paramDescriptions: changedParams } : {}),
        ...(status ? { status } : {}),
      })
      notify(status ? `Tool ${STATUS_LABEL[status].toLowerCase()}.` : 'Salvo. Tool voltou para rascunho se estava aprovada.')
      reload()
    } catch (e: any) {
      notify(e.message, true)
    }
  }

  const generate = async () => {
    setGenerating(true)
    try {
      const r = await api.aiDescribe(app.id, tool.id)
      setDesc(r.description)
      setPdesc((p) => ({ ...p, ...r.params }))
      setAiNote(`Sugestão gerada por ${r.model}. Revise e clique em Salvar ou Salvar e aprovar.`)
    } catch (e: any) {
      notify(e.message, true)
    } finally {
      setGenerating(false)
    }
  }

  const runMessage = async () => {
    setRunning(true)
    setAiResult(null)
    try {
      setAiResult(await api.aiTest(app.id, tool.id, message, connId || undefined))
    } catch (e: any) {
      notify(e.message, true)
    } finally {
      setRunning(false)
    }
  }

  const run = async () => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(args || '{}')
    } catch {
      return notify('Argumentos não são JSON válido.', true)
    }
    setRunning(true)
    try {
      setResult(await api.testTool(app.id, tool.id, parsed, connId || undefined))
    } catch (e: any) {
      notify(e.message, true)
    } finally {
      setRunning(false)
    }
  }

  return (
    <aside className="panel">
      <div className="row between">
        <span className={`badge ${tool.status}`}>{STATUS_LABEL[tool.status]}</span>
        <button className="btn small ghost" onClick={onClose}>
          Fechar ✕
        </button>
      </div>
      <div className="mono small muted">
        <span className={`method ${tool.method.toLowerCase()}`}>{tool.method}</span> {tool.path}
      </div>
      {tool.lint.issues.length > 0 && (
        <div className="callout warn small">
          <b>Qualidade {tool.lint.score}/100</b>
          <ul>
            {tool.lint.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      )}
      <label className="field">
        Nome
        <input className="mono" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="row between">
        <span className="small muted">Descrição e parâmetros são o que o modelo lê para usar a tool.</span>
        <button
          className="btn small nowrap"
          disabled={generating || !ai?.configured}
          onClick={generate}
          title={ai?.configured ? `Gerar com ${ai.model}` : 'Defina OPENAI_API_KEY no server/.env para habilitar'}
        >
          {generating ? 'Gerando…' : 'Gerar com IA'}
        </button>
      </div>
      {aiNote && <div className="callout ok small">{aiNote}</div>}
      <label className="field">
        Descrição (o que o modelo lê)
        <textarea rows={6} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </label>
      {Object.keys(props).length > 0 && (
        <div className="field">
          Parâmetros
          {Object.entries<any>(props).map(([k, s]) => (
            <div key={k} className="param">
              <div className="mono small">
                {k}
                {tool.inputSchema.required?.includes(k) && <span className="req">*</span>}{' '}
                <span className="muted">
                  {Array.isArray(s?.type) ? s.type.join('|') : s?.type ?? 'any'} · {inOf(k)}
                </span>
              </div>
              <input value={pdesc[k] ?? ''} placeholder="Descreva o parâmetro" onChange={(e) => setPdesc({ ...pdesc, [k]: e.target.value })} />
            </div>
          ))}
        </div>
      )}
      <div className="row gap wrap">
        <button className="btn" disabled={!dirty} onClick={() => save()}>
          Salvar
        </button>
        {tool.status !== 'approved' && (
          <button className="btn primary" onClick={() => save('approved')}>
            {dirty ? 'Salvar e aprovar' : 'Aprovar'}
          </button>
        )}
        {tool.status === 'approved' && (
          <button className="btn" onClick={() => save('draft')}>
            Voltar para rascunho
          </button>
        )}
        {tool.status !== 'disabled' && (
          <button className="btn ghost" onClick={() => save('disabled')}>
            Desativar
          </button>
        )}
      </div>

      <details className="field">
        <summary>inputSchema</summary>
        <pre className="code">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
      </details>

      <div className="field">
        <div className="row between">
          <span>Playground</span>
          {!tool.readOnly && <span className="badge disabled">altera dados</span>}
        </div>
        <select value={connId} onChange={(e) => setConnId(e.target.value)}>
          <option value={app.labConnectionId}>Laboratório</option>
          {app.connections.map((c) => (
            <option key={c.id} value={c.id}>
              Como {c.client.name} · {AUTH_LABEL[c.authType]}
            </option>
          ))}
        </select>
        <span className="hint mono truncate">{testBase || 'Sem URL base: defina no app ou no vínculo do cliente.'}</span>
        <div className="seg seg-small">
          <button className={mode === 'message' ? 'on' : ''} onClick={() => setMode('message')}>
            Mensagem (IA)
          </button>
          <button className={mode === 'json' ? 'on' : ''} onClick={() => setMode('json')}>
            Argumentos (JSON)
          </button>
        </div>
        {mode === 'message' ? (
          <>
            {!ai?.configured && <div className="callout warn small">Defina OPENAI_API_KEY no server/.env para testar por mensagem.</div>}
            <textarea
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Escreva como um usuário pediria. Ex.: Qual o status do pet 7?"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && message.trim() && testBase && ai?.configured) runMessage()
              }}
            />
            <span className="hint">A IA lê a mensagem, decide se chama esta tool e com quais argumentos, executa de verdade e responde.</span>
            <button className="btn" disabled={running || !testBase || !message.trim() || !ai?.configured} onClick={runMessage}>
              {running ? 'IA executando…' : 'Testar com IA'}
            </button>
          </>
        ) : (
          <>
            <textarea rows={6} className="mono" value={args} onChange={(e) => setArgs(e.target.value)} />
            <button className="btn" disabled={running || !testBase} onClick={run}>
              {running ? 'Executando…' : 'Testar chamada'}
            </button>
          </>
        )}
      </div>
      {mode === 'message' && aiResult && (
        <div className="ai-test">
          {aiResult.toolCalled ? (
            <>
              <div className="small">
                <b>1. A IA chamou</b> <span className="mono">{tool.name}</span> com:
              </div>
              <pre className="code">{JSON.stringify(aiResult.args, null, 2)}</pre>
              {aiResult.result && <UpstreamResultBox result={aiResult.result} title="2. Retorno da API" />}
              <div className="small">
                <b>3. Resposta da IA</b> <span className="muted">({aiResult.model})</span>
              </div>
              <div className="callout small ai-reply">{aiResult.reply || '(sem texto)'}</div>
            </>
          ) : (
            <>
              <div className="callout warn small">
                <b>A IA não chamou a tool.</b> Veja a resposta abaixo; talvez falte informação na mensagem ou a descrição da tool não
                deixe claro quando usá-la.
              </div>
              <div className="callout small ai-reply">{aiResult.reply}</div>
            </>
          )}
        </div>
      )}
      {mode === 'json' && result && <UpstreamResultBox result={result} />}
    </aside>
  )
}

function UpstreamResultBox({ result, title }: { result: UpstreamResult; title?: string }) {
  return (
    <div className={`callout ${result.ok ? 'ok' : 'err'} small`}>
      {title && <b>{title}</b>}
      <div className="mono">
        {result.error ? `Erro: ${result.error}` : `HTTP ${result.status}`} · {result.ms} ms
      </div>
      <div className="mono muted truncate">{result.url}</div>
      {result.request?.curl && (
        <details>
          <summary className="small">curl enviado (credenciais mascaradas)</summary>
          <div className="row between">
            <span />
            <Copy text={result.request.curl} />
          </div>
          <pre className="code">{result.request.curl}</pre>
        </details>
      )}
      {result.text && <pre className="code">{result.text}</pre>}
    </div>
  )
}

/* ----------------------------- app settings ----------------------------- */

function AppSettingsTab({ app, notify, reload }: { app: AppFull; notify: Notify; reload: () => void }) {
  const [name, setName] = useState(app.name)
  const [baseUrl, setBaseUrl] = useState(app.baseUrl)
  const [reUrl, setReUrl] = useState(app.source.url ?? '')

  const save = async () => {
    try {
      await api.updateApp(app.id, { name, baseUrl })
      notify('Configuração salva.')
      reload()
    } catch (e: any) {
      notify(e.message, true)
    }
  }

  return (
    <div className="narrow">
      <h3>MCP App</h3>
      <label className="field">
        Nome
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        URL base da documentação
        <input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.exemplo.com.br/v1" />
        <span className="hint">Valor inicial sugerido para o laboratório e para novos clientes. Cada um pode usar a sua.</span>
      </label>
      <button className="btn primary" onClick={save}>
        Salvar
      </button>

      <h3>Reimportar documentação</h3>
      <p className="muted small">
        Atualiza as tools pelo método + path. Tools cujo contrato mudou voltam para rascunho; edições e aprovações das demais são
        mantidas.
      </p>
      <div className="row gap">
        <input className="grow mono" value={reUrl} onChange={(e) => setReUrl(e.target.value)} placeholder="URL da documentação" />
        <button
          className="btn"
          disabled={!reUrl}
          onClick={async () => {
            try {
              const r = await api.reimport(app.id, { url: reUrl })
              notify(`+${r.added.length} novas · ${r.changed.length} alteradas · ${r.removed.length} removidas`)
              reload()
            } catch (e: any) {
              notify(e.message, true)
            }
          }}
        >
          Reimportar
        </button>
      </div>

      <h3>Zona de perigo</h3>
      <button
        className="btn danger"
        onClick={async () => {
          const n = app.connections.length
          if (!confirm(`Excluir o app "${app.name}", todas as suas tools${n ? ` e os vínculos com ${n} cliente(s)` : ''}?`)) return
          await api.deleteApp(app.id)
          location.hash = ''
          reload()
        }}
      >
        Excluir app
      </button>
    </div>
  )
}

/* ------------------------------- clientes ------------------------------- */

const onlyDigits = (s?: string) => (s ?? '').replace(/\D/g, '')

function NewClientPage({ notify, onDone }: { notify: Notify; onDone: () => void }) {
  const [orgs, setOrgs] = useState<NexusOrg[] | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback((refresh = false) => {
    setErr('')
    setOrgs(null)
    api
      .nexusOrgs(refresh)
      .then(setOrgs)
      .catch((e) => {
        setErr(e.message)
        setOrgs([])
      })
  }, [])
  useEffect(() => load(), [load])

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    const d = onlyDigits(q)
    if (!orgs) return []
    if (!t) return orgs
    return orgs.filter(
      (o) =>
        o.name.toLowerCase().includes(t) ||
        o.tradeName?.toLowerCase().includes(t) ||
        (d.length >= 3 && onlyDigits(o.document).includes(d)),
    )
  }, [orgs, q])

  const create = async (b: Parameters<typeof api.createClient>[0], key: string) => {
    setBusy(key)
    try {
      const c = await api.createClient(b)
      notify(`Cliente ${c.name} cadastrado. Agora vincule um MCP App.`)
      onDone()
      location.hash = `client/${c.id}`
    } catch (e: any) {
      notify(e.message, true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="page">
      <div className="crumbs small muted">
        <a href="#clients">Clientes</a> › Novo
      </div>
      <h1>Novo cliente</h1>
      <p className="lead">Só organizações cadastradas no Nexus podem virar clientes. O nome, o nome fantasia e o documento vêm de lá.</p>

      <div className="row gap toolbar">
        <input className="search grow" placeholder="Buscar por razão social, nome fantasia ou CNPJ" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => load(true)} disabled={orgs === null}>
          Atualizar lista
        </button>
      </div>

      {err && (
        <div className="callout err small">
          <b>Não foi possível listar as organizações do Nexus.</b>
          <div>{err}</div>
          <div className="muted">O cadastro de clientes só é feito a partir do Nexus. Corrija a integração e clique em Atualizar lista.</div>
        </div>
      )}
      {orgs === null && <div className="muted small pad">Carregando organizações do Nexus…</div>}

      {orgs && orgs.length > 0 && (
        <>
          <div className="small muted">
            {filtered.length} de {orgs.length} organizações
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Razão social</th>
                  <th>Nome fantasia</th>
                  <th>Documento</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 300).map((o) => (
                  <tr key={o.id} className="no-pointer">
                    <td>
                      {o.name} {o.active === false && <span className="badge disabled">Inativa</span>}
                    </td>
                    <td className="small">{o.tradeName ?? <span className="muted">—</span>}</td>
                    <td className="mono small nowrap">{o.document ?? '—'}</td>
                    <td className="right nowrap">
                      {o.clientId ? (
                        <a className="btn small" href={`#client/${o.clientId}`}>
                          Já cadastrado ›
                        </a>
                      ) : (
                        <button className="btn small primary" disabled={!!busy} onClick={() => create({ nexusOrgId: o.id }, o.id)}>
                          {busy === o.id ? 'Cadastrando…' : 'Cadastrar'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted center pad">
                      Nenhuma organização encontrada.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {filtered.length > 300 && <div className="small muted">Mostrando 300. Refine a busca.</div>}
        </>
      )}

    </div>
  )
}

function ClientPage({ id, apps, notify, onChange }: { id: string; apps: AppSummary[]; notify: Notify; onChange: () => void }) {
  const [client, setClient] = useState<Client | null>(null)
  const [pick, setPick] = useState('')
  const [slug, setSlug] = useState('')
  const load = useCallback(
    () =>
      api
        .client(id)
        .then((c) => {
          setClient(c)
          setSlug(c.slug)
        })
        .catch((e) => notify(e.message, true)),
    [id, notify],
  )
  useEffect(() => {
    load()
  }, [load])

  if (!client) return <div className="page muted">Carregando…</div>
  const linked = new Set(client.connections.map((c) => c.app.id))
  const available = apps.filter((a) => !linked.has(a.id))

  const link = async () => {
    try {
      const conn = await api.createConnection(client.id, { appId: pick })
      notify(`${conn.app.name} vinculado. Configure a URL base e a credencial deste cliente.`)
      onChange()
      location.hash = `client/${client.id}/${conn.id}`
    } catch (e: any) {
      notify(e.message, true)
    }
  }

  return (
    <div className="page wide">
      <div className="crumbs small muted">
        <a href="#clients">Clientes</a> › {client.tradeName || client.name}
      </div>
      <h1>{client.tradeName || client.name}</h1>
      <div className="muted small">
        {client.tradeName && <>{client.name} · </>}
        {client.document && <span className="mono">{client.document} · </span>}
        {client.nexusOrgId ? (
          <span>
            Nexus <span className="mono">{client.nexusOrgId}</span>
          </span>
        ) : (
          <span className="badge draft">sem vínculo com o Nexus</span>
        )}
      </div>

      <h3>MCP Apps do cliente</h3>
      <div className="row gap wrap toolbar">
        <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ maxWidth: 360 }}>
          <option value="">Vincular MCP App…</option>
          {available.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.counts.approved} tools aprovadas)
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={!pick} onClick={link}>
          Vincular
        </button>
        {apps.length === 0 && (
          <a className="btn" href="#import">
            + Importar API
          </a>
        )}
      </div>
      <ConnectionsTable rows={client.connections} show="app" />

      <h3>Logs de Requisições do cliente</h3>
      <InvocationsPage client={client.slug} embedded />

      <div className="narrow">
        <h3>Identificador na URL do MCP</h3>
        <p className="muted small">
          Aparece em <code>/mcp/{client.slug}/&lt;app&gt;</code>. Se mudar, atualize a URL nos clientes MCP já conectados.
        </p>
        <div className="row gap">
          <input className="mono grow" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
          <button
            className="btn"
            disabled={slug === client.slug}
            onClick={async () => {
              try {
                await api.updateClient(client.id, { slug })
                notify('Identificador atualizado.')
                load()
                onChange()
              } catch (e: any) {
                notify(e.message, true)
              }
            }}
          >
            Salvar
          </button>
        </div>

        <h3>Zona de perigo</h3>
        <button
          className="btn danger"
          onClick={async () => {
            if (!confirm(`Excluir o cliente "${client.name}" e os vínculos com ${client.connections.length} MCP App(s)?`)) return
            await api.deleteClient(client.id)
            onChange()
            location.hash = ''
          }}
        >
          Excluir cliente
        </button>
      </div>
    </div>
  )
}

/* ------------------------ cliente › app (vínculo) ------------------------ */

type ConnTab = 'settings' | 'connect' | 'logs'

function ConnectionPage({ id, notify, onChange }: { id: string; notify: Notify; onChange: () => void }) {
  const [conn, setConn] = useState<Connection | null>(null)
  const [tab, setTab] = useState<ConnTab>('settings')
  const load = useCallback(() => api.connection(id).then(setConn).catch((e) => notify(e.message, true)), [id, notify])
  useEffect(() => {
    load()
  }, [load])
  const reload = useCallback(() => {
    load()
    onChange()
  }, [load, onChange])

  if (!conn) return <div className="page muted">Carregando…</div>
  return (
    <div className="page wide">
      <div className="crumbs small muted">
        {conn.lab ? (
          <>
            <a href="#apps">MCP Apps</a> › <a href={`#app/${conn.app.id}`}>{conn.app.name}</a> › Laboratório
          </>
        ) : (
          <>
            <a href="#clients">Clientes</a> › <a href={`#client/${conn.client.id}`}>{conn.client.name}</a> › {conn.app.name}
          </>
        )}
      </div>
      <div className="row between">
        <div>
          <h1>
            {conn.app.name} <span className="muted h-sub">· {conn.client.name}</span>
          </h1>
          <div className="muted small mono">{conn.effectiveBaseUrl || 'sem URL base'}</div>
        </div>
        <div className="row gap">
          <span className={`badge ${conn.enabled ? 'approved' : 'disabled'}`}>{conn.enabled ? 'Ativo' : 'Desativado'}</span>
          <a className="btn small" href={`#app/${conn.app.id}`}>
            Tools do app ({conn.app.approvedTools} aprovadas) ›
          </a>
        </div>
      </div>
      {!conn.effectiveBaseUrl && <div className="callout warn">Defina a URL base da API deste cliente na aba Configuração.</div>}
      <div className="tabs">
        {(
          [
            ['settings', 'Dados da API'],
            ['connect', 'Conexão'],
            ['logs', 'Logs de Requisições'],
          ] as [ConnTab, string][]
        ).map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'settings' && <ConnSettingsTab conn={conn} notify={notify} reload={reload} />}
      {tab === 'connect' && <ConnectTab conn={conn} notify={notify} reload={reload} />}
      {tab === 'logs' && <InvocationsPage client={conn.client.slug} app={conn.app.slug} embedded />}
    </div>
  )
}

function AuthFields({ auth, setAuth }: { auth: Auth; setAuth: (a: Auth) => void }) {
  const setType = (type: Auth['type']) =>
    setAuth(
      type === 'none'
        ? { type }
        : type === 'bearer'
          ? { type, token: '' }
          : type === 'basic'
            ? { type, username: '', password: '' }
            : { type, headerName: 'X-API-Key', value: '', in: 'header' },
    )
  return (
    <>
      <label className="field">
        Autenticação na API
        <select value={auth.type} onChange={(e) => setType(e.target.value as Auth['type'])}>
          <option value="none">Nenhuma</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic (usuário/senha)</option>
          <option value="apiKey">API key</option>
        </select>
      </label>
      {auth.type === 'bearer' && (
        <label className="field">
          Token
          <input type="password" value={auth.token} onChange={(e) => setAuth({ ...auth, token: e.target.value })} />
        </label>
      )}
      {auth.type === 'basic' && (
        <div className="grid2">
          <label className="field">
            Usuário
            <input value={auth.username} onChange={(e) => setAuth({ ...auth, username: e.target.value })} />
          </label>
          <label className="field">
            Senha
            <input type="password" value={auth.password} onChange={(e) => setAuth({ ...auth, password: e.target.value })} />
          </label>
        </div>
      )}
      {auth.type === 'apiKey' && (
        <div className="grid3">
          <label className="field">
            Nome
            <input value={auth.headerName} onChange={(e) => setAuth({ ...auth, headerName: e.target.value })} />
          </label>
          <label className="field">
            Enviar em
            <select value={auth.in ?? 'header'} onChange={(e) => setAuth({ ...auth, in: e.target.value as any })}>
              <option value="header">Header</option>
              <option value="query">Query string</option>
            </select>
          </label>
          <label className="field">
            Valor
            <input type="password" value={auth.value} onChange={(e) => setAuth({ ...auth, value: e.target.value })} />
          </label>
        </div>
      )}
    </>
  )
}

function ConnSettingsTab({ conn, notify, reload }: { conn: Connection; notify: Notify; reload: () => void }) {
  const [baseUrl, setBaseUrl] = useState(conn.baseUrl)
  const [auth, setAuth] = useState<Auth>(conn.auth)
  const [headers, setHeaders] = useState(JSON.stringify(conn.extraHeaders, null, 2))
  const who = conn.lab ? 'de laboratório' : `de ${conn.client.name}`

  const save = async () => {
    let extraHeaders: Record<string, string>
    try {
      extraHeaders = JSON.parse(headers || '{}')
    } catch {
      return notify('Headers extras não são JSON válido.', true)
    }
    try {
      await api.updateConnection(conn.id, { baseUrl, auth, extraHeaders })
      notify(conn.lab ? 'Configuração de laboratório salva.' : 'Configuração do cliente salva.')
      reload()
    } catch (e: any) {
      notify(e.message, true)
    }
  }

  return (
    <div className="narrow">
      {conn.lab && (
        <div className="callout ok small">
          <b>Laboratório:</b> configuração direta deste MCP App, para testes (playground e endpoint <code>/mcp/lab/{conn.app.slug}</code>).
          Cada cliente tem a sua própria configuração e conexão, separadas desta.
        </div>
      )}
      <h3>Dados da API {who}</h3>
      <label className="field">
        URL base
        <input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={conn.app.baseUrl || 'https://api.exemplo.com.br/v1'} />
        <span className="hint">
          Cada tool concatena seu path a esta URL. Chamadas para fora dela são bloqueadas.
          {conn.app.baseUrl && !baseUrl && (
            <>
              {' '}
              Em branco usa a URL da documentação: <span className="mono">{conn.app.baseUrl}</span>.
            </>
          )}
        </span>
      </label>
      <AuthFields auth={auth} setAuth={setAuth} />
      <label className="field">
        Headers extras (JSON)
        <textarea rows={3} className="mono" value={headers} onChange={(e) => setHeaders(e.target.value)} />
      </label>
      <button className="btn primary" onClick={save}>
        Salvar configuração
      </button>

      <h3>Status</h3>
      <label className="row gap">
        <input
          type="checkbox"
          checked={conn.enabled}
          onChange={async (e) => {
            await api.updateConnection(conn.id, { enabled: e.target.checked })
            notify(e.target.checked ? 'Conexão ativada.' : 'Conexão desativada: o endpoint MCP para de responder e não emite tokens.')
            reload()
          }}
        />
        Conexão ativa (desmarque para bloquear o MCP {who} sem perder a configuração)
      </label>

      {!conn.lab && (
        <>
          <h3>Zona de perigo</h3>
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm(`Desvincular ${conn.app.name} de ${conn.client.name}? A configuração, as credenciais OAuth e os tokens serão apagados.`))
                return
              await api.deleteConnection(conn.id)
              reload()
              location.hash = `client/${conn.client.id}`
            }}
          >
            Desvincular app do cliente
          </button>
        </>
      )}
    </div>
  )
}

const fmtTtl = (s: number) => (s % 3600 === 0 ? `${s / 3600} horas` : `${Math.round(s / 60)} minutos`)

function Secret({ value }: { value: string }) {
  const [show, setShow] = useState(false)
  return (
    <span className="row gap">
      <code className="truncate">{show ? value : `${value.slice(0, 9)}${'•'.repeat(16)}`}</code>
      <button className="btn small ghost" onClick={() => setShow(!show)}>
        {show ? 'Ocultar' : 'Mostrar'}
      </button>
      <Copy text={value} />
    </span>
  )
}

function ConnectTab({ conn, notify, reload }: { conn: Connection; notify: Notify; reload: () => void }) {
  const [cfg, setCfg] = useState<ClientConfig | null>(null)
  const [token, setToken] = useState<OAuthToken | null>(null)
  const [authing, setAuthing] = useState(false)
  useEffect(() => {
    api.connectionConfig(conn.id).then(setCfg)
  }, [conn.id, conn.requireAccessKey])
  // credenciais trocadas: o token mostrado deixou de valer
  useEffect(() => setToken(null), [conn.oauth.clientId])

  const authenticate = async () => {
    setAuthing(true)
    try {
      const t = await api.oauthToken(conn.oauth.clientId, conn.oauth.clientSecret)
      setToken(t)
      try {
        await navigator.clipboard.writeText(t.access_token)
        notify('Token gerado e copiado.')
      } catch {
        notify('Token gerado. Use o botão Copiar.')
      }
      reload()
    } catch (e: any) {
      notify(e.message, true)
    } finally {
      setAuthing(false)
    }
  }

  if (!cfg) return null
  const tokenValue = token?.access_token ?? '<TOKEN>'
  const servers = JSON.parse(JSON.stringify(cfg.mcpServers).replaceAll('<TOKEN>', tokenValue))
  const json = JSON.stringify({ mcpServers: servers }, null, 2)
  const who = conn.lab ? 'Laboratório' : conn.client.name

  return (
    <div className="narrow">
      {conn.app.approvedTools === 0 && <div className="callout warn">Nenhuma tool aprovada no app: o cliente MCP vai listar 0 tools.</div>}
      {!conn.enabled && <div className="callout err">Conexão desativada: o endpoint recusa as chamadas e não emite tokens.</div>}

      <h3>Endpoint MCP · {who}</h3>
      <div className="kv">
        <span>Tipo</span>
        <code>Streamable HTTP</code>
        <span>URL</span>
        <span className="row gap">
          <code className="truncate">{cfg.url}</code>
          <Copy text={cfg.url} />
        </span>
        <span>Header</span>
        {conn.requireAccessKey ? <code className="truncate">Authorization: Bearer &lt;token&gt;</code> : <span className="muted">nenhum (acesso aberto)</span>}
      </div>
      {conn.legacyUrl && (
        <p className="hint">
          Endereço antigo (antes dos clientes) também responde, com o mesmo token: <code>{conn.legacyUrl}</code>
        </p>
      )}
      <label className="row gap small">
        <input
          type="checkbox"
          checked={conn.requireAccessKey}
          onChange={async (e) => {
            if (!e.target.checked && !confirm('Desligar a autenticação deixa o endpoint MCP aberto para qualquer um que tenha a URL. Continuar?')) return
            await api.updateConnection(conn.id, { requireAccessKey: e.target.checked })
            reload()
          }}
        />
        Exigir Bearer token (OAuth 2.0)
      </label>

      <h3>Autenticação OAuth 2.0 (client credentials)</h3>
      <p className="muted small">
        O cliente MCP troca o <code>client_id</code> e o <code>client_secret</code> por um Bearer token no endpoint abaixo. O token vale{' '}
        <b>{fmtTtl(conn.oauth.tokenTtlSeconds)}</b> e só funciona no endpoint MCP desta conexão.
      </p>
      {!conn.oauth.canManage ? (
        <div className="callout warn small">
          Seu perfil não tem permissão para ver o <code>client_secret</code> nem gerar tokens. Token URL:{' '}
          <code>{conn.oauth.tokenUrl}</code> · client_id: <code>{conn.oauth.clientId}</code>
        </div>
      ) : (
        <>
      <div className="kv kv-wide">
        <span>Token URL</span>
        <span className="row gap">
          <code className="truncate">{conn.oauth.tokenUrl}</code>
          <Copy text={conn.oauth.tokenUrl} />
        </span>
        <span>client_id</span>
        <span className="row gap">
          <code className="truncate">{conn.oauth.clientId}</code>
          <Copy text={conn.oauth.clientId} />
        </span>
        <span>client_secret</span>
        <Secret value={conn.oauth.clientSecret} />
        <span>Tokens ativos</span>
        <span className="row gap">
          <span>{conn.oauth.activeTokens}</span>
          {conn.oauth.activeTokens > 0 && (
            <button
              className="btn small ghost"
              onClick={async () => {
                if (!confirm('Revogar todos os tokens ativos? Quem estiver conectado precisará autenticar de novo.')) return
                const r = await api.revokeTokens(conn.id)
                setToken(null)
                notify(`${r.revoked} token(s) revogado(s).`)
                reload()
              }}
            >
              Revogar todos
            </button>
          )}
        </span>
      </div>
      <div className="row gap wrap">
        <button
          className="btn"
          onClick={async () => {
            if (!confirm('Gerar novos client_id e client_secret? Os atuais deixam de funcionar e todos os tokens emitidos com eles são revogados.'))
              return
            await api.rotateCredentials(conn.id)
            notify('Novas credenciais geradas. Os tokens anteriores foram revogados.')
            reload()
          }}
        >
          Gerar novas credenciais
        </button>
        <span className="hint">Gerado em {fmtDate(conn.oauth.createdAt)}</span>
      </div>

      <h3>Gerar token</h3>
      <div className="row between">
        <span className="small muted">curl de autenticação</span>
        <Copy text={conn.oauth.curl} label="Copiar curl" />
      </div>
      <pre className="code">{conn.oauth.curl}</pre>
      <div className="row gap wrap" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={authing || !conn.enabled} onClick={authenticate}>
          {authing ? 'Autenticando…' : 'Autenticar e copiar token'}
        </button>
      </div>
      {token && (
        <div className="callout ok small">
          <div className="row between">
            <b>Bearer token</b>
            <Copy text={token.access_token} />
          </div>
          <code className="token">{token.access_token}</code>
          <div className="muted">Expira em {fmtDate(token.expires_at)}.</div>
        </div>
      )}

        </>
      )}

      <h3>Cherry Studio</h3>
      <ol className="steps small">
        <li>
          Clique em <b>Autenticar e copiar token</b> (ou rode o curl acima) para obter o Bearer token.
        </li>
        <li>
          No Cherry, abra <b>Configurações → Servidores MCP → Adicionar servidor</b>, tipo <b>Streamable HTTP (streamableHttp)</b>, e cole a
          URL do endpoint.
        </li>
        <li>
          Em <b>Headers</b>, adicione <code>Authorization=Bearer &lt;token&gt;</code>.
        </li>
        <li>Salve, ative o servidor e habilite o MCP no chat.</li>
      </ol>
      <div className="callout warn small">
        O token expira em {fmtTtl(conn.oauth.tokenTtlSeconds)}. Clientes que só aceitam header fixo (como o Cherry) precisam receber um token novo
        quando ele expirar.
      </div>
      <p className="muted small">Ou use “Importar do JSON”{token ? ' (já com o token gerado)' : ''}:</p>
      <div className="row between">
        <span />
        <Copy text={json} label="Copiar JSON" />
      </div>
      <pre className="code">{json}</pre>
      <p className="hint">
        O cliente MCP precisa alcançar esta URL. Se ele roda em outra máquina, defina <code>PUBLIC_URL</code> no servidor com o endereço
        acessível (ex.: IP da rede ou túnel).
      </p>
    </div>
  )
}

/* --------------------------- logs de requisições --------------------------- */

/** Converte o valor de <input type="datetime-local"> (hora local) para ISO/UTC. */
const localToIso = (v: string) => (v ? new Date(v).toISOString() : '')

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

const statusClass = (r: { ok: boolean; status: number | null }) =>
  r.ok ? 'approved' : r.status !== null && r.status < 500 ? 'draft' : 'error'

const EMPTY_FILTER = { app: '', client: '', id: '', tool: '', status: '', from: '', to: '' }

function InvocationsPage({ app: slug, client: clientSlug, embedded }: { app?: string; client?: string; embedded?: boolean }) {
  const [rows, setRows] = useState<Invocation[]>([])
  const [apps, setApps] = useState<AppSummary[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [f, setF] = useState(EMPTY_FILTER)
  const [sel, setSel] = useState<string | null>(null)
  const [auto, setAuto] = useState(true)
  const set = (k: keyof typeof EMPTY_FILTER) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))

  const query: InvocationFilter = useMemo(
    () => ({
      app: slug ?? f.app,
      client: clientSlug ?? f.client,
      id: f.id.trim(),
      tool: f.tool.trim(),
      status: f.status.trim(),
      from: localToIso(f.from),
      to: localToIso(f.to),
    }),
    [slug, clientSlug, f],
  )

  useEffect(() => {
    if (!slug) api.apps().then(setApps).catch(() => {})
    if (!clientSlug) api.clients().then(setClients).catch(() => {})
  }, [slug, clientSlug])

  useEffect(() => {
    let alive = true
    const load = () => api.invocations(query).then((r) => alive && setRows(r)).catch(() => {})
    const t0 = setTimeout(load, 250) // espera o usuário parar de digitar
    const t = auto ? setInterval(load, 5000) : undefined
    return () => {
      alive = false
      clearTimeout(t0)
      if (t) clearInterval(t)
    }
  }, [query, auto])

  const tools = useMemo(() => [...new Set(rows.map((r) => r.tool))].sort(), [rows])
  const codes = useMemo(() => [...new Set(rows.map((r) => r.status).filter((s): s is number => s !== null))].sort(), [rows])
  const errors = rows.filter((r) => !r.ok).length
  const active = Object.entries(f).some(([k, v]) => v && !(slug && k === 'app') && !(clientSlug && k === 'client'))
  const cols = 6 + (slug ? 0 : 1) + (clientSlug ? 0 : 1)

  return (
    <div className={embedded ? '' : 'page wide'}>
      {!embedded && <h1>Logs de Requisições</h1>}
      {!embedded && (
        <p className="lead">
          Cada chamada de tool recebe um código (<code>RQ-…</code>) que também vai na resposta do MCP. Clique numa linha para ver a
          requisição ao MCP, o curl enviado à API e o retorno de cada um.
        </p>
      )}

      <div className="filters">
        <label className="field">
          De
          <input type="datetime-local" step={1} value={f.from} onChange={set('from')} />
        </label>
        <label className="field">
          Até
          <input type="datetime-local" step={1} value={f.to} onChange={set('to')} />
        </label>
        {!clientSlug && (
          <label className="field">
            Cliente
            <select value={f.client} onChange={set('client')}>
              <option value="">Todos</option>
              <option value="lab">Laboratório</option>
              {clients.map((c) => (
                <option key={c.id} value={c.slug}>
                  {c.tradeName || c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!slug && (
          <label className="field">
            App
            <select value={f.app} onChange={set('app')}>
              <option value="">Todos</option>
              {apps.map((a) => (
                <option key={a.id} value={a.slug}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Código
          <input className="mono" placeholder="RQ-…" value={f.id} onChange={set('id')} />
        </label>
        <label className="field">
          Tool
          <input list="log-tools" placeholder="Nome da tool" value={f.tool} onChange={set('tool')} />
          <datalist id="log-tools">
            {tools.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="field">
          Status HTTP
          <input list="log-status" placeholder="200, 4xx, erro…" value={f.status} onChange={set('status')} />
          <datalist id="log-status">
            {['2xx', '3xx', '4xx', '5xx', 'erro', 'sem resposta', ...codes.map(String)].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
      </div>

      <div className="row between small muted">
        <span>
          {rows.length} requisições{rows.length >= 200 ? ' (mostrando as 200 mais recentes)' : ''} · {errors} com erro
        </span>
        <span className="row gap">
          <label className="row gap">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Atualizar a cada 5 s
          </label>
          {active && (
            <button className="btn small" onClick={() => setF(EMPTY_FILTER)}>
              Limpar filtros
            </button>
          )}
        </span>
      </div>

      <div className={`split ${sel ? 'with-panel log-split' : ''}`}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Código</th>
                <th>Quando</th>
                {!clientSlug && <th>Cliente</th>}
                {!slug && <th>App</th>}
                <th>Tool</th>
                <th>Status</th>
                <th>Latência</th>
                <th>Erro</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={sel === r.id ? 'sel' : ''} onClick={() => setSel(sel === r.id ? null : r.id)}>
                  <td className="mono small nowrap">{r.id}</td>
                  <td className="small nowrap">{fmtDate(r.at)}</td>
                  {!clientSlug && <td className="small truncate">{r.clientName ?? <span className="muted">—</span>}</td>}
                  {!slug && <td className="mono small">{r.appSlug}</td>}
                  <td className="mono small">{r.tool}</td>
                  <td>
                    <span className={`badge ${statusClass(r)}`}>{r.status ?? '—'}</span>
                  </td>
                  <td className="small nowrap">{r.ms} ms</td>
                  <td className="small muted truncate">{r.error ?? ''}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={cols} className="muted center pad">
                    {active ? 'Nenhuma requisição com esses filtros.' : 'Nenhuma chamada ainda. Conecte um cliente MCP e use uma tool.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sel && <InvocationPanel id={sel} onClose={() => setSel(null)} />}
      </div>
    </div>
  )
}

function CodeBlock({ title, text, copy }: { title: string; text: string; copy?: boolean }) {
  return (
    <div className="log-block">
      <div className="row between">
        <strong className="small">{title}</strong>
        {copy && <Copy text={text} />}
      </div>
      <pre className="code">{text}</pre>
    </div>
  )
}

function InvocationPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<InvocationDetail | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    setD(null)
    setErr('')
    api.invocation(id).then(setD).catch((e) => setErr(String(e.message ?? e)))
  }, [id])

  const mcpReq = d?.mcp?.request as { http?: { method: string; url: string; headers: Record<string, string> }; body?: unknown } | undefined
  const httpLine = mcpReq?.http
    ? `${mcpReq.http.method} ${location.origin}${mcpReq.http.url}\n${Object.entries(mcpReq.http.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')}\n\n${pretty(mcpReq.body)}`
    : d?.mcp
      ? pretty(d.mcp.request)
      : ''
  const up = d?.upstream
  const upResp = up?.response
  const upRespText = upResp
    ? `HTTP ${upResp.status ?? '—'}\n${Object.entries(upResp.headers ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')}\n\n${upResp.body}`
    : ''

  return (
    <aside className="panel log-panel">
      <div className="row between">
        <div>
          <div className="mono" style={{ fontWeight: 700 }}>
            {id} <Copy text={id} label="Copiar código" />
          </div>
          {d && (
            <div className="small muted">
              {fmtDate(d.at)} · {d.clientName ? `${d.clientName} · ` : ''}
              {d.appSlug} · <span className="mono">{d.tool}</span> · {d.ms} ms
            </div>
          )}
        </div>
        <button className="btn small" onClick={onClose}>
          Fechar
        </button>
      </div>
      {err && <div className="callout err">{err}</div>}
      {!d && !err && <div className="muted small">Carregando…</div>}
      {d && (
        <>
          {d.error && <div className="callout err small">{d.error}</div>}
          <h3 className="log-h">1. Requisição recebida pelo MCP</h3>
          {d.mcp ? <CodeBlock title="Cliente MCP → MCP Forge" text={httpLine} copy /> : <p className="muted small">Log antigo, sem detalhes.</p>}
          <h3 className="log-h">2. Requisição enviada à API do sistema</h3>
          {up ? (
            <>
              <div className="small">
                <span className={`method ${up.method.toLowerCase()}`}>{up.method}</span>
                <span className="mono">{up.url}</span>
              </div>
              <CodeBlock title="curl (credenciais mascaradas)" text={up.curl} copy />
            </>
          ) : (
            <p className="muted small">A requisição não chegou a ser montada (veja o erro acima).</p>
          )}
          <h3 className="log-h">3. Retorno direto da API</h3>
          {upResp ? (
            <CodeBlock title={`Status ${upResp.status ?? '—'}`} text={upRespText} copy />
          ) : (
            <p className="muted small">Sem resposta da API{d.error ? ` — ${d.error}` : ''}.</p>
          )}
          <h3 className="log-h">4. Retorno do MCP ao cliente</h3>
          {d.mcp ? <CodeBlock title="MCP Forge → Cliente MCP" text={pretty(d.mcp.response)} copy /> : <p className="muted small">—</p>}
        </>
      )}
    </aside>
  )
}
