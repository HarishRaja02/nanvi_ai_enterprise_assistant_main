import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Calendar,
  Check,
  ClipboardList,
  Copy,
  Download,
  Eye,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import type { LocalAccount, NanviApiClient, UserLogEntry } from "../../api";
import { MarkdownContent } from "../../components/chat/MarkdownContent";
import "./UserLogsPage.css";

type Props = {
  api: NanviApiClient;
  onReturn?: () => void;
};

export function UserLogsPage({ api }: Props) {
  const [dates, setDates] = useState<string[]>([]);
  const [todayDate, setTodayDate] = useState<string>("");
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [logs, setLogs] = useState<UserLogEntry[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [search, setSearch] = useState<string>("");
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");
  const [userFilter, setUserFilter] = useState<string>("all");
  const [selectedLog, setSelectedLog] = useState<UserLogEntry | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accountsMap, setAccountsMap] = useState<Map<string, LocalAccount>>(new Map());

  // Debounce search input to avoid spamming the backend on each keystroke
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Load account mappings to resolve any numeric/UUID account IDs into clean User IDs
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
          // Non-blocking: continue with log entries as received
        });
    }
    return () => {
      active = false;
    };
  }, [api]);

  // Resolve user info from log + accounts mapping
  const resolveUser = useCallback(
    (log: UserLogEntry) => {
      const rawId = (log.user_id || "").trim();
      const rawName = (log.user_name || "").trim();
      const matched =
        accountsMap.get(rawId) ||
        accountsMap.get(rawId.toLowerCase()) ||
        accountsMap.get(rawName.toLowerCase());

      let userId = matched?.username || rawId;

      // If userId is numeric (e.g. "1", "2") or an internal number sequence, replace with clean User ID
      if (!userId || /^\d+$/.test(userId)) {
        if (rawName && !/^\d+$/.test(rawName)) {
          userId = rawName.toLowerCase().replace(/\s+/g, ".");
        } else if (matched?.email) {
          userId = matched.email.split("@")[0];
        } else {
          userId = rawName || `user_${userId || "01"}`;
        }
      }

      const name = matched?.display_name || (rawName && !/^\d+$/.test(rawName) ? rawName : userId);
      const role = matched?.role || log.user_role || "Employee";

      return { userId, name, role };
    },
    [accountsMap]
  );

  // 1. Fetch available dates partitioned by day
  const fetchDates = useCallback(async () => {
    try {
      const res = await api.getUserLogDates();
      setDates(res.dates || []);
      setTodayDate(res.today || "");
      setSelectedDate((curr) => {
        if (curr) return curr;
        if (res.today) return res.today;
        if (res.dates && res.dates.length > 0) return res.dates[0];
        return "";
      });
    } catch (err: any) {
      console.warn("Could not load log dates:", err);
      const now = new Date();
      const dd = String(now.getUTCDate()).padStart(2, "0");
      const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
      const yyyy = now.getUTCFullYear();
      const fallbackToday = `${dd}-${mm}-${yyyy}`;
      setDates([fallbackToday]);
      setTodayDate(fallbackToday);
      setSelectedDate((curr) => curr || fallbackToday);
    }
  }, [api]);

  // 2. Fetch logs matching current date, search, and user filter
  const fetchLogs = useCallback(
    async (showRefreshSpinner = false) => {
      if (showRefreshSpinner) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        const res = await api.getUserLogs({
          date: selectedDate || undefined,
          search: debouncedSearch.trim() || undefined,
          user_id: userFilter !== "all" ? userFilter : undefined,
          limit: 200,
        });
        setLogs(res.logs || []);
        setTotalCount(res.total ?? (res.logs ? res.logs.length : 0));
      } catch (err: any) {
        setError(err.message || "Failed to load logs. Ensure your Supabase user_query_logs table is configured.");
        setLogs([]);
        setTotalCount(0);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [api, selectedDate, debouncedSearch, userFilter]
  );

  // Initial load
  useEffect(() => {
    fetchDates();
  }, [fetchDates]);

  useEffect(() => {
    if (selectedDate) {
      fetchLogs();
    }
  }, [selectedDate, debouncedSearch, userFilter, fetchLogs]);

  // Escape key closes modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedLog(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Compute unique users for quick filter
  const uniqueUsers = useMemo(() => {
    const map = new Map<string, string>();
    logs.forEach((l) => {
      const u = resolveUser(l);
      if (u.userId && !map.has(u.userId)) {
        map.set(u.userId, u.name || u.userId);
      }
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [logs, resolveUser]);

  // Copy helper
  const handleCopy = (id: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Export CSV
  const handleExportCSV = () => {
    if (!logs.length) return;
    const headers = ["ID", "User ID", "User Name", "Role", "Date", "Time", "Query", "Answer", "Capability", "Model"];
    const rows = logs.map((l) => {
      const u = resolveUser(l);
      return [
        l.id,
        u.userId,
        u.name,
        u.role,
        l.log_date,
        formatTime(l.created_at),
        `"${(l.query || "").replace(/"/g, '""')}"`,
        `"${(l.answer || "").replace(/"/g, '""')}"`,
        l.capability || "",
        l.model || "",
      ];
    });
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map((e) => e.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `nanvi_user_logs_${selectedDate || "all"}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  function formatDateDisplay(dStr: string) {
    return dStr || "";
  }

  function formatTime(isoStr: string) {
    if (!isoStr) return "";
    try {
      const d = new Date(isoStr);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return isoStr;
    }
  }

  function getRoleBadgeClass(role: string) {
    const r = (role || "").toLowerCase();
    if (r.includes("superior") || r.includes("ceo")) return "role-superior-badge";
    if (r.includes("admin")) return "role-admin-badge";
    if (r.includes("supervisor")) return "role-supervisor-badge";
    return "role-employee-badge";
  }

  function getInitials(name: string) {
    if (!name) return "U";
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  return (
    <div className="user-logs-page" data-testid="user-logs-page">
      {/* 1. Header Banner */}
      <section className="logs-hero-banner" aria-label="Logs Overview">
        <div className="logs-hero-top">
          <h1 className="logs-hero-title">
            <ClipboardList size={22} className="text-primary" />
            User Activity & Query Logs
          </h1>
          <span className="logs-role-tag">
            <Sparkles size={13} />
            Superior & Admin Console
          </span>
        </div>
        <p className="logs-hero-subtitle">
          Full audit trail of all enterprise employee queries and system-generated answers. Partitioned and split by day.
        </p>
      </section>

      {/* 2. Quick Metrics */}
      <section className="logs-stats-grid" aria-label="Statistics">
        <div className="logs-stat-card">
          <span className="logs-stat-label">Total Queries</span>
          <span className="logs-stat-value">{totalCount}</span>
        </div>
        <div className="logs-stat-card">
          <span className="logs-stat-label">Active Users</span>
          <span className="logs-stat-value">{uniqueUsers.length}</span>
        </div>
        <div className="logs-stat-card">
          <span className="logs-stat-label">Active Date Partition</span>
          <span className="logs-stat-value" style={{ fontSize: "16px" }}>
            {selectedDate === "all" ? "All Dates" : selectedDate === todayDate ? `${selectedDate} (Today)` : selectedDate || "Today"}
          </span>
        </div>
      </section>

      {/* 3. Filter Toolbar */}
      <section className="logs-toolbar" aria-label="Log Filters">
        <div className="logs-toolbar-left">
          {/* Dynamic Daily Dropdown Selector */}
          <div className="logs-date-picker-group">
            <label htmlFor="logs-date-select" className="logs-label">
              <Calendar size={15} style={{ display: "inline", verticalAlign: "text-bottom", marginRight: 4 }} />
              Date:
            </label>
            <select
              id="logs-date-select"
              data-testid="logs-date-select"
              className="logs-select"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            >
              {dates.map((d) => (
                <option key={d} value={d}>
                  {d === todayDate ? `${d} (Today)` : d}
                </option>
              ))}
              <option value="all">All Dates</option>
            </select>
          </div>

          {/* User Filter Dropdown */}
          {uniqueUsers.length > 0 && (
            <div className="logs-date-picker-group">
              <label htmlFor="logs-user-select" className="logs-label">
                <Users size={15} style={{ display: "inline", verticalAlign: "text-bottom", marginRight: 4 }} />
                User:
              </label>
              <select
                id="logs-user-select"
                className="logs-select"
                value={userFilter}
                onChange={(e) => setUserFilter(e.target.value)}
              >
                <option value="all">All Users</option>
                {uniqueUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.id})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Search Box */}
          <div className="logs-search-wrapper">
            <Search size={15} className="logs-search-icon" />
            <input
              type="text"
              className="logs-search-input"
              placeholder="Search user ID, query, or answer…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="logs-search-clear-btn"
                onClick={() => setSearch("")}
                aria-label="Clear search input"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="logs-toolbar-actions">
          <button
            type="button"
            className="logs-btn"
            onClick={() => void fetchLogs(true)}
            disabled={refreshing || loading}
            title="Refresh logs"
          >
            <RefreshCw size={14} className={refreshing ? "spin-animate" : ""} />
            Refresh
          </button>
          <button
            type="button"
            className="logs-btn logs-btn-primary"
            onClick={handleExportCSV}
            disabled={logs.length === 0}
            title="Download CSV"
          >
            <Download size={14} />
            Export CSV
          </button>
        </div>
      </section>

      {/* Error Notice */}
      {error && (
        <div className="logs-error-notice" role="alert">
          <ShieldAlert size={18} />
          <span>{error}</span>
        </div>
      )}

      {/* 4. Logs Table Card */}
      <section className="logs-table-card" aria-label="Log Entries">
        {loading ? (
          <div className="logs-empty">
            <RefreshCw size={28} className="spin-animate text-primary" />
            <h3>Loading query logs…</h3>
            <p>Retrieving interaction logs for {selectedDate}.</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="logs-empty" data-testid="logs-empty-state">
            <ClipboardList size={36} />
            <h3>No query logs recorded</h3>
            <p>
              {selectedDate === "all"
                ? "No user queries have been logged yet."
                : `No user queries logged for ${selectedDate}. New queries sent by employees will automatically appear here.`}
            </p>
          </div>
        ) : (
          <div className="logs-table-wrapper">
            <table className="logs-table" aria-label="User activity log table">
              <thead>
                <tr>
                  <th style={{ width: "18%" }}>User ID</th>
                  <th style={{ width: "14%" }}>Date &amp; Time</th>
                  <th style={{ width: "32%" }}>User Query</th>
                  <th style={{ width: "28%" }}>System Generated Answer</th>
                  <th style={{ width: "8%", textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const user = resolveUser(log);
                  return (
                    <tr key={log.id} data-testid={`log-row-${log.id}`}>
                      {/* 1. User ID Column */}
                      <td className="logs-user-cell">
                        <div className="logs-user-inner">
                          <div className="logs-user-avatar-wrap">
                            <span className="logs-user-avatar" aria-hidden="true">
                              {getInitials(user.name)}
                            </span>
                          </div>
                          <div className="logs-user-details">
                            <div className="logs-user-id-row">
                              <span className="logs-user-id" title={user.userId}>
                                {user.userId}
                              </span>
                            </div>
                            {user.name && user.name.trim().toLowerCase() !== user.userId.trim().toLowerCase() && (
                              <span className="logs-user-name" title={user.name}>
                                {user.name}
                              </span>
                            )}
                            <span className={`logs-role-badge ${getRoleBadgeClass(user.role)}`}>
                              {user.role}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* 2. Date & Time Column */}
                      <td className="logs-date-cell">
                        <div className="logs-date-inner">
                          <span className="logs-date-primary">{formatDateDisplay(log.log_date)}</span>
                          <span className="logs-date-time">{formatTime(log.created_at)}</span>
                        </div>
                      </td>

                      {/* 3. Query Column */}
                      <td className="logs-query-cell">
                        <div
                          className="logs-query-box"
                          title="Click to inspect full prompt"
                          onClick={() => setSelectedLog(log)}
                        >
                          <div className="logs-query-text">{log.query}</div>
                        </div>
                      </td>

                      {/* 4. Answer Column */}
                      <td className="logs-answer-cell">
                        <div
                          className="logs-answer-box"
                          title="Click to inspect full answer"
                          onClick={() => setSelectedLog(log)}
                        >
                          <div className="logs-answer-text">{log.answer}</div>
                        </div>
                      </td>

                      {/* 5. Actions Column */}
                      <td className="logs-actions-cell">
                        <div className="logs-actions-inner">
                          <button
                            type="button"
                            className="logs-btn logs-action-icon-btn"
                            onClick={() => handleCopy(log.id, log.answer)}
                            title="Copy Answer"
                            aria-label="Copy Answer"
                          >
                            {copiedId === log.id ? <Check size={14} color="#16a34a" /> : <Copy size={14} />}
                          </button>
                          <button
                            type="button"
                            className="logs-btn logs-action-icon-btn"
                            onClick={() => setSelectedLog(log)}
                            title="Inspect Details"
                            aria-label="Inspect Details"
                          >
                            <Eye size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 5. Detail Modal */}
      {selectedLog && (() => {
        const u = resolveUser(selectedLog);
        return (
          <div className="logs-modal-overlay" onClick={() => setSelectedLog(null)} aria-modal="true" role="dialog">
            <div className="logs-modal-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="logs-modal-header">
                <h2 className="logs-modal-title">Turn Inspection Details</h2>
                <button
                  type="button"
                  className="logs-btn logs-action-icon-btn"
                  onClick={() => setSelectedLog(null)}
                  aria-label="Close dialog"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="logs-modal-body">
                {/* User info row */}
                <div className="logs-modal-meta-row">
                  <div>
                    <strong className="logs-meta-label">User ID: </strong>
                    <code className="logs-meta-code">{u.userId}</code>
                  </div>
                  {u.name && u.name.trim().toLowerCase() !== u.userId.trim().toLowerCase() && (
                    <div>
                      <strong className="logs-meta-label">Name: </strong>
                      <span>{u.name}</span>
                    </div>
                  )}
                  <div>
                    <strong className="logs-meta-label">Role: </strong>
                    <span className={`logs-role-badge ${getRoleBadgeClass(u.role)}`}>
                      {u.role}
                    </span>
                  </div>
                  <div>
                    <strong className="logs-meta-label">Date: </strong>
                    <span>{selectedLog.log_date} ({formatTime(selectedLog.created_at)})</span>
                  </div>
                </div>

                {/* Query Field */}
                <div className="logs-modal-field">
                  <div className="logs-modal-field-title">
                    <span>User Query / Prompt</span>
                    <button
                      type="button"
                      className="logs-btn logs-modal-copy-btn"
                      onClick={() => handleCopy(`q-${selectedLog.id}`, selectedLog.query)}
                    >
                      {copiedId === `q-${selectedLog.id}` ? <Check size={11} color="#16a34a" /> : <Copy size={11} />}
                      Copy Prompt
                    </button>
                  </div>
                  <div className="logs-modal-field-box">{selectedLog.query}</div>
                </div>

                {/* Answer Field */}
                <div className="logs-modal-field">
                  <div className="logs-modal-field-title">
                    <span>System Generated Answer</span>
                    <button
                      type="button"
                      className="logs-btn logs-modal-copy-btn"
                      onClick={() => handleCopy(`a-${selectedLog.id}`, selectedLog.answer)}
                    >
                      {copiedId === `a-${selectedLog.id}` ? <Check size={11} color="#16a34a" /> : <Copy size={11} />}
                      Copy Answer
                    </button>
                  </div>
                  <div className="logs-modal-field-box">{selectedLog.answer}</div>
                  <div className="logs-modal-field-box logs-markdown-wrap">
                    <MarkdownContent text={selectedLog.answer} />
                  </div>
                </div>

                {/* Metadata */}
                {(selectedLog.capability || selectedLog.model) && (
                  <div className="logs-modal-extra-meta">
                    {selectedLog.capability && <div>Capability: <code>{selectedLog.capability}</code></div>}
                    {selectedLog.model && <div>Model: <code>{selectedLog.model}</code></div>}
                  </div>
                )}
              </div>

              <div className="logs-modal-footer">
                <button
                  type="button"
                  className="logs-btn logs-btn-primary"
                  onClick={() => setSelectedLog(null)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
