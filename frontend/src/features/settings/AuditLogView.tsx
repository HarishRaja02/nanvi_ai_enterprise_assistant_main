import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Shield,
  ShieldCheck,
  RefreshCw,
  Search,
  Filter,
  User,
  Copy,
  Check,
  Eye,
  X,
  Clock,
  Bot,
  Database,
  Mail,
  Cloud,
  Download,
  Lock,
  Activity,
  Layers,
  Sparkles,
} from "lucide-react";
import { Button } from "../../components/ui/Button";
import type { LocalAccount, NanviApiClient, UserIdentity } from "../../api";
import "./AuditLogView.css";

type Props = {
  api: NanviApiClient;
  identity?: UserIdentity | null;
};

export interface AuditEvent {
  id: string;
  tenant_id?: string;
  actor_user_id?: string;
  actor_username?: string;
  actor_name?: string;
  actor_role?: string;
  raw_actor_id?: string;
  connection_id?: string;
  provider?: string;
  event: string;
  safe_metadata?: any;
  ip?: string;
  created_at?: string;
}

interface ResolvedActor {
  userId: string;
  name: string;
  role: string;
  isSystem: boolean;
  rawId: string;
}

const AVATAR_COLORS = [
  "linear-gradient(135deg, #3b82f6, #1d4ed8)",
  "linear-gradient(135deg, #10b981, #047857)",
  "linear-gradient(135deg, #8b5cf6, #6d28d9)",
  "linear-gradient(135deg, #f59e0b, #d97706)",
  "linear-gradient(135deg, #ec4899, #be185d)",
  "linear-gradient(135deg, #06b6d4, #0e7490)",
];

function getAvatarColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(nameOrId: string): string {
  if (!nameOrId) return "U";
  const clean = nameOrId.trim();
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

const isUuid = (val: string): boolean => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
};

