"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowRight, KeyRound } from "lucide-react";

export default function SetPasswordPage() {
  const router = useRouter();
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function prepareRecoverySession() {
      if (new URLSearchParams(window.location.search).has("error")) {
        setError(true);
        setMessage("This link has expired or is invalid. Ask an administrator to send a new one.");
        setReady(true);
        return;
      }

      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key) {
        setError(true);
        setMessage("Password setup is temporarily unavailable. Contact an administrator.");
        setReady(true);
        return;
      }

      const supabase = createBrowserClient(url, key, {
        auth: { detectSessionInUrl: false },
      });
      supabaseRef.current = supabase;

      // Some Supabase recovery links return a PKCE code handled by the server
      // callback; others return the verified session in the URL fragment.
      // The fragment is never sent to the server, so establish that session in
      // the browser before the password form can submit.
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const accessToken = fragment.get("access_token");
      const refreshToken = fragment.get("refresh_token");
      const flowType = fragment.get("type");

      if (accessToken && refreshToken && flowType === "recovery") {
        window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
        const { error: sessionError } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        if (!mounted) return;
        if (sessionError) {
          setError(true);
          setMessage("This setup link has expired or was already used. Ask an administrator to send a new one.");
        } else {
          setMessage("Recovery link verified. Choose a new password.");
        }
        setReady(true);
        return;
      }

      const { data, error: sessionError } = await supabase.auth.getSession();
      if (!mounted) return;
      if (sessionError || !data.session) {
        setError(true);
        setMessage("This setup link is no longer valid. Ask an administrator to send a new one.");
      } else {
        setMessage("Recovery link verified. Choose a new password.");
      }
      setReady(true);
    }

    void prepareRecoverySession();
    return () => { mounted = false; };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    const confirmation = String(values.get("confirmation") ?? "");
    if (password !== confirmation) { setError(true); setMessage("The passwords do not match."); return; }

    setBusy(true); setError(false); setMessage("");
    try {
      const supabase = supabaseRef.current;
      if (!supabase) throw new Error("The recovery session could not be loaded. Open the newest setup email again.");
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !data.session) throw new Error("This setup link is no longer valid. Ask an administrator to send a new one.");
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw new Error("The password could not be saved. Use at least 4 characters and try again.");
      await supabase.auth.signOut();
      setMessage("Your password is ready. Opening the sign-in page…");
      window.setTimeout(() => router.push("/"), 700);
    } catch (cause) {
      setError(true);
      setMessage(cause instanceof Error ? cause.message : "The password could not be saved.");
    } finally { setBusy(false); }
  };

  return <main className="password-screen"><section className="password-card"><div className="password-brand"><span className="brand-mark password-logo" role="img" aria-label="Imam Ali Center logo" style={{ backgroundImage: "url('/iac-media-logo.png')", backgroundPosition: "center", backgroundSize: "cover" }} /><span><strong>Media Operations</strong><small>IMAM ALI CENTER</small></span></div><span className="password-icon"><KeyRound size={22} /></span><h1>Set your password</h1><p>Choose a password for your media team account. Use at least 4 characters.</p><form onSubmit={submit} className="password-form"><label><span>New password</span><input name="password" type="password" minLength={4} maxLength={128} autoComplete="new-password" required disabled={!ready || error || busy} /></label><label><span>Confirm password</span><input name="confirmation" type="password" minLength={4} maxLength={128} autoComplete="new-password" required disabled={!ready || error || busy} /></label>{(!ready || message) && <div role="status" className={"password-message " + (error ? "is-error" : "")}>{!ready ? "Verifying your setup link…" : message}</div>}<button className="button button-primary full-button" disabled={!ready || error || busy}>{busy ? "Saving…" : "Save password"}<ArrowRight size={15} /></button></form><Link className="password-back-link" href="/">Return to sign in</Link></section></main>;
}
