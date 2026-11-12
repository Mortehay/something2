import { useCallback, useEffect, useState } from "react";
import styled from "styled-components";
import { useAuth } from "../context/AuthContext";
import { t } from "../games/something2/src/js/i18n/i18n.js";
import { setEmail, resendVerification } from "../games/something2/src/js/net/accountApi.js";
import { errorText } from "../pages/loginModel";
import { Screen, Card, Title, Field, Submit, Toggle, ErrorText, Notice, OkText } from "../pages/authCard";

const RESEND_COOLDOWN_SEC = 60;

// Covers the whole viewport; RequireAuth renders this INSTEAD of the app.
const Overlay = styled(Screen)`
  position: fixed;
  inset: 0;
  z-index: 10000;
`;

// Blocking email popups: step "add" (no email on the account) and step "verify"
// (email set, link not clicked yet). Re-reads /me when the tab regains focus so
// verifying in another tab/mail app lifts the gate without a reload; the
// refresh itself is throttled in AuthContext.
function EmailGate({ step }) {
  const { account, refreshAccount, signOut } = useAuth();
  const [changing, setChanging] = useState(false);
  const [locked, setLocked] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    const onFocus = () => { refreshAccount(); };
    globalThis.addEventListener("focus", onFocus);
    return () => globalThis.removeEventListener("focus", onFocus);
  }, [refreshAccount]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const save = useCallback(async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await setEmail(value.trim());
      setChanging(false);
      setValue("");
      setSent(false);
      setCooldown(RESEND_COOLDOWN_SEC);   // the server just mailed a link
      await refreshAccount({ force: true });
    } catch (err) {
      if (err.code === "email_locked") { setLocked(true); setChanging(false); }
      setError(errorText(err.code, err.retryAfterSec));
    } finally {
      setBusy(false);
    }
  }, [busy, value, refreshAccount]);

  const resend = useCallback(async () => {
    if (busy || cooldown > 0) return;
    setBusy(true);
    setError("");
    setSent(false);
    try {
      await resendVerification();
      setSent(true);
      setCooldown(RESEND_COOLDOWN_SEC);
    } catch (err) {
      if (err.code === "resend_cooldown" && err.retryAfterSec) setCooldown(Math.ceil(err.retryAfterSec));
      setError(errorText(err.code, err.retryAfterSec));
    } finally {
      setBusy(false);
    }
  }, [busy, cooldown]);

  const showAdd = step === "add" || changing;

  return (
    <Overlay role="dialog" aria-modal="true" aria-labelledby="email-gate-title">
      {showAdd ? (
        <Card onSubmit={save}>
          <Title id="email-gate-title">{t("Add your email")}</Title>
          <Notice>{t("We need a verified email on your account before you can play.")}</Notice>
          <Field
            type="email"
            autoComplete="email"
            placeholder={t("Email")}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
            autoFocus
          />
          {error && <ErrorText>{error}</ErrorText>}
          <Submit type="submit" disabled={busy || !value.trim()}>{t("Save")}</Submit>
          {changing && (
            <Toggle type="button" onClick={() => { setChanging(false); setError(""); }}>{t("Cancel")}</Toggle>
          )}
          <Toggle type="button" onClick={signOut}>{t("Log out")}</Toggle>
        </Card>
      ) : (
        <Card as="div">
          <Title id="email-gate-title">{t("Verify your email")}</Title>
          <Notice>{t("Check your inbox — we sent a link to {email}.", { email: account?.email ?? "" })}</Notice>
          <Notice>{t("Can't find it? Check your spam folder. The link works for 24 hours.")}</Notice>
          {sent && <OkText>{t("Email sent")}</OkText>}
          {error && <ErrorText>{error}</ErrorText>}
          <Submit type="button" onClick={resend} disabled={busy || cooldown > 0}>
            {cooldown > 0 ? t("Resend in {seconds}s", { seconds: cooldown }) : t("Resend")}
          </Submit>
          {!locked && !account?.emailLocked && (
            <Toggle type="button" onClick={() => { setChanging(true); setError(""); setSent(false); }}>
              {t("Change email")}
            </Toggle>
          )}
          <Toggle type="button" onClick={signOut}>{t("Log out")}</Toggle>
        </Card>
      )}
    </Overlay>
  );
}

export default EmailGate;