export function AuditLogView({ api, identity }: Props) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [accountsMap, setAccountsMap] = useState<Map<string, LocalAccount>>(new Map());
  const [search, setSearch] = useState("");
  const [eventFilter, setEventFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("all");
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Load account mappings to resolve UUIDs / account IDs into clean User IDs
  useEffect(() => {
    let active = true;
    if (typeof api.listLocalAccounts === "function") {
      api
        .listLocalAccounts()
        .then((accounts) => {
          if (!active || !Array.isArray(accounts)) return;
          const map = new Map<string, LocalAccount>();
          accounts.forEach((acc) => {
            if (acc.id) map.set(acc.id, acc);
            if (acc.username) map.set(acc.username.toLowerCase(), acc);
            if (acc.email) map.set(acc.email.toLowerCase(), acc);
          });
          setAccountsMap(map);
        })
        .catch(() => {
          // Non-blocking: continue with logs as received
        });
    }
    return () => {
      active = false;
    };
  }, [api]);

  const loadAudit = useCallback(
    async (isManualRefresh = false) => {
      try {
        if (isManualRefresh) setRefreshing(true);
        else setLoading(true);
        const data = await api.listConnectionAuditEvents();
        setEvents(data || []);
      } catch {
        setEvents([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [api]
  );

  useEffect(() => {
    loadAudit();
  }, [loadAudit]);

  // Resolve actor user info with high accuracy
  const resolveActor = useCallback(
    (evt: AuditEvent): ResolvedActor => {
      const rawActor = (evt.raw_actor_id || evt.actor_user_id || "").trim();
      const backendUser = (evt.actor_username || "").trim();
      const backendName = (evt.actor_name || "").trim();
      const backendRole = (evt.actor_role || "").trim();

      // Check if system
      if (!rawActor || rawActor.toLowerCase() === "system") {
        return {
          userId: "System",
          name: "Nanvi AI System",
          role: "System",
          isSystem: true,
          rawId: rawActor || "system",
        };
      }

      // Check local accounts map by ID, username, or email
      const matched =
        accountsMap.get(rawActor) ||
        accountsMap.get(rawActor.toLowerCase()) ||
        (backendUser ? accountsMap.get(backendUser.toLowerCase()) : undefined);

      if (matched) {
        return {
          userId: matched.username,
          name: matched.display_name || matched.username,
          role: matched.role || "Employee",
          isSystem: false,
          rawId: rawActor,
        };
      }

      // Check if current user identity matches
      if (
        identity &&
        (identity.subject === rawActor ||
          identity.subject.toLowerCase() === rawActor.toLowerCase() ||
          (identity.email && identity.email.toLowerCase() === rawActor.toLowerCase()))
      ) {
        const uId =
          (identity as any).preferred_username ||
          (identity.email ? identity.email.split("@")[0] : identity.name || "ceo2");
        return {
          userId: uId,
          name: identity.name || uId,
          role: identity.roles?.[0] || "Superior",
          isSystem: false,
          rawId: rawActor,
        };
      }

      // If backend already resolved to a human username
      if (backendUser && !isUuid(backendUser)) {
        return {
          userId: backendUser,
          name: backendName && backendName !== backendUser ? backendName : backendUser,
          role: backendRole || "Employee",
          isSystem: false,
          rawId: rawActor,
        };
      }

      // If rawActor is not a UUID (e.g. "admin", "ceo2", "harish")
      if (!isUuid(rawActor)) {
        return {
          userId: rawActor,
          name: backendName || rawActor,
          role: backendRole || "Employee",
          isSystem: false,
          rawId: rawActor,
        };
      }

      // If rawActor is a UUID that wasn't found in map:
      // Shorten gracefully so table remains clean and readable
      return {
        userId: `user_${rawActor.slice(0, 6)}`,
        name: `User (${rawActor.slice(0, 8)}...)`,
        role: backendRole || "Employee",
        isSystem: false,
        rawId: rawActor,
      };
    },
    [accountsMap, identity]
  );

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey(null);
    }, 2000);
  };

  // Format Action / Event display
  const formatEventInfo = (event: string) => {
    const clean = event.replace("CONNECTION_", "");
    switch (clean) {
      case "USED_BY_AGENT":
        return {
          label: "Agent Query Access",
          tone: "audit-action-agent",
          icon: <Bot size={13} />,
        };
      case "CREATED":
      case "OAUTH_CONNECTED":
        return {
          label: clean === "OAUTH_CONNECTED" ? "OAuth Connected" : "Connection Created",
          tone: "audit-action-success",
          icon: <Check size={13} />,
        };
      case "TESTED":
        return {
          label: "Connection Verified",
          tone: "audit-action-tested",
          icon: <ShieldCheck size={13} />,
        };
      case "DISCONNECTED":
      case "OAUTH_REVOKED":
        return {
          label: "Disconnected",
          tone: "audit-action-warning",
          icon: <Activity size={13} />,
        };
      case "ACCESS_DENIED":
      case "DENIED":
        return {
          label: "Access Denied",
          tone: "audit-action-danger",
          icon: <Lock size={13} />,
        };
      default:
        return {
          label: clean.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
          tone: "audit-action-neutral",
          icon: <Layers size={13} />,
        };
    }
  };

  // Format Provider display
  const formatProvider = (provider?: string) => {
    if (!provider) return { label: "General", dotClass: "" };
    const p = provider.toLowerCase();
    if (p === "outlook") return { label: "Outlook", dotClass: "outlook" };
    if (p === "microsoft365") return { label: "Microsoft 365", dotClass: "microsoft365" };
    if (p === "google") return { label: "Google Workspace", dotClass: "google" };
    if (p === "slack") return { label: "Slack", dotClass: "slack" };
    if (p === "postgres") return { label: "PostgreSQL", dotClass: "postgres" };
    return {
      label: provider.charAt(0).toUpperCase() + provider.slice(1),
      dotClass: "",
    };
  };

  // Format timestamp cleanly
  const formatTimestamp = (iso?: string) => {
    if (!iso) return { date: "—", time: "—" };
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return { date: iso, time: "" };
      return {
        date: d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        time: d.toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        }),
      };
    } catch {
      return { date: iso, time: "" };
    }
  };

  // Extract distinct providers and users for filters
  const { distinctProviders, distinctUsers } = useMemo(() => {
    const provs = new Set<string>();
    const users = new Set<string>();
    events.forEach((evt) => {
      if (evt.provider) provs.add(evt.provider);
      const actor = resolveActor(evt);
      if (actor.userId && !actor.isSystem) users.add(actor.userId);
    });
    return {
      distinctProviders: Array.from(provs),
      distinctUsers: Array.from(users),
    };
  }, [events, resolveActor]);

  // Filtered events
  const filteredEvents = useMemo(() => {
    return events.filter((evt) => {
      const actor = resolveActor(evt);
      const q = search.trim().toLowerCase();

      // Search matching
      if (q) {
        const matchesUser =
          actor.userId.toLowerCase().includes(q) ||
          actor.name.toLowerCase().includes(q) ||
          actor.rawId.toLowerCase().includes(q);
        const matchesEvent = evt.event.toLowerCase().includes(q);
        const matchesProvider = (evt.provider || "").toLowerCase().includes(q);
        const matchesMeta =
          typeof evt.safe_metadata === "object"
            ? JSON.stringify(evt.safe_metadata).toLowerCase().includes(q)
            : String(evt.safe_metadata || "").toLowerCase().includes(q);

        if (!matchesUser && !matchesEvent && !matchesProvider && !matchesMeta) {
          return false;
        }
      }

      // Event type filter
      if (eventFilter !== "all") {
        if (eventFilter === "agent" && !evt.event.includes("USED_BY_AGENT")) return false;
        if (eventFilter === "connection" && !(evt.event.includes("CREATED") || evt.event.includes("OAUTH")))
          return false;
        if (eventFilter === "test" && !evt.event.includes("TESTED")) return false;
        if (eventFilter === "disconnect" && !(evt.event.includes("DISCONNECTED") || evt.event.includes("DENIED")))
          return false;
      }

      // Provider filter
      if (providerFilter !== "all" && evt.provider !== providerFilter) {
        return false;
      }

      // User filter
      if (userFilter !== "all" && actor.userId !== userFilter) {
        return false;
      }

      return true;
    });
  }, [events, search, eventFilter, providerFilter, userFilter, resolveActor]);

  // KPI Metrics
  const metrics = useMemo(() => {
    const total = events.length;
    const uniqueActors = new Set<string>();
    const uniqueProviders = new Set<string>();

    events.forEach((e) => {
      const actor = resolveActor(e);
      uniqueActors.add(actor.userId);
      if (e.provider) uniqueProviders.add(e.provider);
    });

    return {
      total,
      uniqueUsers: uniqueActors.size,
      servicesCount: uniqueProviders.size,
    };
  }, [events, resolveActor]);

  // Export CSV
  const handleExportCsv = () => {
    if (!filteredEvents.length) return;
    const headers = ["User ID", "User Name", "Role", "Action", "Provider", "Details", "Timestamp", "Event ID"];
    const rows = filteredEvents.map((evt) => {
      const actor = resolveActor(evt);
      const metaStr =
        typeof evt.safe_metadata === "object"
          ? JSON.stringify(evt.safe_metadata).replace(/"/g, '""')
          : String(evt.safe_metadata || "").replace(/"/g, '""');
      return [
        `"${actor.userId}"`,
        `"${actor.name}"`,
        `"${actor.role}"`,
        `"${evt.event}"`,
        `"${evt.provider || ""}"`,
        `"${metaStr}"`,
        `"${evt.created_at || ""}"`,
        `"${evt.id || ""}"`,
      ].join(",");
    });

    const csvContent = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `security_audit_log_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="audit-view-container">
      {/* ── Hero / Header Banner ───────────────────────────────── */}
      <div className="audit-hero">
        <div className="audit-hero-info">
          <div className="audit-title-row">
            <h3 className="audit-title">Security & Connection Audit Log</h3>
            <span className="audit-status-tag">
              <span className="audit-status-dot" />
              Immutable Audit Trail
            </span>
          </div>
          <p className="audit-description">
            Append-only, tamper-evident record of all enterprise connection lifecycles, OAuth operations, and agent access events with verified user identity attribution.
          </p>
        </div>

        <div className="audit-hero-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportCsv}
            disabled={filteredEvents.length === 0}
            title="Export filtered audit logs as CSV"
          >
            <Download size={14} />
            Export CSV
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => loadAudit(true)}
            disabled={loading || refreshing}
          >
            <RefreshCw size={14} className={refreshing || loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── KPI Metric Cards ─────────────────────────────────────── */}
      <div className="audit-kpi-grid">
        <div className="audit-kpi-card">
          <div className="audit-kpi-icon-wrap">
            <Activity size={18} />
          </div>
          <div className="audit-kpi-body">
            <span className="audit-kpi-label">Total Audited Events</span>
            <span className="audit-kpi-value">{metrics.total}</span>
          </div>
        </div>

        <div className="audit-kpi-card">
          <div className="audit-kpi-icon-wrap">
            <User size={18} />
          </div>
          <div className="audit-kpi-body">
            <span className="audit-kpi-label">Active Users</span>
            <span className="audit-kpi-value">{metrics.uniqueUsers}</span>
          </div>
        </div>

        <div className="audit-kpi-card">
          <div className="audit-kpi-icon-wrap">
            <Cloud size={18} />
          </div>
          <div className="audit-kpi-body">
            <span className="audit-kpi-label">Integrated Services</span>
            <span className="audit-kpi-value">{metrics.servicesCount}</span>
          </div>
        </div>

        <div className="audit-kpi-card">
          <div className="audit-kpi-icon-wrap">
            <ShieldCheck size={18} />
          </div>
          <div className="audit-kpi-body">
            <span className="audit-kpi-label">Audit Scope</span>
            <span className="audit-kpi-value" style={{ fontSize: "0.95rem" }}>
              Enterprise Tenant
            </span>
          </div>
        </div>
      </div>

      {/* ── Search & Filter Toolbar ─────────────────────────────── */}
      <div className="audit-toolbar">
        <div className="audit-toolbar-left">
          <div className="audit-search-box">
            <Search size={14} className="audit-search-icon" />
            <input
              type="text"
              className="audit-search-input"
              placeholder="Search by User ID, action, service..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="audit-search-clear"
                onClick={() => setSearch("")}
                title="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <select
            className="audit-filter-select"
            value={eventFilter}
            onChange={(e) => setEventFilter(e.target.value)}
            aria-label="Filter by Event"
          >
            <option value="all">All Events</option>
            <option value="agent">Agent Access</option>
            <option value="connection">Connection Created</option>
            <option value="test">Verification / Tested</option>
            <option value="disconnect">Disconnected / Denied</option>
          </select>

          {distinctProviders.length > 0 && (
            <select
              className="audit-filter-select"
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              aria-label="Filter by Provider"
            >
              <option value="all">All Providers</option>
              {distinctProviders.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          )}

          {distinctUsers.length > 0 && (
            <select
              className="audit-filter-select"
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              aria-label="Filter by User"
            >
              <option value="all">All Users</option>
              {distinctUsers.map((u) => (
                <option key={u} value={u}>
                  User: {u}
                </option>
              ))}
            </select>
          )}

          {(search || eventFilter !== "all" || providerFilter !== "all" || userFilter !== "all") && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSearch("");
                setEventFilter("all");
                setProviderFilter("all");
                setUserFilter("all");
              }}
              style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
            >
              Reset Filters
            </Button>
          )}
        </div>

        <div className="audit-toolbar-right">
          <span className="audit-counter-badge">
            Showing <strong>{filteredEvents.length}</strong> of {events.length} events
          </span>
        </div>
      </div>

      {/* ── Main Audit Table ────────────────────────────────────── */}
      {loading && events.length === 0 ? (
        <div className="audit-empty-card">
          <RefreshCw size={32} className="animate-spin" style={{ color: "var(--primary)" }} />
          <p className="audit-empty-title">Loading security audit records...</p>
        </div>
      ) : events.length === 0 ? (
        <div className="audit-empty-card">
          <ShieldCheck className="audit-empty-icon" />
          <h4 className="audit-empty-title">No connection audit events recorded yet</h4>
          <p className="audit-empty-desc">
            All connection lifecycle activities and agent queries will be automatically captured here in real-time.
          </p>
        </div>
      ) : filteredEvents.length === 0 ? (
        <div className="audit-empty-card">
          <Search className="audit-empty-icon" />
          <h4 className="audit-empty-title">No audit records match your filters</h4>
          <p className="audit-empty-desc">
            Try adjusting your search terms or resetting the event and user filters.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setSearch("");
              setEventFilter("all");
              setProviderFilter("all");
              setUserFilter("all");
            }}
          >
            Reset Filters
          </Button>
        </div>
      ) : (
        <div className="audit-table-card">
          <div className="audit-table-scroll">
            <table className="audit-table">
              <thead>
                <tr>
                  {/* INITIAL COLUMN: USER ID */}
                  <th style={{ width: "240px" }}>User ID</th>
                  <th style={{ width: "190px" }}>Action</th>
                  <th style={{ width: "160px" }}>Service</th>
                  <th>Details</th>
                  <th style={{ width: "180px" }}>Timestamp</th>
                  <th style={{ width: "60px", textAlign: "center" }}>Inspect</th>
                </tr>
              </thead>
              <tbody>
                {filteredEvents.map((evt) => {
                  const actor = resolveActor(evt);
                  const eventInfo = formatEventInfo(evt.event);
                  const providerInfo = formatProvider(evt.provider);
                  const timeInfo = formatTimestamp(evt.created_at);
                  const roleClass = `audit-role-${actor.role.toLowerCase().replace(/\s+/g, "-")}`;

                  return (
                    <tr key={evt.id}>
                      {/* 1. INITIAL COLUMN: USER ID */}
                      <td>
                        <div className="audit-user-cell">
                          <div
                            className="audit-user-avatar"
                            style={{
                              background: actor.isSystem
                                ? "linear-gradient(135deg, #64748b, #334155)"
                                : getAvatarColor(actor.userId),
                            }}
                            title={actor.name}
                          >
                            {actor.isSystem ? <Bot size={16} /> : getInitials(actor.userId)}
                          </div>
                          <div className="audit-user-info">
                            <div className="audit-user-id-row">
                              <span className="audit-userid-badge" title={`User ID: ${actor.userId}`}>
                                {actor.userId}
                                {!actor.isSystem && (
                                  <button
                                    type="button"
                                    className="audit-copy-id-btn"
                                    onClick={() => handleCopy(actor.userId, `user-${evt.id}`)}
                                    title="Copy User ID"
                                  >
                                    {copiedKey === `user-${evt.id}` ? (
                                      <Check size={11} style={{ color: "#10b981" }} />
                                    ) : (
                                      <Copy size={11} />
                                    )}
                                  </button>
                                )}
                              </span>
                              <span className={`audit-role-badge ${roleClass}`}>
                                {actor.role}
                              </span>
                            </div>
                            {actor.name && actor.name.trim().toLowerCase() !== actor.userId.trim().toLowerCase() && (
                              <span className="audit-user-name" title={actor.name}>
                                {actor.name}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* 2. ACTION / EVENT */}
                      <td>
                        <span className={`audit-action-badge ${eventInfo.tone}`}>
                          {eventInfo.icon}
                          {eventInfo.label}
                        </span>
                      </td>

                      {/* 3. SERVICE / PROVIDER */}
                      <td>
                        <span className="audit-provider-badge">
                          <span className={`audit-provider-dot ${providerInfo.dotClass}`} />
                          {providerInfo.label}
                        </span>
                      </td>

                      {/* 4. DETAILS */}
                      <td>
                        <div className="audit-detail-wrapper">
                          {!evt.safe_metadata ||
                          (typeof evt.safe_metadata === "object" &&
                            Object.keys(evt.safe_metadata).length === 0) ||
                          evt.safe_metadata === "{}" ? (
                            <span className="audit-detail-default">
                              <Sparkles size={12} style={{ opacity: 0.6 }} />
                              Standard Agent Access
                            </span>
                          ) : typeof evt.safe_metadata === "object" ? (
                            <span className="audit-detail-pill" title={JSON.stringify(evt.safe_metadata)}>
                              {Object.entries(evt.safe_metadata)
                                .slice(0, 2)
                                .map(([k, v]) => `${k}: ${String(v)}`)
                                .join(" • ")}
                            </span>
                          ) : (
                            <span className="audit-detail-pill">{String(evt.safe_metadata)}</span>
                          )}
                        </div>
                      </td>

                      {/* 5. TIMESTAMP */}
                      <td>
                        <div className="audit-time-cell">
                          <span className="audit-time-main">
                            <Clock size={12} style={{ color: "var(--text-muted)" }} />
                            {timeInfo.date}
                          </span>
                          <span className="audit-time-sub">{timeInfo.time}</span>
                        </div>
                      </td>

                      {/* 6. INSPECT ACTION */}
                      <td style={{ textAlign: "center" }}>
                        <button
                          type="button"
                          className="audit-inspect-btn"
                          onClick={() => setSelectedEvent(evt)}
                          title="Inspect full audit event details"
                        >
                          <Eye size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Event Details Modal ─────────────────────────────────── */}
      {selectedEvent && (
        <div className="audit-modal-backdrop" onClick={() => setSelectedEvent(null)}>
          <div className="audit-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="audit-modal-header">
              <h4 className="audit-modal-title">
                <Shield size={18} style={{ color: "var(--primary)" }} />
                Audit Event Record
              </h4>
              <button
                type="button"
                className="audit-modal-close-btn"
                onClick={() => setSelectedEvent(null)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="audit-modal-body">
              {/* Actor Breakdown */}
              <div className="audit-modal-section">
                <h5 className="audit-modal-section-title">Attributed Actor</h5>
                {(() => {
                  const actor = resolveActor(selectedEvent);
                  return (
                    <div className="audit-modal-props-grid">
                      <div className="audit-modal-prop-item">
                        <span className="audit-modal-prop-label">User ID (Username)</span>
                        <span className="audit-modal-prop-val" style={{ fontFamily: "var(--font-mono)" }}>
                          {actor.userId}
                        </span>
                      </div>
                      {actor.name && actor.name.trim().toLowerCase() !== actor.userId.trim().toLowerCase() && (
                        <div className="audit-modal-prop-item">
                          <span className="audit-modal-prop-label">User Display Name</span>
                          <span className="audit-modal-prop-val">{actor.name}</span>
                        </div>
                      )}
                      <div className="audit-modal-prop-item">
                        <span className="audit-modal-prop-label">Assigned Role</span>
                        <span className="audit-modal-prop-val">{actor.role}</span>
                      </div>
                      <div className="audit-modal-prop-item">
                        <span className="audit-modal-prop-label">Raw Internal Actor ID</span>
                        <span
                          className="audit-modal-prop-val"
                          style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}
                        >
                          {actor.rawId}
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Event Metadata */}
              <div className="audit-modal-section">
                <h5 className="audit-modal-section-title">Execution Context</h5>
                <div className="audit-modal-props-grid">
                  <div className="audit-modal-prop-item">
                    <span className="audit-modal-prop-label">Event Type</span>
                    <span className="audit-modal-prop-val">{selectedEvent.event}</span>
                  </div>
                  <div className="audit-modal-prop-item">
                    <span className="audit-modal-prop-label">Target Service</span>
                    <span className="audit-modal-prop-val">
                      {formatProvider(selectedEvent.provider).label}
                    </span>
                  </div>
                  <div className="audit-modal-prop-item">
                    <span className="audit-modal-prop-label">Timestamp</span>
                    <span className="audit-modal-prop-val">
                      {selectedEvent.created_at ? new Date(selectedEvent.created_at).toLocaleString() : "—"}
                    </span>
                  </div>
                  <div className="audit-modal-prop-item">
                    <span className="audit-modal-prop-label">Origin IP</span>
                    <span className="audit-modal-prop-val" style={{ fontFamily: "var(--font-mono)" }}>
                      {selectedEvent.ip || "Internal Gateway"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Safe Metadata JSON */}
              <div className="audit-modal-section">
                <h5 className="audit-modal-section-title">Redacted Safe Metadata</h5>
                <div className="audit-modal-json-block">
                  <button
                    type="button"
                    className="audit-modal-copy-json"
                    onClick={() =>
                      handleCopy(
                        JSON.stringify(selectedEvent.safe_metadata || {}, null, 2),
                        "json-copy"
                      )
                    }
                  >
                    {copiedKey === "json-copy" ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === "json-copy" ? "Copied" : "Copy JSON"}
                  </button>
                  <pre style={{ margin: 0 }}>
                    {JSON.stringify(selectedEvent.safe_metadata || {}, null, 2)}
                  </pre>
                </div>
              </div>
            </div>

            <div className="audit-modal-footer">
              <Button variant="secondary" size="sm" onClick={() => setSelectedEvent(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
