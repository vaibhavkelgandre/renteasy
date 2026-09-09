/**
 * Session state.
 *
 * WHERE THE TOKEN IS: nowhere in here. It lives in an httpOnly cookie the browser
 * sends automatically, so JavaScript cannot read it — which means an XSS bug anywhere
 * in this app cannot steal a session.
 *
 * Note `register` does NOT set a user. The API answers 202 and issues no session,
 * because at that moment nobody has proved the address belongs to them. See
 * docs/features/01-public-registration.md §3.2.
 */

import { createContext, useContext, useEffect, useState } from "react";
import { api } from "../lib/api.js";

const AuthContext = createContext(null);

/**
 * @param {{ children: React.ReactNode }} props
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  // Starts true. On a hard refresh we genuinely do not know whether there is a session
  // until /auth/me answers, and guessing "signed out" would bounce an authenticated
  // visitor to the sign-in page and back — visibly.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    api
      .get("/auth/me")
      // A 401 is the ordinary "not signed in" answer on a public marketplace, where
      // most visitors have no account. Not an error worth showing anyone.
      .then((data) => !cancelled && setUser(data.user))
      .catch(() => !cancelled && setUser(null))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Creates an account.
   *
   * @param {object} input
   * @returns {Promise<void>} Nothing. The API deliberately returns no user — see §3.1:
   *          it will not disclose whether an account was created, so there is nothing
   *          for this function to hand back.
   * @throws {ApiError} 400 with field errors, 409 for stale terms, 429 if rate limited.
   */
  async function register(input) {
    await api.post("/auth/register", input);
  }

  /**
   * Signs in.
   *
   * @param {{ email: string, password: string }} credentials
   * @returns {Promise<object>} The signed-in user, verified or not.
   * @throws {ApiError} 401. Deliberately not caught — the form needs the message.
   */
  async function login(credentials) {
    const data = await api.post("/auth/login", credentials);
    setUser(data.user);
    return data.user;
  }

  /**
   * Signs out.
   *
   * @returns {Promise<void>}
   * @throws Never. The local session clears even if the request fails: if the server
   *         is unreachable the user still expects "sign out" to sign them out, and
   *         leaving them apparently signed in with a dead session is worse.
   */
  async function logout() {
    try {
      await api.post("/auth/logout");
    } finally {
      setUser(null);
    }
  }

  /**
   * Re-reads the session from the server.
   *
   * Needed after verification: `/auth/me` reports verification state fresh from the
   * database on every request, so confirming an email takes effect immediately — but
   * only once this app asks again.
   *
   * @returns {Promise<void>}
   */
  async function refresh() {
    try {
      const data = await api.get("/auth/me");
      setUser(data.user);
    } catch {
      setUser(null);
    }
  }

  const value = {
    user,
    loading,
    register,
    login,
    logout,
    refresh,
    // Derived rather than stored. The gate that matters throughout the product: an
    // unverified user can browse and sign in, but cannot list, book or negotiate.
    isVerified: Boolean(user?.email_verified_at),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * @returns {{ user: object|null, loading: boolean, isVerified: boolean, register: Function, login: Function, logout: Function, refresh: Function }}
 * @throws {Error} If used outside AuthProvider — a loud failure in development rather
 *         than a confusing `undefined` destructure three components away.
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an AuthProvider");
  return context;
}
